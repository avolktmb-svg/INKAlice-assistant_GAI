import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../lib/app.js";
import { MemoryStore, RedisStore } from "../lib/store.js";
import { reply, WAIT_TEXT } from "../lib/common.js";

const config = {
  skillId: "skill", secret: "x".repeat(32), allowed: [],
  timezone: "UTC", dailyLimit: 50, historyTTL: 86400
};
function request(text, id = 1, overrides = {}) {
  return {
    method: "POST", token: config.secret,
    body: {
      request: { command: text }, session: {
        skill_id: "skill", session_id: "session", message_id: id,
        user: { user_id: "user" }, ...overrides
      }
    }
  };
}
function fixture(run, options = {}) {
  const tasks = [];
  const store = options.store || new MemoryStore();
  const app = createApp({
    config: { ...config, ...options.config }, store, providers: { run },
    defer: task => tasks.push(task), foregroundMs: 25, ...options
  });
  return { app, store, tasks };
}

test("unauthorized webhook and wrong skill never invoke external services", async () => {
  let calls = 0;
  const { app } = fixture(async () => { calls++; });
  assert.equal((await app({ ...request("новости"), token: "wrong" })).status, 403);
  assert.equal((await app(request("новости", 1, { skill_id: "other" }))).status, 400);
  assert.equal(calls, 0);
});

test("private allowlist rejects other users", async () => {
  const { app } = fixture(async () => {}, { config: { ...config, allowed: ["owner"] } });
  assert.equal((await app(request("привет"))).status, 403);
});

test("activation phrase is not sent to Gemini", async () => {
  let calls = 0;
  const { app } = fixture(async () => { calls++; });
  const result = await app(request("запусти навык", 0, { new: true }));
  assert.match(result.body.response.text, /Привет/);
  assert.equal(calls, 0);
});

test("short greeting and help do not invoke providers or storage", async () => {
  const { app } = fixture(async () => { throw new Error("Provider must not run"); }, {
    store: { update() { throw new Error("Storage must not run"); } }
  });
  const greeting = await app(request("", 0, { new: true }));
  assert.equal(greeting.body.response.text, "Привет! Задай вопрос. Команды — «справка».");
  for (const cmd of ["Справка!", "помощь", "что ты умеешь"]) {
    const help = (await app(request(cmd))).body.response.text;
    for (const word of ["Чек", "Повтори", "Источники", "Забудь разговор", "Выход", "Справка"]) assert.ok(help.includes(word));
    assert.doesNotMatch(help, /продолжай/i);
  }
});

test("sources remain stored and appear only on explicit request, including after polling", async () => {
  let finish, calls = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  const { app, tasks } = fixture(async () => {
    calls++; await gate;
    return { text: "Свежий ответ.", sources: [{ host: "google.com", publisher: "Издание", url: "https://example.com/news", date: "today" }] };
  });
  await app(request("Новости"));
  assert.match((await app(request("источники", 2))).body.response.text, /готовится/);
  finish(); await Promise.all(tasks);
  for (const [i, cmd] of ["Чек!", "повтори"].entries()) {
    const response = (await app(request(cmd, i + 3))).body.response;
    assert.equal(response.text, "Свежий ответ.");
    assert.deepEqual(response.buttons, []);
  }
  const sources = (await app(request("откуда информация", 5))).body.response;
  assert.match(sources.text, /Издание/);
  assert.equal(sources.buttons[0].url, "https://example.com/news");
  assert.match(sources.buttons[0].title, /Издание/);
  assert.equal(calls, 1);
  await app(request("забудь разговор", 6));
  assert.match((await app(request("источники", 7))).body.response.text, /нет сохранённых/);
});

test("immediate response hides sources too; previous poll word is ordinary dialogue", async () => {
  const questions = [];
  const { app } = fixture(async question => {
    questions.push(question);
    return { text: "Ответ.", sources: [{ host: "example.com", url: "https://example.com" }] };
  });
  assert.deepEqual((await app(request("Вопрос"))).body.response.buttons, []);
  await app(request("продолжай", 2));
  assert.deepEqual(questions, ["Вопрос", "продолжай"]);
});

