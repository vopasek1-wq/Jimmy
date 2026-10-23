// Databáze, sloučení zdrojů, celý běh pipeline (se zástupnými scrapery) a vyhodnocení výsledků.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { Database } = require("../src/database");
const { Pipeline, combine, updateResults } = require("../src/pipeline");
const { NetworkError, SourceError } = require("../src/http");
const { SOURCE_SCORES24, SOURCE_FOREBET, newResult, tipKey } = require("../src/models");
const scores24 = require("../src/scrapers/scores24");
const { s24Row, s24Block, s24Page, forebetRow, forebetPage, sofaEvent } = require("./helpers/html");

const KO = new Date(Date.UTC(2026, 9, 18, 15, 30));
const mk = (o = {}) => ({
  home: "Nottingham Forest", away: "Arsenal", leagueKey: "EPL", league: "Anglie – Premier League", kickoff: KO, tipCode: "2", tipLabel: "tip 2",
  rawLabel: "", probability: 80, odds: 1.7, oddsEstimated: false, sources: [SOURCE_SCORES24], probForebet: null, status: "upcoming",
  homeScore: null, awayScore: null, url: "", sofascoreUrl: "", sofascoreId: null, id: null, outcome: null, outcomeSource: null, ...o,
});
const okResult = (tips) => ({ ...newResult(new Date()), tips, finishedAt: new Date(), statuses: { [SOURCE_SCORES24]: { name: SOURCE_SCORES24, state: "ok", message: "" } } });
const memDb = () => new Database(":memory:");

// --- databáze --------------------------------------------------------------------------------------------------
test("DB: uložení a pohled na poslední běh", () => {
  const db = memDb();
  assert.equal(db.latestRun(), null);
  assert.deepEqual(db.tipsOfLatestRun(), []);
  db.saveRun(okResult([mk(), mk({ home: "A", away: "B", tipCode: "1", probability: 70, odds: 1.6 })]));
  const got = db.tipsOfLatestRun();
  assert.deepEqual(new Set(got.map((t) => t.home)), new Set(["Nottingham Forest", "A"]));
  const t = got.find((x) => x.home === "Nottingham Forest");
  assert.equal(t.kickoff.getTime(), KO.getTime());
  assert.deepEqual(t.sources, [SOURCE_SCORES24]);
  assert.ok(t.id > 0);
  assert.equal(db.latestRun().statuses[SOURCE_SCORES24].state, "ok");
});

test("DB: opakované uložení aktualizuje, ale ruční výsledek zůstane", () => {
  const db = memDb();
  db.saveRun(okResult([mk({ probability: 80, odds: 1.7 })]));
  db.setOutcome(db.history()[0].id, "win", "manual");
  db.saveRun(okResult([mk({ probability: 77, odds: 1.65 })]));
  const hist = db.history();
  assert.equal(hist.length, 1);
  assert.deepEqual([hist[0].probability, hist[0].odds, hist[0].outcome, hist[0].outcomeSource], [77, 1.65, "win", "manual"]);
});

test("DB: pohled na poslední běh skryje už nevrácené tipy, historie je drží", () => {
  const db = memDb();
  db.saveRun(okResult([mk(), mk({ home: "A", away: "B", tipCode: "1" })]));
  db.saveRun(okResult([mk()]));
  assert.equal(db.tipsOfLatestRun().length, 1);
  assert.equal(db.history().length, 2);
});

test("DB: smazání výsledku", () => {
  const db = memDb();
  db.saveRun(okResult([mk()]));
  const id = db.history()[0].id;
  db.setOutcome(id, "loss", "manual");
  assert.equal(db.history()[0].outcome, "loss");
  db.setOutcome(id, null);
  const h = db.history()[0];
  assert.deepEqual([h.outcome, h.outcomeSource], [null, null]);
});

