// Čisté funkce: kurzy, trhy, vyhodnocení, názvy týmů, povinné filtry, čas + shoda s Python implementací.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/config");
const { parseOdds, estimateOdds, fmtOdds } = require("../src/odds");
const { normalizePick, evaluate, forebetProbability, WIN, LOSS, VOID } = require("../src/markets");
const { normalize, teamSimilarity, sameMatch } = require("../src/names");
const { applyFilters, passesFilters, probabilityClass, HIGH, MID } = require("../src/filters");
const { localDate, fmtKickoff, fmtStamp, addDays, utcDateTime } = require("../src/timeutil");
const golden = require("./fixtures/golden.json");

const near = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);

// --- shoda s ověřenou Python implementací (stejné vstupy → stejné výstupy) ----------------------------------
test("shoda s Pythonem: parseOdds", () => {
  for (const [input, expected] of golden.parseOdds) assert.ok(near(parseOdds(input), expected), `parseOdds(${JSON.stringify(input)})`);
});
test("shoda s Pythonem: estimateOdds", () => {
  for (const [p, expected] of golden.estimateOdds) assert.ok(near(estimateOdds(p), expected), `estimateOdds(${p})`);
});
test("shoda s Pythonem: normalizePick", () => {
  for (const [label, home, away, code, labelCs] of golden.normalizePick) {
    const m = normalizePick(label, home, away);
    assert.equal(m.code, code, `kód pro ${JSON.stringify(label)}`);
    // popisky se od Pythonu záměrně liší: „Over/Under“ je teď česky (viz test níže)
    if (!/gólu|Over|Under/.test(labelCs)) assert.equal(m.labelCs, labelCs, `popisek pro ${JSON.stringify(label)}`);
  }
});
test("shoda s Pythonem: evaluate", () => {
  for (const [code, hg, ag, expected] of golden.evaluate) assert.equal(evaluate(code, hg, ag), expected, `${code} při ${hg}:${ag}`);
});
test("shoda s Pythonem: forebetProbability", () => {
  for (const [code, p1, px, p2, expected] of golden.forebetProbability) assert.ok(near(forebetProbability(code, p1, px, p2), expected), code);
});
test("shoda s Pythonem: normalize a teamSimilarity (1000+ dvojic)", () => {
  for (const [name, expected] of golden.normalize) assert.equal(normalize(name), expected, JSON.stringify(name));
  for (const [a, b, expected] of golden.similarity) assert.ok(near(teamSimilarity(a, b), expected), `${a} ~ ${b}: ${teamSimilarity(a, b)} vs ${expected}`);
});

// --- kurzy ---------------------------------------------------------------------------------------------------
test("parseOdds: americké kurzy se převedou na desetinné", () => {
  assert.equal(parseOdds("-143"), 1.7);
  assert.equal(parseOdds("-118"), 1.85);
  assert.equal(parseOdds("+150"), 2.5);
  assert.equal(parseOdds("1,85"), 1.85);
  assert.equal(parseOdds("5/4"), 2.25);
});
test("parseOdds: nesmysly a prázdné hodnoty → null", () => {
  for (const x of ["-", "", null, undefined, "abc", "1.00", "0.5", "-50"]) assert.equal(parseOdds(x), null, String(x));
});
test("estimateOdds je opatrný a validovaný, fmtOdds značí odhad", () => {
  assert.ok(Math.abs(estimateOdds(70) - 1.34) < 0.01);
  assert.equal(estimateOdds(0), null);
  assert.equal(estimateOdds(100), null);
  assert.equal(fmtOdds(1.7), "1.70");
  assert.equal(fmtOdds(1.6, true), "~1.60");
  assert.equal(fmtOdds(null), "–");
});

