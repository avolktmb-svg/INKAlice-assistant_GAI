import test from "node:test";
import assert from "node:assert/strict";
import { Providers } from "../lib/providers.js";
import { SEARCH_FAILED } from "../lib/common.js";

const config = { geminiKey: "fake", model: "gemini-test", serperKey: "fake", timezone: "UTC" };
const signal = () => AbortSignal.timeout(1000);
const plan = { search: true, query: "погода Астрахань завтра", kind: "search", period: "", clarification: "" };
const geminiResponse = data => Response.json({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(data) }] } }]
});

test("failed search never falls back to a memory-based Gemini answer", async () => {
  let geminiCalls = 0;
  const provider = new Providers(config, async url => {
    if (url.includes("google.serper.dev")) return new Response("", { status: 429 });
    geminiCalls++; return geminiResponse(plan);
  });
  assert.equal((await provider.run("А завтра?", [], signal())).text, SEARCH_FAILED);
  assert.equal(geminiCalls, 1);
});

test("empty search results never generate an unsupported answer", async () => {
  let calls = 0;
  const provider = new Providers(config, async url => {
    if (url.includes("google.serper.dev")) return Response.json({ organic: [] });
    calls++; return geminiResponse(plan);
  });
  assert.equal((await provider.run("Новости", [], signal())).text, SEARCH_FAILED);
  assert.equal(calls, 1);
});

test("context is passed to planner; rewritten query and date filter are used by Serper", async () => {
  const history = [{ role: "user", text: "Новости Астрахани" }];
  let calls = 0;
  const provider = new Providers(config, async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes("google.serper.dev")) {
      assert.ok(url.endsWith("/news"));
      assert.equal(body.q, "Новости Астрахани сегодня");
      assert.equal(body.tbs, "qdr:d");
      return Response.json({ news: [{
        title: "Событие", link: "https://example.com/news", snippet: "Описание", date: "2 hours ago"
      }] });
    }
    const input = JSON.parse(body.contents[0].parts[0].text);
    if (++calls === 1) {
      assert.deepEqual(input.history, history);
      assert.match(input.date, /^\d{4}-\d{2}-\d{2}$/);
      return geminiResponse({ ...plan, query: "Новости Астрахани сегодня", kind: "news", period: "d" });
    }
    assert.equal(input.sources[0].date, "2 hours ago");
    return geminiResponse({ answer: "Произошло событие.", supported: true, sourceIds: [1] });
  });
  const result = await provider.run("А сегодня?", history, signal());
  assert.equal(result.sources[0].host, "example.com");
  assert.equal(result.text, "Произошло событие.");
});

test("fabricated source ids are not accepted as supporting evidence", async () => {
  const provider = new Providers(config, async () =>
    geminiResponse({ answer: "Уверенный ответ", supported: true, sourceIds: [999] }));
  const result = await provider.answer("Вопрос", [], "2026-10-20",
    [{ id: 1, host: "example.com" }], true, signal());
  assert.match(result.text, /недостаточно данных/);
  assert.deepEqual(result.sources, []);
});

test("truncated structured generation is treated as an error", async () => {
  const provider = new Providers(config, async () => Response.json({
    candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{}" }] } }]
  }));
  await assert.rejects(provider.run("Вопрос", [], signal()));
});

test("search drops unsafe URLs and duplicates", async () => {
  const provider = new Providers(config, async () => Response.json({ organic: [
    { link: "javascript:alert(1)", snippet: "unsafe" },
    { link: "https://example.com/a", snippet: "OK" },
    { link: "https://example.com/a", snippet: "Duplicate" }
  ] }));
  const results = await provider.search(plan, signal());
  assert.equal(results.length, 1);
  assert.equal(results[0].host, "example.com");
});