test("DB: statistiky (úspěšnost, zisk jen ze skutečných kurzů, push se nepočítá)", () => {
  const db = memDb();
  const tips = [mk({ away: "1", odds: 2.0 }), mk({ away: "2", odds: 1.5 }), mk({ away: "3", odds: 1.8 }), mk({ away: "4", odds: 1.6, oddsEstimated: true })];
  db.saveRun(okResult(tips));
  const by = Object.fromEntries(db.history().map((t) => [t.away, t.id]));
  db.setOutcome(by["1"], "win"); db.setOutcome(by["2"], "loss"); db.setOutcome(by["3"], "void"); db.setOutcome(by["4"], "win");
  const s = db.stats();
  assert.deepEqual([s.total, s.evaluated, s.wins, s.losses, s.voids], [4, 4, 2, 1, 1]);
  assert.ok(Math.abs(s.hitRate - 200 / 3) < 1e-9);
  assert.ok(Math.abs(s.profit - 0) < 1e-9); // +1,0 (kurz 2,0) a −1 (prohra); odhad a push se nepočítají
  assert.ok(Math.abs(s.roiPct - 0) < 1e-9);
});

test("DB: tipy čekající na vyhodnocení jsou jen staré a bez výsledku", () => {
  const db = memDb();
  const old = new Date(Date.now() - 6 * 3600e3);
  const fresh = new Date(Date.now() + 3600e3);
  db.saveRun(okResult([mk({ home: "Old", away: "X", kickoff: old }), mk({ home: "Fresh", away: "Y", kickoff: fresh })]));
  assert.deepEqual(db.pendingResults(new Date(Date.now() - 3 * 3600e3)).map((t) => t.home), ["Old"]);
});

test("DB: klíč tipu je stabilní vůči názvům s diakritikou a zkratkami", () => {
  assert.equal(tipKey(mk({ home: "FC Köln", away: "Atlético" })), tipKey(mk({ home: "Koln", away: "Atletico" })));
});

// --- sloučení Scores24 + Forebet -----------------------------------------------------------------------------------
const fb = (o = {}) => ({
  home: "Nottingham Forest", away: "Arsenal", kickoff: KO, p1: 10, px: 20, p2: 70, pick: "2", odds: {}, leagueKey: null, pickProbability: 70, ...o,
});

test("combine: Forebet doplní pravděpodobnost a shodu", () => {
  const t = combine({ tips: [mk({ tipCode: "2" })], rows: [] }, [fb()], KO)[0];
  assert.equal(t.probForebet, 70);
  assert.deepEqual(t.sources, [SOURCE_SCORES24, SOURCE_FOREBET]);
});
test("combine: nesouhlas Forebetu nemění zdroj, ale ukáže pravděpodobnost (1X = 1 + X)", () => {
  let t = combine({ tips: [mk({ tipCode: "BTTS" })], rows: [] }, [fb()], KO)[0];
  assert.equal(t.probForebet, null);
  assert.deepEqual(t.sources, [SOURCE_SCORES24]);
  t = combine({ tips: [mk({ tipCode: "1X" })], rows: [] }, [fb()], KO)[0];
  assert.equal(t.probForebet, 30);
  assert.deepEqual(t.sources, [SOURCE_SCORES24]);
});
test("combine: vlastní tip Forebetu, když ligu známe z řádku Scores24 (názvy ze Scores24)", () => {
  const row = { href: "/en/soccer/m-x-prediction", url: "https://scores24.live/x", home: "Nottingham Forest", away: "Arsenal FC", timeStr: "15:30", statusToken: "today", leagueKey: "EPL" };
  const tips = combine({ tips: [], rows: [row] }, [fb({ away: "Arsenal", odds: { 2: 1.65 } })], new Date(Date.UTC(2026, 9, 18, 12)));
  assert.equal(tips.length, 1);
  const t = tips[0];
  assert.deepEqual([t.sources, t.probability, t.odds, t.away, t.leagueKey, t.tipCode], [[SOURCE_FOREBET], 70, 1.65, "Arsenal FC", "EPL", "2"]);
});
test("combine: tip Forebetu se zahodí bez ligy nebo pod prahem (přesně 60 % neprojde)", () => {
  assert.deepEqual(combine({ tips: [], rows: [] }, [fb()], KO), []);
  assert.deepEqual(combine({ tips: [], rows: [] }, [fb({ p1: 30, px: 30, p2: 40, leagueKey: "EPL", pickProbability: 40 })], KO), []);
  assert.deepEqual(combine({ tips: [], rows: [] }, [fb({ p1: 20, px: 20, p2: 60, leagueKey: "EPL", pickProbability: 60 })], KO), []);
});
test("combine: Forebet z jiné ligy se nesloučí", () => {
  const t = combine({ tips: [mk({ leagueKey: "EPL" })], rows: [] }, [fb({ leagueKey: "LALIGA" })], KO)[0];
  assert.equal(t.probForebet, null);
});

