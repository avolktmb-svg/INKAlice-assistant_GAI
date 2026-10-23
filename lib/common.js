import { createHash, timingSafeEqual } from "node:crypto";

export const WAIT_TEXT = "Готовлю ответ. Через несколько секунд скажи «чек».";
export const SEARCH_FAILED = "Не удалось проверить свежие сведения в интернете. Не буду выдавать ответ по памяти за актуальный. Попробуй задать вопрос ещё раз позже.";

export function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sameSecret(a, b) {
  return typeof a === "string" && typeof b === "string" &&
    timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}

export function fitText(value, limit = 1000) {
  const text = String(value ?? "").replace(/https?:\/\/\S+/g, "")
    .replace(/[*#`]/g, "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text || "Не удалось подготовить ответ.";
  const cut = text.slice(0, limit - 1);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > limit / 2 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

export function reply(text, sources = [], end = false) {
  const clean = fitText(text);
  return {
    version: "1.0",
    response: {
      text: clean,
      tts: clean,
      end_session: end,
      buttons: sources.slice(0, 3).map((source, i) => ({
        title: `Источник ${i + 1}: ${source.publisher || source.host}`.slice(0, 64),
        url: source.url,
        hide: true
      }))
    }
    // История намеренно не передаётся в session_state (лимит Яндекса — 1 КБ).
  };
}

export function command(text) {
  return text.toLowerCase().replace(/ё/g, "е").replace(/[«»"'.,!?]/g, "").trim();
}

export function publicError(error) {
  if (error?.code === "QUOTA") return "Сейчас закончился лимит запросов к нейросети. Попробуй позже.";
  if (error?.code === "AUTH") return "Не получилось подключиться к сервису. Нужно проверить его настройки.";
  return "Не удалось подготовить ответ. Попробуй задать вопрос ещё раз позже.";
}

export function dateInZone(date, zone) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: zone }).format(date);
}

export function configFromEnv(env = process.env) {
  const required = ["GEMINI_API_KEY", "GEMINI_MODEL", "SERPER_API_KEY",
    "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "ALICE_SKILL_ID", "WEBHOOK_SECRET"];
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}`);
  if (env.WEBHOOK_SECRET.length < 32) throw new Error("WEBHOOK_SECRET must have at least 32 characters");
  if (!/^[a-zA-Z0-9._-]+$/.test(env.GEMINI_MODEL)) throw new Error("Invalid GEMINI_MODEL");
  const url = new URL(env.UPSTASH_REDIS_REST_URL);
  if (url.protocol !== "https:") throw new Error("Redis REST URL must use HTTPS");
  const timezone = env.TIMEZONE || "UTC";
  dateInZone(new Date(), timezone);
  const historyTTL = Number(env.HISTORY_TTL_SECONDS || 86400);
  const dailyLimit = Number(env.DAILY_QUESTION_LIMIT || 50);
  if (!Number.isInteger(historyTTL) || historyTTL < 300 || historyTTL > 604800 ||
      !Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000) {
    throw new Error("Invalid history TTL or daily limit");
  }
  return {
    geminiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL,
    serperKey: env.SERPER_API_KEY, redisUrl: url.origin,
    redisToken: env.UPSTASH_REDIS_REST_TOKEN, skillId: env.ALICE_SKILL_ID,
    secret: env.WEBHOOK_SECRET, timezone, historyTTL, dailyLimit,
    allowed: (env.ALLOWED_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean)
  };
}