// --- trhy ----------------------------------------------------------------------------------------------------
test("normalizePick: neznámý trh se nezahazuje a české popisky", () => {
  const m = normalizePick("Total corners Over (9,5)", "A", "B");
  assert.ok(m.code.startsWith("OTHER:"));
  assert.equal(m.labelCs, "Více než 9,5 rohů");
  assert.equal(normalizePick("Total goals Over (2,5)", "A", "B").labelCs, "Více než 2,5 gólu");
  assert.equal(normalizePick("Arsenal to Win", "Forest", "Arsenal").labelCs, "2 – výhra Arsenal");
  assert.ok(normalizePick("Arsenal Handicap (0)", "Forest", "Arsenal").labelCs.includes("bez remízy"));
});
test("normalizePick: všechny popisky česky (góly, týmové totaly, nedá gól, rohy, karty)", () => {
  const cs = (l, h = "A", a = "B") => normalizePick(l, h, a).labelCs;
  assert.equal(cs("Total goals Over (3)"), "Více než 3 góly");
  assert.equal(cs("Total goals Under (1)"), "Méně než 1 gól");
  assert.equal(cs("Total goals Over (5)"), "Více než 5 gólů");
  assert.equal(cs("A Total goals Under (1,5)"), "A: méně než 1,5 gólu");
  assert.deepEqual(normalizePick("Slovan will not score", "Spartak", "Slovan"), { code: "AU0.5", labelCs: "Slovan nedá gól" });
  assert.deepEqual(normalizePick("Spartak will score", "Spartak", "Slovan"), { code: "HO0.5", labelCs: "Spartak dá gól" });
  assert.equal(cs("Total yellow cards Under (4,5)"), "Méně než 4,5 žlutých karet");
  assert.equal(cs("Draw No Bet"), "Sázka bez remízy");
  assert.ok(!/\b(Over|Under|will|score)\b/.test(cs("A Handicap (+1,5)")));
});
test("normalizePick: delší název týmu má přednost (Real Madrid vs. Real Madrid Castilla)", () => {
  assert.equal(normalizePick("Real Madrid Castilla to Win", "Real Madrid", "Real Madrid Castilla").code, "2");
});
test("evaluate: push na celočíselné linii a ruční trhy", () => {
  assert.equal(evaluate("O3", 2, 1), VOID);
  assert.equal(evaluate("O2.5", 2, 1), WIN);
  assert.equal(evaluate("AH2:+1.5", 2, 0), LOSS);
  assert.equal(evaluate("O2.25", 3, 0), null);
  assert.equal(evaluate("OTHER:corners", 1, 1), null);
});

// --- názvy týmů ---------------------------------------------------------------------------------------------------
test("sameMatch je citlivý na pořadí týmů", () => {
  assert.ok(sameMatch("Arsenal", "Chelsea", "Arsenal FC", "Chelsea FC") > 0.9);
  assert.equal(sameMatch("Arsenal", "Chelsea", "Chelsea", "Arsenal"), 0);
});
test("podobné a různé kluby", () => {
  for (const [a, b] of [["Brighton & Hove Albion", "Brighton"], ["Coventry", "Coventry City"], ["1. FC Köln", "FC Koln"]]) assert.ok(teamSimilarity(a, b) >= 0.85, `${a} ~ ${b}`);
  for (const [a, b] of [["Manchester City", "Manchester United"], ["Real Madrid", "Real Sociedad"], ["Manchester United", "Newcastle United"]]) assert.ok(teamSimilarity(a, b) < 0.6, `${a} ≁ ${b}`);
});

