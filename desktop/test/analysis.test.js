// Analýza úspěšnosti: kalibrace, skupiny trhů, zjištění a dotaz na AI.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyze, marketGroup, buildPrompt, recentLosses, askGemini, generate } = require("../src/analysis");

const tip = (probability, outcome, o = {}) => ({ probability, outcome, tipCode: "1", league: "Premier League", odds: 1.8, oddsEstimated: false, matchName: "A – B", tipLabel: "x", homeScore: 0, awayScore: 1, ...o });

test("marketGroup: skupiny trhů", () => {
  assert.deepEqual(["1", "1X", "BTTS", "O2.5", "HU0.5", "AH1:-1.5", "OTHER:x"].map(marketGroup),
    ["Výsledek zápasu (1X2)", "Dvojitá šance", "Oba týmy skórují", "Góly celkem", "Góly jednoho týmu", "Handicap", "Ostatní trhy"]);
});

test("analyze: pásma, rozdíl a zjištění o nadhodnocených 80–90 %", () => {
  const tips = [
    ...Array.from({ length: 10 }, (_, i) => tip(85, i < 5 ? "win" : "loss")),   // 50 % místo 85 %
    ...Array.from({ length: 10 }, (_, i) => tip(65, i < 7 ? "win" : "loss")),   // 70 % místo 65 %
    tip(75, "void"), tip(70, null),                                              // se nepočítají
  ];
  const a = analyze(tips);
  assert.equal(a.overall.n, 20);
  const b80 = a.bands.find((b) => b.label === "80–90 %");
  assert.deepEqual([b80.n, b80.predicted, b80.actual, b80.gap], [10, 85, 50, -35]);
  assert.equal(a.bands.find((b) => b.label === "60–70 %").gap, 5);
  assert.ok(a.insights.some((s) => s.includes("80–90 %") && s.includes("nadhodnocená")));
  assert.ok(a.insights.some((s) => s.includes("orientační"))); // méně než 30 tipů
  assert.equal(a.pending, 1);
});

test("analyze: ROI jen ze skutečných kurzů a prázdná data", () => {
  const a = analyze([tip(70, "win", { odds: 2 }), tip(70, "loss", { odds: 2 }), tip(70, "win", { odds: 1.5, oddsEstimated: true })]);
  assert.equal(a.overall.roi, 0); // (+1 −1) / 2
  assert.deepEqual(analyze([]).overall, { n: 0, wins: 0, predicted: null, actual: null, gap: null, roi: null });
});

test("buildPrompt a recentLosses", () => {
  const tips = [tip(80, "loss"), tip(80, "win")];
  const losses = recentLosses(tips);
  assert.equal(losses.length, 1);
  const p = buildPrompt(analyze(tips), losses);
  assert.ok(p.includes("pasma_pravdepodobnosti") && p.includes("posledni_prohry"));
});

test("askGemini: úspěch, záložní model a chyby", async () => {
  const ok = async (url, init) => {
    assert.match(url, /gemini-flash-latest:generateContent$/);
    assert.equal(init.headers["x-goog-api-key"], "k");
    assert.equal(JSON.parse(init.body).contents[0].parts[0].text, "q");
    return { status: 200, ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "Odpověď" }] } }] }) };
  };
  assert.equal(await askGemini({ fetchFn: ok, apiKey: "k", prompt: "q" }), "Odpověď");

  const urls = [];
  const fallback = async (url) => {
    urls.push(url);
    return url.includes("gemini-flash-latest")
      ? { status: 404, ok: false, json: async () => ({ error: { message: "nenalezen" } }) }
      : { status: 200, ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "B" }] } }] }) };
  };
  assert.equal(await askGemini({ fetchFn: fallback, apiKey: "k", prompt: "q" }), "B");
  assert.equal(urls.length, 2);

  // přetížení (503): znovu na stejném modelu, pak na dalším; vše přetížené → srozumitelná zpráva
  let calls = 0;
  const flaky = async () => (++calls < 3
    ? { status: 503, ok: false, json: async () => ({ error: { message: "This model is currently experiencing high demand." } }) }
    : { status: 200, ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "Po opakování" }] } }] }) });
  assert.equal(await askGemini({ fetchFn: flaky, apiKey: "k", prompt: "q", sleep: async () => {} }), "Po opakování");
  assert.equal(calls, 3);
  const allBusy = async () => ({ status: 503, ok: false, json: async () => ({ error: { message: "high demand" } }) });
  await assert.rejects(() => askGemini({ fetchFn: allBusy, apiKey: "k", prompt: "q", sleep: async () => {} }), /přetížené/);

  const badKey = async () => ({ status: 400, ok: false, json: async () => ({ error: { message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] } }) });
  await assert.rejects(() => askGemini({ fetchFn: badKey, apiKey: "k", prompt: "q" }), /není platný/);
  const blocked = async () => ({ status: 200, ok: true, json: async () => ({ candidates: [{}] }) });
  await assert.rejects(() => askGemini({ fetchFn: blocked, apiKey: "k", prompt: "q" }), /žádný text/);
});

