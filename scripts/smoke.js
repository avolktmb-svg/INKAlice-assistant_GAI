import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { once } from "node:events";

// HTTP smoke test локального демо; никаких ключей и внешних запросов.
const child = spawn(process.execPath, ["scripts/dev.js", "--demo"], {
  env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"]
});
let timer;
try {
  const origin = await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Demo startup timeout")), 5000);
    child.on("error", reject);
    child.stdout.on("data", chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\/api/);
      if (match) resolve(match[0]);
    });
    child.on("exit", code => reject(new Error(`Demo exited: ${code}`)));
  });
  clearTimeout(timer);
  assert.equal((await fetch(origin)).status, 200);
  const post = async (text, id) => {
    const response = await fetch(`${origin}?token=local-demo-secret-not-for-production`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "1.0", request: { command: text },
        session: { skill_id: "demo", session_id: "smoke", message_id: id,
          user: { user_id: "demo-user" } }
      })
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const start = Date.now();
  const initial = await post("Какая погода?", 1);
  assert.match(initial.response.text, /Готовлю ответ/);
  assert.ok(Date.now() - start < 3500);
  await new Promise(resolve => setTimeout(resolve, 1800));
  const result = await post("чек", 2);
  assert.match(result.response.text, /Демонстрационный ответ/);
  await post("забудь разговор", 3);
  assert.match((await post("чек", 4)).response.text, /Пока нет/);
  console.log("HTTP smoke passed: fast acknowledgement, background result, history reset. No external APIs called.");
} finally {
  clearTimeout(timer);
  child.kill();
  if (child.exitCode === null) await once(child, "exit");
}