// --- celý běh se zástupnými zdroji ---------------------------------------------------------------------------------
const TS = Math.floor(KO.getTime() / 1000);
/** HTTP a prohlížeč podle URL – nahradí tři skutečné weby. */
function fakeWeb({ scores24Html, forebetHtml, forebetError, sofaEvents, scores24Error, goalsHtml }) {
  const calls = [];
  const http = {
    async getText(url) {
      calls.push(url);
      if (url.includes("scores24")) { if (scores24Error) throw scores24Error; return scores24Html; }
      if (forebetError) throw forebetError;
      if (url.includes("/football/matches/")) return goalsHtml ?? "<html><body>nic</body></html>";
      return forebetHtml;
    },
    async getJson(url) {
      calls.push(url);
      if (sofaEvents instanceof Error) throw sofaEvents;
      return { events: sofaEvents || [] };
    },
  };
  return { http, browser: { expandScores24: async () => { throw new Error("nemělo být potřeba"); }, loadHtml: async () => "<html></html>" }, calls };
}
const epl = (rows) => s24Page([s24Block("England", "Premier League", "england-premier-league", rows.length, rows)]);

test("Pipeline: filtry, sloučení a obohacení", async () => {
  const web = fakeWeb({
    scores24Html: epl([
      s24Row({ home: "Nottingham Forest", away: "Arsenal", pick: "Arsenal to Win", percent: "80", odds: "1.7" }),
      s24Row({ home: "Low", away: "Prob", percent: "55", odds: "1.9", slug: "l-p", pick: "Both Teams to Score – (Yes)" }),
      s24Row({ home: "Low", away: "Odds", percent: "85", odds: "1.3", slug: "l-o", pick: "Both Teams to Score – (Yes)" }),
    ]),
    forebetHtml: forebetPage([forebetRow({ home: "Nottingham Forest", away: "Arsenal", p: [10, 20, 70], pick: "2" })]),
    sofaEvents: [sofaEvent(7, "Nottingham Forest", "Arsenal", TS, "notstarted")],
  });
  const now = new Date(Date.UTC(2026, 9, 18, 12, 0));
  const r = await new Pipeline(web).run({ now });
  assert.deepEqual(r.tips.map((t) => t.home), ["Nottingham Forest"]); // filtry odstranily dva tipy
  const t = r.tips[0];
  assert.deepEqual([t.sofascoreId, t.probForebet, t.sources], [7, 70, [SOURCE_SCORES24, SOURCE_FOREBET]]);
  assert.deepEqual(Object.values(r.statuses).map((s) => s.state), ["ok", "ok", "ok"]);
  assert.deepEqual(r.warnings, []);
});

const goalsPageHtml = "<html><body><h3>Both teams to score</h3><span>Yes</span><span>62%</span><span>No</span><span>38%</span></body></html>";
const goalsScenario = (goalsHtml) => fakeWeb({
  scores24Html: epl([s24Row({ home: "Nottingham Forest", away: "Arsenal", pick: "Both Teams to Score – (Yes)", percent: "85", odds: "1.9" })]),
  forebetHtml: forebetPage([forebetRow({ home: "Nottingham Forest", away: "Arsenal", p: [10, 20, 70], pick: "2", href: "/en/football/matches/nottingham-forest-arsenal-1" })]),
  goalsHtml, sofaEvents: [],
});

