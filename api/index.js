import { waitUntil } from "@vercel/functions";
import { createApp } from "../lib/app.js";
import { configFromEnv, reply } from "../lib/common.js";
import { Providers } from "../lib/providers.js";
import { RedisStore } from "../lib/store.js";

let app;
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "alice-gemini-search" });
  try {
    if (!app) {
      const config = configFromEnv();
      app = createApp({ config, store: new RedisStore(config), providers: new Providers(config), defer: waitUntil });
    }
    const result = await app({ method: req.method, token: req.query?.token, body: req.body });
    if (result.status === 405) res.setHeader("Allow", "GET, POST");
    return res.status(result.status).json(result.body);
  } catch {
    console.warn("CONFIGURATION_ERROR");
    return res.status(200).json(reply("Навык пока не настроен. Попробуй позже."));
  }
}
