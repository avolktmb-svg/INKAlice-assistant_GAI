import { randomUUID } from "node:crypto";
import { command, dateInZone, hash, publicError, reply, sameSecret, WAIT_TEXT } from "./common.js";

const POLL = new Set(["чек", "чэк", "check"]);
const SOURCES = new Set(["источники", "покажи источники", "назови источники", "какие источники", "откуда информация", "откуда ты это знаешь"]);
const RESET = new Set(["забудь разговор", "очисти историю", "новый разговор"]);
const REPEAT = new Set(["повтори", "повтори ответ"]);
const EXIT = new Set(["выход", "выйти", "закончи навык"]);
const HELP = "Задай любой вопрос. «Чек» — получить готовый ответ после ожидания. «Повтори» — повторить последний ответ. «Источники» — узнать, откуда сведения. «Забудь разговор» — удалить историю и отменить запрос. «Выход» — закончить диалог. «Справка» — повторить список команд.";
const EXPIRED = "Предыдущий запрос не завершился вовремя. Задай вопрос ещё раз.";
const emptyState = () => ({ history: [], job: null, seen: [] });

function jobResponse(job) {
  return job.status === "done" ? reply(job.answer) :
    job.status === "failed" ? reply(job.answer || EXPIRED) : reply(WAIT_TEXT);
}