test("Pipeline: pravděpodobnost gólů z Forebetu u BTTS tipu", async () => {
  const web = goalsScenario(goalsPageHtml);
  const r = await new Pipeline(web).run({ now: new Date(Date.UTC(2026, 9, 18, 12)) });
  assert.equal(r.tips[0].tipCode, "BTTS");
  assert.equal(r.tips[0].probForebet, 62);
  assert.equal(r.tips[0].forebetUrl, "https://www.forebet.com/en/football/matches/nottingham-forest-arsenal-1");
  assert.equal(r.statuses[SOURCE_FOREBET].state, "ok");
  assert.match(r.statuses[SOURCE_FOREBET].message, /góly u 1 z 1/);
  assert.ok(web.calls.some((u) => u === "https://www.forebet.com/en/football/matches/nottingham-forest-arsenal-1"));
});

test("Pipeline: stránka zápasu bez gólů → Forebet částečně, tip zůstane bez hodnoty", async () => {
  const r = await new Pipeline(goalsScenario(undefined)).run({ now: new Date(Date.UTC(2026, 9, 18, 12)) });
  assert.equal(r.tips[0].probForebet, null);
  assert.equal(r.statuses[SOURCE_FOREBET].state, "partial");
  assert.ok(r.warnings.some((w) => w.includes("pravděpodobnosti gólů")));
});

const tomorrowWeb = (opts = {}) => fakeWeb({
  scores24Html: epl([s24Row({ home: "Nottingham Forest", away: "Arsenal", status: "tomorrow", percent: null, odds: "1.8" })]),
  forebetHtml: forebetPage([forebetRow({ home: "Nottingham Forest", away: "Arsenal", p: [10, 20, 70], pick: "2" })]),
  sofaEvents: [], ...opts,
});
const DAY_BEFORE = new Date(Date.UTC(2026, 9, 17, 12));

test("Pipeline: zítřejší tip bez procent ze Scores24 dostane pravděpodobnost z Forebetu", async () => {
  const r = await new Pipeline(tomorrowWeb()).run({ now: DAY_BEFORE });
  assert.equal(r.tips.length, 1);
  assert.deepEqual([r.tips[0].probability, r.tips[0].probSource, r.tips[0].sources], [70, SOURCE_FOREBET, [SOURCE_SCORES24, SOURCE_FOREBET]]);
  assert.deepEqual(r.warnings, []);
});

test("Pipeline: zítřejší tip bez procent a bez Forebetu se vynechá", async () => {
  const r = await new Pipeline(tomorrowWeb({ forebetError: new SourceError("Forebet: Cloudflare kontrola neprošla.") })).run({ now: DAY_BEFORE });
  assert.equal(r.tips.length, 0);
  assert.ok(!r.warnings.some((w) => w.includes("procenta")));
});

test("Pipeline: výpadek Forebetu není fatální a objeví se ve varováních", async () => {
  const web = fakeWeb({ scores24Html: epl([s24Row({ home: "Nottingham Forest", away: "Arsenal" })]), forebetError: new SourceError("Forebet: Cloudflare kontrola neprošla."), sofaEvents: [] });
  const r = await new Pipeline(web).run({ now: new Date(Date.UTC(2026, 9, 18, 12)) });
  assert.equal(r.tips.length, 1);
  assert.equal(r.statuses[SOURCE_FOREBET].state, "failed");
  assert.ok(r.warnings.some((w) => w.includes("Cloudflare")));
});

test("Pipeline: bez internetu se ostatní zdroje přeskočí", async () => {
  const web = fakeWeb({ scores24Error: new NetworkError("Nelze se připojit k scores24.live.", true) });
  const r = await new Pipeline(web).run();
  assert.equal(r.offline, true);
  assert.deepEqual(r.tips, []);
  assert.equal(r.statuses[SOURCE_FOREBET].state, "skipped");
  assert.equal(r.statuses.SofaScore.state, "skipped");
  assert.equal(web.calls.length, 1); // nic dalšího se nestahovalo
});