test("slow answer survives foreground response; polling and redelivery do not repeat generation", async () => {
  let finish, calls = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  const { app, tasks } = fixture(async () => {
    calls++; await gate; return { text: "Ответ готов.", sources: [] };
  });
  const initial = await app(request("Найди новости"));
  assert.equal(initial.body.response.text, WAIT_TEXT);
  assert.equal(tasks.length, 1);
  assert.equal((await app(request("Найди новости"))).body.response.text, WAIT_TEXT);
  assert.equal((await app(request("чек", 2))).body.response.text, WAIT_TEXT);
  finish();
  await Promise.all(tasks);
  assert.equal((await app(request("чек", 3))).body.response.text, "Ответ готов.");
  assert.equal(calls, 1);
});

test("concurrent duplicate requests start exactly one worker", async () => {
  let calls = 0;
  const { app } = fixture(async () => { calls++; return { text: "Ответ", sources: [] }; });
  await Promise.all([app(request("Вопрос")), app(request("Вопрос"))]);
  assert.equal(calls, 1);
});

test("history persists across Alice sessions but stays out of session_state", async () => {
  const histories = [];
  const { app } = fixture(async (_q, history) => {
    histories.push(history); return { text: "а".repeat(800), sources: [] };
  });
  await app(request("Первый вопрос"));
  const next = await app(request("А завтра?", 1, { session_id: "second" }));
  assert.equal(histories[1][0].text, "Первый вопрос");
  assert.equal(next.body.session_state, undefined);
});

test("reset prevents delayed worker from restoring deleted history", async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const { app, tasks } = fixture(async () => { await gate; return { text: "Старый ответ", sources: [] }; });
  await app(request("Первый вопрос"));
  await app(request("забудь разговор", 2));
  finish();
  await Promise.all(tasks);
  assert.match((await app(request("чек", 3))).body.response.text, /Пока нет/);
});

test("history is isolated between users", async () => {
  const histories = [];
  const { app } = fixture(async (_q, history) => {
    histories.push(history); return { text: "Ответ", sources: [] };
  });
  await app(request("Личный вопрос"));
  await app(request("Другой вопрос", 1, { user: { user_id: "second" } }));
  assert.deepEqual(histories[1], []);
});

test("daily limit blocks external calls; polling does not consume it", async () => {
  let calls = 0;
  const { app } = fixture(async () => { calls++; return { text: "Ответ", sources: [] }; },
    { config: { ...config, dailyLimit: 1 } });
  await app(request("Первый вопрос"));
  await app(request("чек", 2));
  const limited = await app(request("Второй вопрос", 3));
  assert.match(limited.body.response.text, /лимит/);
  assert.equal(calls, 1);
});

test("stale background job does not leave user waiting forever", async () => {
  let time = 0, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const { app, tasks } = fixture(async () => { await gate; return { text: "Поздно", sources: [] }; },
    { now: () => time });
  await app(request("Вопрос"));
  time = 70000;
  assert.match((await app(request("чек", 2))).body.response.text, /не завершился/);
  finish(); await Promise.all(tasks);
  assert.match((await app(request("чек", 3))).body.response.text, /не завершился/);
});

test("slow storage respects foreground deadline", async () => {
  const { app } = fixture(async () => {}, {
    store: { async update() { await new Promise(resolve => setTimeout(resolve, 150)); throw new Error(); } }
  });
  const start = Date.now();
  const result = await app(request("Вопрос"));
  assert.ok(Date.now() - start < 120);
  assert.match(result.body.response.text, /Хранилище/);
});

test("Redis CAS retries on contention and does not overwrite concurrent data", async () => {
  let raw = null, casCalls = 0;
  const fetcher = async (_url, options) => {
    const cmd = JSON.parse(options.body);
    if (cmd[0] === "GET") return Response.json({ result: raw });
    if (++casCalls === 1) {
      raw = JSON.stringify({ count: 10 }); return Response.json({ result: 0 });
    }
    assert.equal(cmd[4], raw);
    raw = cmd[5];
    return Response.json({ result: 1 });
  };
  const store = new RedisStore({ ...config, redisUrl: "https://redis.invalid", redisToken: "secret" }, fetcher);
  await store.update("key", current => ({
    write: true, value: { count: (current?.count || 0) + 1 }, result: true
  }));
  assert.equal(JSON.parse(raw).count, 11);
});

test("voice response fits Alice limits; source links are separate buttons", () => {
  const result = reply("Длинный ответ. ".repeat(200), [{ host: "example.com", url: "https://example.com" }]);
  assert.ok(result.response.text.length <= 1024);
  assert.equal(result.response.tts, result.response.text);
  assert.equal(result.response.buttons[0].url, "https://example.com");
});
