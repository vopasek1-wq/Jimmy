// Čisté funkce: kurzy, trhy, vyhodnocení, názvy týmů, povinné filtry, čas + shoda s Python implementací.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/config");
const { parseOdds, estimateOdds } = require("../src/odds");
const { normalizePick, evaluate, forebetProbability, WIN, LOSS, VOID } = require("../src/markets");
const { normalize, teamSimilarity, sameMatch } = require("../src/names");
const { rejectReason, splitByFilters, probabilityClass, HIGH, MID } = require("../src/filters");
const passesFilters = (tip) => rejectReason(tip) === null;
const applyFilters = (tips) => splitByFilters(tips).passed;
const { localDate, fmtStamp, addDays, utcDateTime } = require("../src/timeutil");
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
test("forebetProbability: handicap 0 (sázka bez remízy) = výhra týmu při vyřazení remízy", () => {
  assert.equal(forebetProbability("AH1:0", 45, 28, 27), 62.5);
  assert.equal(forebetProbability("AH2:0", 45, 28, 27), 37.5);
  assert.equal(forebetProbability("AH2:0", 10, 20, 70), 87.5);
  assert.equal(forebetProbability("AH1:0", 0, 100, 0), null); // nemá z čeho počítat
  assert.equal(forebetProbability("AH1:-1.5", 45, 28, 27), null); // ostatní handicapy Forebet nehodnotí
  assert.equal(forebetProbability("AH2:+1.5", 45, 28, 27), null);
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
test("estimateOdds je opatrný a validovaný", () => {
  assert.ok(Math.abs(estimateOdds(70) - 1.34) < 0.01);
  assert.equal(estimateOdds(0), null);
  assert.equal(estimateOdds(100), null);
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
test("ligy: norská Eliteserien a bulharská První liga se poznají podle odkazu na Scores24 i podle názvu", () => {
  assert.equal(config.findLeague("", "", "norway-eliteserien").key, "NORSKO");
  assert.equal(config.findLeague("Norway", "Eliteserien", "x").key, "NORSKO");
  assert.equal(config.findLeague("", "", "bulgaria-first-professional-league").key, "BULHARSKO");
  assert.equal(config.findLeague("Bulgaria", "First Professional League", "x").key, "BULHARSKO");
  assert.equal(config.findLeague("Bulgaria", "Second League", "bulgaria-second-league"), null);
  assert.deepEqual([config.leagueByKey("NORSKO").sofascoreId, config.leagueByKey("BULHARSKO").sofascoreId], [20, 247]);
});
test("názvy týmů: Hamarkameratene = HamKam", () => {
  assert.ok(sameMatch("KFUM Oslo", "Hamarkameratene", "KFUM Oslo", "HamKam") >= 0.9);
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
test("filtr: rejectReason říká, proč tip nepřešel (v pořadí podmínek), a prošlý tip nemá důvod", () => {
  assert.equal(rejectReason(mk()), null);
  assert.equal(rejectReason(mk({ home: "Arsenal W" })).code, "women");
  assert.equal(rejectReason(mk({ leagueKey: "MLS" })).code, "league");
  assert.equal(rejectReason(mk({ probability: null })).code, "noprob");
  assert.deepEqual(rejectReason(mk({ probability: 55.25, probSource: "Forebet" })), { code: "lowprob", text: "pravděpodobnost 55,3 % (Forebet) není nad 60 %" });
  assert.equal(rejectReason(mk({ probability: 60 })).code, "lowprob"); // striktně nad 60
  assert.equal(rejectReason(mk({ odds: null })).code, "noodds");
  assert.deepEqual(rejectReason(mk({ odds: 1.3 })), { code: "lowodds", text: "kurz 1,3 je pod 1,50" });
  const { passed, rejected } = splitByFilters([mk(), mk({ probability: 50 }), mk({ odds: 1.2 })]);
  assert.equal(passed.length, 1);
  assert.deepEqual(rejected.map((r) => r.reason.code), ["lowprob", "lowodds"]);
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
    ["Royal Charleroi", "Sporting Charleroi"], ["Oud Heverlee", "OH Leuven"], ["Lommel", "Lommel United"],
    ["PSV", "PSV Eindhoven"], ["Feyenoord Rotterdam", "Feyenoord"], ["Sporting Lisbon", "Sporting CP"], ["Heart of Midlothian", "Hearts"]]) {
    assert.ok(teamSimilarity(a, b) >= 0.9, `${a} × ${b}`);
  }
  assert.ok(sameMatch("Fastav Zlin", "Sigma", "FK Trinity Zlin", "Sigma Olomouc") > 0.9);
  assert.equal(sameMatch("Fastav Zlin", "Sigma", "Sigma Olomouc", "FK Trinity Zlin"), 0); // zrcadlový zápas je jiný
});

test("Ligy: domácí poháry sledovaných zemí se poznají podle hlavičky Scores24 a patří pod hlavní ligu země", () => {
  const key = (country, name, slug) => (config.findLeague(country, name, slug) || {}).key || null;
  assert.equal(key("England", "EFL Cup", "england-efl-cup"), "EFLCUP");
  assert.equal(key("Germany", "DFB Pokal", "germany-dfb-pokal"), "DFBPOKAL");
  assert.equal(key("Netherlands", "KNVB beker", "netherlands-knvb-beker"), "KNVB");
  assert.equal(key("Turkey", "Football Cup", "turkey-turkiye-kupasi"), "TURCUP");
  assert.equal(key("Czech Republic", "Cup", "czech-republic-cup"), "CZECUP");
  assert.equal(key("Portugal", "League Cup", "portugal-league-cup"), "TACALIGA");
  assert.equal(key("Spain", "Copa del Rey", "spain-copa-del-rey"), "COPADELREY");
  assert.equal(key("Greece", "Cup", "greece-greece-cup"), null);                       // pohár země, kterou nesledujeme
  assert.equal(key("Scotland", "Cup", "scotland-cup"), "SCOCUP");
  const group = (k) => config.leagueByKey(k).group;
  assert.deepEqual(["EPL", "FACUP", "EFLCUP", "SKOTSKO", "SCOLCUP", "UCL"].map(group), ["EPL", "EPL", "EPL", "SKOTSKO", "SKOTSKO", "UCL"]);
  assert.ok(config.LEAGUES.every((lg) => config.leagueByKey(lg.group)));                // skupina vždy odkazuje na existující ligu
  assert.equal(new Set(config.LEAGUES.map((lg) => lg.sofascoreId)).size, config.LEAGUES.length); // ID soutěže na SofaScore je u každé jiné
});

test("Ligy: ženská Liga mistrů se za Ligu mistrů nepovažuje", () => {
  assert.equal(config.findLeague("Europe", "UEFA Champions League Women", "international-clubs-uefa-champions-league-women"), null);
  assert.equal(config.findLeague("Europe", "UEFA Champions League", "international-clubs-uefa-champions-league").key, "UCL");
});