test("Pipeline: neočekávaná chyba parseru neshodí aplikaci", async () => {
  const web = fakeWeb({ scores24Error: new TypeError("rozbitý parser") });
  const r = await new Pipeline(web).run();
  assert.equal(r.statuses[SOURCE_SCORES24].state, "failed");
  assert.match(r.statuses[SOURCE_SCORES24].message, /rozbitý parser/);
});

test("Pipeline: výpadek SofaScore → tipy zůstanou, zdroj je označen jako nedostupný", async () => {
  const web = fakeWeb({ scores24Html: epl([s24Row({ home: "Nottingham Forest", away: "Arsenal" })]), forebetHtml: forebetPage([]), sofaEvents: new SourceError("HTTP 403") });
  const r = await new Pipeline(web).run({ now: new Date(Date.UTC(2026, 9, 18, 12)) });
  assert.equal(r.tips.length, 1);
  assert.equal(r.statuses.SofaScore.state, "failed");
});

// --- automatické vyhodnocení ----------------------------------------------------------------------------------------------
test("updateResults: vyhodnotí jen skončené zápasy a známé trhy, ruční výsledky nechá", async () => {
  const db = memDb();
  const ko = new Date(Date.now() - 5 * 3600e3);
  const ts = Math.floor(ko.getTime() / 1000);
  db.saveRun(okResult([
    mk({ home: "Nottingham Forest", away: "Arsenal", tipCode: "2", kickoff: ko }), mk({ home: "Chelsea", away: "Everton", tipCode: "BTTS", kickoff: ko }),
    mk({ home: "Fulham", away: "Hull City", tipCode: "O2.5", kickoff: ko }), mk({ home: "Leeds", away: "Villa", tipCode: "OTHER:corners", kickoff: ko }),
    mk({ home: "Brentford", away: "Spurs", tipCode: "1", kickoff: ko }),
  ]));
  const manualId = db.history().find((t) => t.home === "Brentford").id;
  db.setOutcome(manualId, "loss", "manual");
  const http = { getJson: async () => ({ events: [
    sofaEvent(1, "Nottingham Forest", "Arsenal", ts, "finished", 0, 2), sofaEvent(2, "Chelsea", "Everton", ts, "finished", 1, 0),
    sofaEvent(3, "Fulham", "Hull City", ts, "inprogress", 1, 1), sofaEvent(4, "Leeds", "Villa", ts, "finished", 1, 1),
    sofaEvent(5, "Brentford", "Spurs", ts, "finished", 3, 0),
  ] }) };
  const { done, message } = await updateResults(db, http);
  const by = Object.fromEntries(db.history().map((t) => [t.home, t]));
  assert.equal(done, 2);
  assert.deepEqual([by["Nottingham Forest"].outcome, by["Nottingham Forest"].outcomeSource], ["win", "auto"]);
  assert.equal(by.Chelsea.outcome, "loss"); // BTTS při 1:0 prohrává
  assert.deepEqual([by.Fulham.outcome, by.Leeds.outcome], [null, null]);
  assert.deepEqual([by.Brentford.outcome, by.Brentford.outcomeSource], ["loss", "manual"]); // ruční výsledek se nepřepsal
  assert.match(message, /Vyhodnoceno 2/);
});

test("updateResults: doplní skóre i tipům, které už mají (ruční) výsledek", async () => {
  const db = memDb();
  const ko = new Date(Date.now() - 5 * 3600e3);
  db.saveRun(okResult([mk({ home: "Brentford", away: "Spurs", tipCode: "1", kickoff: ko })]));
  db.setOutcome(db.history()[0].id, "win", "manual");
  const http = { getJson: async () => ({ events: [sofaEvent(5, "Brentford", "Spurs", Math.floor(ko.getTime() / 1000), "finished", 3, 0)] }) };
  const { done } = await updateResults(db, http);
  const t = db.history()[0];
  assert.deepEqual([done, t.homeScore, t.awayScore, t.outcome, t.outcomeSource, t.status], [0, 3, 0, "win", "manual", "finished"]);
});

