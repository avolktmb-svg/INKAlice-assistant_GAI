import http from "node:http";
import { createApp } from "../lib/app.js";
import { configFromEnv } from "../lib/common.js";
import { Providers } from "../lib/providers.js";
import { MemoryStore, RedisStore } from "../lib/store.js";

const demo = process.argv.includes("--demo");
const config = demo ? {
  skillId: "demo", secret: "local-demo-secret-not-for-production",
  allowed: [], timezone: "UTC", historyTTL: 86400, dailyLimit: 50
} : configFromEnv();
const pending = new Set();
const providers = demo ? {
  async run(question) {
    await new Promise(resolve => setTimeout(resolve, 4000));
    return { text: `Демонстрационный ответ на вопрос «${question}». Интернет и Gemini не вызывались.`, sources: [] };
  }
} : new Providers(config);
const app = createApp({
  config, store: demo ? new MemoryStore() : new RedisStore(config), providers,
  defer(task) { pending.add(task); task.finally(() => pending.delete(task)); }
});
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let raw = "";
    for await (const chunk of req) {
      raw += chunk.toString();
      if (Buffer.byteLength(raw) > 65536) {
        res.writeHead(413).end(); return;
      }
    }
    const result = await app({
      method: req.method, token: url.searchParams.get("token"), body: raw ? JSON.parse(raw) : {}
    });
    res.writeHead(result.status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result.body));
  } catch { res.writeHead(400).end('{"error":"Invalid request"}'); }
});
server.listen(Number(process.env.PORT || 3000), "127.0.0.1", () => console.log(
  `Local ${demo ? "DEMO (no external calls)" : "LIVE"} server: http://127.0.0.1:${server.address().port}/api`
));
