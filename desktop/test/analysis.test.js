// Analýza úspěšnosti: kalibrace, skupiny trhů, zjištění a dotaz na AI.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyze, marketGroup, buildPrompt, recentLosses, askGemini } = require("../src/analysis");

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

  const badKey = async () => ({ status: 400, ok: false, json: async () => ({ error: { message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] } }) });
  await assert.rejects(() => askGemini({ fetchFn: badKey, apiKey: "k", prompt: "q" }), /není platný/);
  const blocked = async () => ({ status: 200, ok: true, json: async () => ({ candidates: [{}] }) });
  await assert.rejects(() => askGemini({ fetchFn: blocked, apiKey: "k", prompt: "q" }), /žádný text/);
});