test("settleFinished: skončený zápas se známým skóre se vyhodnotí bez sítě", () => {
  const { settleFinished } = require("../src/pipeline");
  const db = memDb();
  db.saveRun(okResult([mk({ home: "A", away: "B", tipCode: "O2.5", status: "finished", homeScore: 3, awayScore: 1, kickoff: new Date(Date.now() - 3 * 3600e3) }),
    mk({ home: "C", away: "D", tipCode: "1", status: "live", homeScore: 1, awayScore: 0 })]));
  assert.equal(settleFinished(db), 1);
  const by = Object.fromEntries(db.history().map((t) => [t.home, t]));
  assert.deepEqual([by.A.outcome, by.A.outcomeSource, by.C.outcome], ["win", "auto", null]);
});

test("updateResults: nedostupný SofaScore se nahlásí", async () => {
  const db = memDb();
  db.saveRun(okResult([mk({ kickoff: new Date(Date.now() - 5 * 3600e3) })]));
  const { done, message } = await updateResults(db, { getJson: async () => { throw new SourceError("HTTP 403"); } });
  assert.equal(done, 0);
  assert.match(message, /nedostupný/);
});

test("updateResults: bez čekajících tipů nic nedělá", async () => {
  const { done, message } = await updateResults(memDb(), { getJson: async () => { throw new Error("nemělo se volat"); } });
  assert.deepEqual([done, message], [0, "Žádné tipy nečekají na vyhodnocení."]);
});

test("Scores24 parse → pipeline: stejný tvar tipu, jaký očekává databáze", () => {
  const html = epl([s24Row({ home: "Arsenal", away: "Chelsea" })]);
  const tip = scores24.parsePage(html, new Date(Date.UTC(2026, 9, 18, 12))).flatMap((b) => b.rows).map((r) => scores24.rowToTip(r, new Date(Date.UTC(2026, 9, 18, 12))))[0];
  const db = memDb();
  db.saveRun(okResult([tip]));
  assert.equal(db.history().length, 1);
});

test("DB: historie podle rozsahu dnů z kalendáře", () => {
  const db = memDb();
  const day = (d) => new Date(Date.UTC(2026, 9, d, 15, 30));
  db.saveRun(okResult([mk({ home: "A", away: "B", kickoff: day(10) }), mk({ home: "C", away: "D", kickoff: day(15) }), mk({ home: "E", away: "F", kickoff: day(20) })]));
  const homes = (a, b) => db.historyRange(a, b).map((t) => t.home).sort();
  assert.deepEqual(homes("2026-10-12", "2026-10-18"), ["C"]);
  assert.deepEqual(homes("2026-10-15", null), ["C", "E"]);
  assert.deepEqual(homes(null, "2026-10-15"), ["A", "C"]);
  assert.deepEqual(homes(null, null), ["A", "C", "E"]);
  const tips = db.historyRange("2026-10-10", "2026-10-10");
  db.setOutcome(tips[0].id, "win", "manual");
  assert.equal(db.stats(null, db.historyRange("2026-10-10", "2026-10-10")).wins, 1);
});

test("DB: starý neznámý trh (OTHER) se převede na nový kód, duplicita se smaže", () => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tipy-")), "t.sqlite3");
  const db = new Database(file);
  const old = (raw) => mk({ home: "Roma", away: "Slovan Bratislava", tipCode: `OTHER:${raw}`, tipLabel: raw, rawLabel: raw });
  db.saveRun(okResult([old("Slovan Bratislava will not score")]));
  db.close();
  let db2 = new Database(file); // při otevření se starý záznam převede
  let t = db2.history();
  assert.deepEqual([t.length, t[0].tipCode, t[0].tipLabel], [1, "AU0.5", "Slovan Bratislava nedá gól"]);
  // duplicita: nový tip už existuje, starý (OTHER) se smaže
  db2.saveRun(okResult([old("Slovan Bratislava will not score"), mk({ home: "Roma", away: "Slovan Bratislava", tipCode: "AU0.5", rawLabel: "Slovan Bratislava will not score" })]));
  db2.close();
  db2 = new Database(file);
  t = db2.history();
  assert.equal(t.filter((x) => x.tipCode === "AU0.5").length, 1);
  assert.equal(t.filter((x) => x.tipCode.startsWith("OTHER:")).length, 0);
  db2.close();
});