const reply = (status, error) => ({ status, ok: false, json: async () => ({ error }) });
const okText = (text, extra = {}) => ({ status: 200, ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] }, ...extra }] }) });
const quotaError = (message, { quotaId = "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue = "10", retryDelay } = {}) => ({
  code: 429, status: "RESOURCE_EXHAUSTED", message,
  details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId, quotaValue }] },
    ...(retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] : [])],
});

test("generate: volby požadavku (JSON režim, teplota, limit tokenů) a vrácený model", async () => {
  let sent = null;
  const f = async (_url, init) => { sent = JSON.parse(init.body); return okText("x"); };
  const r = await generate({ fetchFn: f, apiKey: "k", prompt: "q", json: true, temperature: null, maxTokens: 9000, system: "vlastní" });
  assert.deepEqual([r.text, r.model], ["x", "gemini-flash-latest"]);
  assert.equal(sent.generationConfig.responseMimeType, "application/json");
  assert.equal(sent.generationConfig.temperature, undefined);
  assert.equal(sent.generationConfig.maxOutputTokens, 9000);
  assert.equal(sent.systemInstruction.parts[0].text, "vlastní");
  assert.equal(sent.tools, undefined);
  await generate({ fetchFn: f, apiKey: "k", prompt: "q" });
  assert.equal(sent.generationConfig.temperature, 0.4);
  assert.equal(sent.generationConfig.responseMimeType, undefined);
  const cut = async () => okText("{\"tikety\":[", { finishReason: "MAX_TOKENS" });
  await assert.rejects(() => generate({ fetchFn: cut, apiKey: "k", prompt: "q", json: true }), /useklá/);
  const thought = async () => ({ status: 200, ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "úvaha", thought: true }, { text: "odpověď" }] } }] }) });
  assert.equal(await askGemini({ fetchFn: thought, apiKey: "k", prompt: "q" }), "odpověď");
});

test("generate: model s nulovým limitem (účet zdarma) se přeskočí hned a zpráva řekne pravý důvod", async () => {
  const urls = [];
  const zero = async (url) => {
    urls.push(url);
    return reply(429, quotaError("You exceeded your current quota. * Quota exceeded for metric: generate_content_free_tier_requests, limit: 0", { quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "0" }));
  };
  await assert.rejects(() => generate({ fetchFn: zero, apiKey: "k", prompt: "q", sleep: async () => { throw new Error("nečekat"); } }), (e) => {
    assert.match(e.message, /nemá pro model gemini-flash-latest žádný dostupný limit/);
    assert.match(e.message, /\[Google: HTTP 429 RESOURCE_EXHAUSTED: You exceeded your current quota/);
    assert.doesNotMatch(e.message, /přetížené/);
    return true;
  });
  assert.equal(urls.length, 4);   // každý model jednou, bez opakování
});

test("generate: denní limit, krátká pauza doporučená Googlem a minutový limit bez doporučení", async () => {
  const daily = async () => reply(429, quotaError("Quota exceeded", { quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }));
  await assert.rejects(() => generate({ fetchFn: daily, apiKey: "k", prompt: "q" }), /Vyčerpaný denní limit Gemini API \(model gemini-flash-latest\)/);

  // doporučená pauza 3 s → počká 4 s a zkusí stejný model znovu
  const waits = [];
  let calls = 0;
  const retry = async (url) => { calls += 1; return calls === 1 ? reply(429, quotaError("Please retry in 3s", { retryDelay: "3s" })) : okText(url.includes("gemini-flash-latest") ? "stejný model" : "jiný model"); };
  assert.equal(await askGemini({ fetchFn: retry, apiKey: "k", prompt: "q", sleep: async (ms) => { waits.push(ms); } }), "stejný model");
  assert.deepEqual(waits, [4000]);

  // dlouhá pauza se nečeká, zkusí se další model
  let n = 0;
  const longWait = async (url) => { n += 1; return n === 1 ? reply(429, quotaError("Please retry in 50s", { retryDelay: "50s" })) : okText(url); };
  const text = await askGemini({ fetchFn: longWait, apiKey: "k", prompt: "q", sleep: async () => { throw new Error("nečekat"); } });
  assert.match(text, /gemini-2\.5-flash:generateContent$/);

  const minute = async () => reply(429, quotaError("Too many requests"));
  await assert.rejects(() => generate({ fetchFn: minute, apiKey: "k", prompt: "q" }), /Překročený limit Gemini API/);
});

test("generate: přetížení (503) → po dvou pokusech další model; všechny přetížené → česká zpráva; chyby klíče", async () => {
  let calls = 0;
  const busy = async () => { calls += 1; return reply(503, { code: 503, status: "UNAVAILABLE", message: "This model is currently experiencing high demand." }); };
  await assert.rejects(() => generate({ fetchFn: busy, apiKey: "k", prompt: "q", sleep: async () => {} }), (e) => /Gemini je teď přetížené/.test(e.message) && /UNAVAILABLE/.test(e.message));
  assert.equal(calls, 8);          // 4 modely × 2 pokusy
  const gone = async () => reply(404, { message: "models/x is not found" });
  await assert.rejects(() => generate({ fetchFn: gone, apiKey: "k", prompt: "q" }), /not found/);
  const forbidden = async () => reply(403, { message: "API has not been used" });
  await assert.rejects(() => generate({ fetchFn: forbidden, apiKey: "k", prompt: "q" }), /nemá přístup/);
});