// --- povinné filtry --------------------------------------------------------------------------------------------------
const mk = (over = {}) => ({
  home: "A", away: "B", leagueKey: "EPL", league: "Liga", kickoff: new Date(Date.UTC(2026, 9, 18, 15, 30)), tipCode: "1", tipLabel: "1",
  probability: 70, odds: 1.6, oddsEstimated: false, sources: ["Scores24"], ...over,
});
test("filtr: pravděpodobnost musí být striktně nad 60 %", () => {
  assert.equal(passesFilters(mk({ probability: 60.0 })), false);
  assert.equal(passesFilters(mk({ probability: 60.1 })), true);
  assert.equal(passesFilters(mk({ probability: 59.9 })), false);
});
test("filtr: minimální kurz je včetně", () => {
  assert.equal(passesFilters(mk({ odds: 1.5 })), true);
  assert.equal(passesFilters(mk({ odds: 1.49 })), false);
});
test("filtr: jen sledované ligy", () => {
  assert.equal(passesFilters(mk({ leagueKey: "MLS" })), false);
  assert.equal(passesFilters(mk({ leagueKey: "NEEXISTUJE" })), false);
});
test("filtr: chybějící kurz se odhadne a označí; příliš nízký odhad vypadne", () => {
  const t = mk({ probability: 62, odds: null });
  assert.deepEqual(applyFilters([t]), [t]);
  assert.equal(t.oddsEstimated, true);
  assert.ok(t.odds >= config.MIN_ODDS);
  assert.deepEqual(applyFilters([mk({ probability: 85, odds: null })]), []);
});
test("filtr: kombinace a pásma barev (75 % je ještě žlutá)", () => {
  const out = applyFilters([mk({ probability: 80, odds: 1.7 }), mk({ probability: 59, odds: 2.5 }), mk({ probability: 75, odds: 1.2 }), mk({ probability: 61, odds: 1.5 })]);
  assert.deepEqual(out.map((t) => [t.probability, t.odds]), [[80, 1.7], [61, 1.5]]);
  assert.equal(probabilityClass(75.0), MID);
  assert.equal(probabilityClass(75.1), HIGH);
});

// --- čas ------------------------------------------------------------------------------------------------------------------
test("čas: pražské datum a formát (letní čas)", () => {
  const d = new Date(Date.UTC(2026, 9, 18, 15, 30)); // 15:30 UTC = 17:30 SELČ
  assert.equal(fmtKickoff(d), "ne 18.10. 17:30");
  assert.equal(fmtStamp(d), "18.10.2026 17:30");
  assert.equal(localDate(new Date(Date.UTC(2026, 9, 18, 22, 30))), "2026-10-19"); // po půlnoci v Praze už je další den
  assert.equal(localDate(new Date(Date.UTC(2026, 0, 15, 22, 30))), "2026-01-15"); // v zimě +1 h: 23:30 je ještě týž den
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(utcDateTime("2026-10-18", 13, 5).toISOString(), "2026-10-18T13:05:00.000Z");
});

test("filtry: ženské zápasy se vyřadí", () => {
  const { isWomens } = require("../src/filters");
  for (const [h, a] of [["Cruzeiro W", "Bolívar W"], ["Arsenal Women", "Chelsea"], ["Madrid CFF", "Barça (W)"], ["Real Madrid Femenina", "X"], ["Bayern Frauen", "Y"]]) {
    assert.equal(isWomens({ home: h, away: a }), true, `${h} – ${a}`);
  }
  for (const [h, a] of [["Wolfsburg", "Werder Bremen"], ["West Ham", "Newcastle"], ["Sparta Praha", "Slavia Praha"], ["W Connection", "Y"]]) {
    assert.equal(isWomens({ home: h, away: a }), false, `${h} – ${a}`);
  }
});

test("teamSimilarity: aliasy názvů, které se mezi zdroji liší (Cologne × Köln, přejmenované kluby, turecké ı)", () => {
  const { teamSimilarity, sameMatch } = require("../src/names");
  for (const [a, b] of [["Cologne", "Köln"], ["Kasimpasa Istanbul", "Kasımpasa SK"], ["Amed Sportif Faaliyetler", "Amedspor"], ["SK Artis Brno", "SK Lisen"],
    ["Fastav Zlin", "FK Trinity Zlin"], ["Eyupspor", "Eyüpspor"], ["Schalke", "Schalke 04"],
    ["Royal Charleroi", "Sporting Charleroi"], ["Oud Heverlee", "OH Leuven"], ["Lommel", "Lommel United"]]) {
    assert.ok(teamSimilarity(a, b) >= 0.9, `${a} × ${b}`);
  }
  assert.ok(sameMatch("Fastav Zlin", "Sigma", "FK Trinity Zlin", "Sigma Olomouc") > 0.9);
  assert.equal(sameMatch("Fastav Zlin", "Sigma", "Sigma Olomouc", "FK Trinity Zlin"), 0); // zrcadlový zápas je jiný
});