// --- úspora dotazů ------------------------------------------------------------------------------------------------
test("Pipeline: stránky gólů se nestahují pro tipy, které filtry stejně zahodí (málo procent / nízký kurz)", async () => {
  const goalsUrl = (n) => `/en/football/matches/team-${n}-1`;
  const web = fakeWeb({
    scores24Html: epl([
      s24Row({ home: "Nottingham Forest", away: "Arsenal", pick: "Both Teams to Score – (Yes)", percent: "85", odds: "1.9" }),
      s24Row({ home: "Low", away: "Prob", percent: "55", odds: "1.9", slug: "l-p", pick: "Both Teams to Score – (Yes)" }),
      s24Row({ home: "Low", away: "Odds", percent: "85", odds: "1.3", slug: "l-o", pick: "Both Teams to Score – (Yes)" }),
    ]),
    forebetHtml: forebetPage([
      forebetRow({ home: "Nottingham Forest", away: "Arsenal", p: [10, 20, 70], pick: "2", href: goalsUrl("a") }),
      forebetRow({ home: "Low", away: "Prob", p: [10, 20, 70], pick: "2", href: goalsUrl("b") }),
      forebetRow({ home: "Low", away: "Odds", p: [10, 20, 70], pick: "2", href: goalsUrl("c") }),
    ]),
    goalsHtml: goalsPageHtml, sofaEvents: [],
  });
  await new Pipeline(web).run({ now: new Date(Date.UTC(2026, 9, 18, 12)) });
  const goalCalls = web.calls.filter((u) => u.includes("/football/matches/"));
  assert.deepEqual(goalCalls, ["https://www.forebet.com/en/football/matches/team-a-1"]);
});

test("Pipeline: pravděpodobnosti gólů z mezipaměti se podruhé nestahují", async () => {
  const { GoalsCache } = require("../src/goalscache");
  const cache = new GoalsCache(null);
  const now = new Date(Date.UTC(2026, 9, 18, 12));
  const first = goalsScenario(goalsPageHtml);
  await new Pipeline({ ...first, goalsCache: cache }).run({ now });
  assert.equal(first.calls.filter((u) => u.includes("/football/matches/")).length, 1);
  const second = goalsScenario(goalsPageHtml);
  const r = await new Pipeline({ ...second, goalsCache: cache }).run({ now });
  assert.equal(second.calls.filter((u) => u.includes("/football/matches/")).length, 0);
  assert.equal(r.tips[0].probForebet, 62);
  assert.match(r.statuses[SOURCE_FOREBET].message, /góly u 1 z 1 zápasů \(1 z mezipaměti\)/);
});

test("Pipeline: zítřejší přehled Forebetu se stahuje, jen když Scores24 nějaký zítřejší zápas má", async () => {
  const todayOnly = fakeWeb({
    scores24Html: epl([s24Row({ home: "Nottingham Forest", away: "Arsenal", percent: "80", odds: "1.7" })]),
    forebetHtml: forebetPage([forebetRow({ home: "Nottingham Forest", away: "Arsenal", p: [10, 20, 70], pick: "2" })]), sofaEvents: [],
  });
  await new Pipeline(todayOnly).run({ now: new Date(Date.UTC(2026, 9, 18, 12)) });
  assert.deepEqual(todayOnly.calls.filter((u) => u.includes("forebet")), ["https://www.forebet.com/en/football-tips-and-predictions-for-today"]);
  const withTomorrow = tomorrowWeb();
  await new Pipeline(withTomorrow).run({ now: DAY_BEFORE });
  assert.equal(withTomorrow.calls.filter((u) => u.includes("forebet")).length, 2);
});