export function createApp({ config, store, providers, defer, now = Date.now, foregroundMs = 2600 }) {
  async function work(key, job, history) {
    let result;
    let failed = false;
    try {
      const count = await store.count(`daily:${key}:${dateInZone(new Date(now()), config.timezone)}`);
      if (count > config.dailyLimit) {
        failed = true;
        result = { text: "На сегодня достигнут установленный лимит вопросов. Продолжим завтра.", sources: [] };
      } else {
        result = await providers.run(job.question, history, AbortSignal.timeout(45000));
      }
    } catch (error) {
      failed = true;
      result = { text: publicError(error), sources: [] };
    }
    try {
      // Reset / новое задание не может быть перезаписано запоздалым результатом.
      const saved = await store.update(key, state => {
        if (state?.job?.id !== job.id || state.job.status !== "pending") return { write: false, result: false };
        state.job = {
          ...state.job, status: failed ? "failed" : "done",
          answer: result.text, sources: result.sources || [],
          searchedAt: result.searchedAt || "", query: result.query || ""
        };
        if (!failed) {
          state.history = [...state.history,
            { role: "user", text: job.question },
            { role: "model", text: result.text }
          ].slice(-12);
        }
        return { write: true, value: state, result: true };
      });
      return saved ? reply(result.text) : reply("Этот запрос отменён. Можно начать новый разговор.");
    } catch {
      // Безопасный код без ключей, текста вопросов и содержимого внешних ответов.
      console.warn("BACKGROUND_STORAGE_FAILED");
      return reply("Ответ не удалось сохранить. Попробуй задать вопрос ещё раз.");
    }
  }

  async function route(body, signal) {
    const session = body.session;
    if (!session || session.skill_id !== config.skillId ||
        typeof session.session_id !== "string" || session.session_id.length > 200 ||
        !Number.isInteger(session.message_id) || session.message_id < 0) {
      return { status: 400, body: { error: "Invalid Alice request" } };
    }
    const userId = session.user?.user_id;
    const applicationId = session.application?.application_id;
    const actor = userId || applicationId;
    if (typeof actor !== "string" || actor.length > 256) {
      return { status: 400, body: { error: "Missing identity" } };
    }
    if (config.allowed.length && !config.allowed.includes(userId) && !config.allowed.includes(applicationId)) {
      return { status: 403, body: { error: "Access denied" } };
    }
    const key = `conversation:${hash(`${config.skillId}:${actor}`)}`;
    const text = String(body.request?.command || body.request?.original_utterance || "").trim();
    const cmd = command(text);
    if (text.length > 2000) return { status: 200, body: reply("Слишком длинный вопрос. Сформулируй его короче.") };
    if (session.new || !text) return { status: 200, body: reply("Привет! Задай вопрос. Команды — «справка».") };
    if (["справка", "помощь", "что ты умеешь"].includes(cmd)) return { status: 200, body: reply(HELP) };
    if (EXIT.has(cmd)) return { status: 200, body: reply("До встречи!", [], true) };

    const requestId = hash(`${session.session_id}:${session.message_id}`);
    const jobId = randomUUID();
    const outcome = await store.update(key, stored => {
      const state = stored || emptyState();
      if (RESET.has(cmd)) {
        if (state.resetId === requestId) return { write: false, result: { body: reply("История уже удалена.") } };
        return { write: true, value: { ...emptyState(), resetId: requestId },
          result: { body: reply("История удалена, незавершённый ответ отменён. О чём поговорим?") } };
      }
      let dirty = false;
      if (state.job?.status === "pending" && now() - state.job.startedAt > 65000) {
        state.job.status = "failed";
        state.job.answer = EXPIRED;
        dirty = true;
      }
      const read = body => ({ write: dirty, value: state, result: { body } });
      if (SOURCES.has(cmd)) {
        if (state.job?.status === "pending") return read(reply("Ответ ещё готовится. Через несколько секунд скажи «чек», затем «источники»."));
        const sources = state.job?.sources || [];
        const description = sources.map((s, i) =>
          `${i + 1}. ${s.publisher || s.host}${s.date ? `, дата в выдаче: ${s.date}` : ", дата публикации не указана"}`).join(". ");
        return read(reply(sources.length ? `В последнем ответе использованы: ${description}.` :
          "Для последнего ответа нет сохранённых источников.", sources));
      }
      if (POLL.has(cmd) || REPEAT.has(cmd)) {
        return read(state.job ? jobResponse(state.job) : reply("Пока нет подготовленного ответа. Задай вопрос."));
      }
      // Повторная доставка того же message_id не вызывает модель повторно.
      if (state.seen.includes(requestId)) {
        return read(state.job?.requestId === requestId ? jobResponse(state.job) :
          reply("Этот вопрос уже обработан. Скажи «повтори» для последнего ответа."));
      }
      if (state.job?.status === "pending") {
        return read(reply("Я ещё готовлю предыдущий ответ. Скажи «чек», или «забудь разговор», чтобы начать заново."));
      }
      const job = { id: jobId, requestId, question: text, startedAt: now(), status: "pending" };
      state.job = job;
      state.seen = [...state.seen, requestId].slice(-20);
      return { write: true, value: state, result: { job, key, history: state.history } };
    }, signal);

    if (!outcome.job) return { status: 200, body: outcome.body };
    // defer должен быть зарегистрирован ДО возврата HTTP-ответа.
    const task = work(outcome.key, outcome.job, outcome.history);
    defer(task);
    return { task };
  }

  return async function handle({ method, token, body }) {
    if (method === "GET") return { status: 200, body: { ok: true, service: "alice-gemini-search" } };
    if (method !== "POST") return { status: 405, body: { error: "Method not allowed" } };
    if (!sameSecret(token, config.secret)) return { status: 403, body: { error: "Access denied" } };
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "Invalid JSON" } };
    const controller = new AbortController();
    let timer;
    let handedOff = false;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        // Не отменяем фонового работника; только операции подготовки запроса.
        controller.abort();
        resolve({ status: 200, body: reply(handedOff ? WAIT_TEXT :
          "Хранилище отвечает медленно. Скажи «чек»; если ответа нет, повтори вопрос.") });
      }, foregroundMs);
    });
    const operation = route(body, controller.signal).then(async outcome => {
      if (!outcome.task) return outcome;
      handedOff = true;
      return { status: 200, body: await outcome.task };
    }).catch(() => ({ status: 200, body: reply("Сервис временно недоступен. Попробуй немного позже.") }));
    try { return await Promise.race([operation, deadline]); }
    finally { clearTimeout(timer); }
  };
}
