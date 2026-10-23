// Parsery Scores24 / Forebet / SofaScore na ukázkových datech ve struktuře živých webů.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const scores24 = require("../src/scrapers/scores24");
const forebet = require("../src/scrapers/forebet");
const sofascore = require("../src/scrapers/sofascore");
const { UPCOMING, LIVE, FINISHED } = require("../src/models");
const { SourceError } = require("../src/http");
const { s24Row, s24Block, s24Page, forebetRow, forebetPage, sofaEvent } = require("./helpers/html");

const NOW = new Date(Date.UTC(2026, 9, 18, 13, 30));
const pageWithEpl = (rows) => s24Page([s24Block("England", "Premier League", "england-premier-league", rows.length, rows)]);
const firstRow = (rows) => scores24.parsePage(pageWithEpl(rows), NOW)[0].rows[0];

// --- Scores24 ---------------------------------------------------------------------------------------
test("Scores24: ligové bloky, ligy a odkazy v menu se nepletou s hlavičkami", () => {
  const html = s24Page([
    s24Block("England", "Premier League", "england-premier-league", 1, [s24Row({ home: "Arsenal", away: "Chelsea" })]),
    s24Block("USA", "MLS", "usa-major-league-soccer", 8, [s24Row({ home: "A", away: "B", slug: "a-b2" })]),
    s24Block("Czech Republic", "1 Liga", "czech-republic-1-liga", 3), // sbalený blok
  ]);
  const blocks = scores24.parsePage(html, NOW);
  assert.deepEqual(blocks.map((b) => b.slug), ["england-premier-league", "usa-major-league-soccer", "czech-republic-1-liga"]);
  assert.deepEqual(blocks.map((b) => (b.league ? b.league.key : null)), ["EPL", null, "CESKO"]);
  assert.deepEqual(blocks.map((b) => b.rows.length), [1, 1, 0]);
  assert.equal(blocks[2].declaredCount, 3); // → scraper ví, že ho má rozbalit
  assert.equal(blocks[0].country, "England");
  assert.equal(blocks[0].name, "Premier League");
});

test("Scores24: pole řádku a procenta bez znaku %", () => {
  const r = firstRow([s24Row({ home: "Real Madrid", away: "Sevilla", time: "19:00", pick: "Both Teams to Score –  (Yes)", percent: "94", odds: "1.85", pctSign: false })]);
  assert.deepEqual([r.home, r.away, r.timeStr, r.statusToken], ["Real Madrid", "Sevilla", "19:00", "today"]);
  assert.equal(r.percent, 94);
  assert.equal(r.odds, 1.85);
  assert.ok(r.pickLabel.includes("Both Teams to Score"));
  assert.equal(r.url, "https://scores24.live/en/soccer/m-17-10-2026-a-b-prediction");
});

test("Scores24: řádek bez procent je kandidát bez pravděpodobnosti", () => {
  const r = firstRow([s24Row({ home: "Spurs", away: "Coventry", percent: null, status: "tomorrow" })]);
  assert.equal(r.percent, null);
  assert.equal(r.odds, 1.71);
  const t = scores24.rowToTip(r, NOW);
  assert.equal(t.probability, null);
  assert.equal(t.probSource, null);
});

test("Scores24: americké kurzy a procenta nad 100", () => {
  assert.equal(firstRow([s24Row({ home: "A", away: "B", odds: "-143" })]).odds, 1.7);
  const r = firstRow([s24Row({ home: "A", away: "B", percent: "101" })]); // živě naměřeno: Scores24 ukázal 101
  assert.equal(r.percent, 100);
  assert.equal(scores24.rowToTip(r, NOW).probability, 100);
});

test("Scores24: číslo vedle času je minuta živého zápasu, ne datum", () => {
  const r = firstRow([s24Row({ home: "A", away: "B", time: "13:00", status: "21", score: ["1", "0"] })]);
  assert.equal(r.homeScore, 1);
  assert.equal(r.awayScore, 0);
  const t = scores24.rowToTip(r, NOW);
  assert.equal(t.status, LIVE);
  assert.equal(t.kickoff.toISOString(), "2026-10-18T13:00:00.000Z");
});

test("Scores24: stavy a datum z today/tomorrow", () => {
  const table = [["today", UPCOMING], ["tomorrow", UPCOMING], ["Ended", FINISHED], ["45", LIVE], ["90+3", LIVE], ["Halftime", LIVE], ["Postponed", null], ["???", null]];
  for (const [token, status] of table) assert.equal(scores24.classifyStatus(token), status, token);
  assert.equal(scores24.kickoffOf({ timeStr: "15:30", statusToken: "today" }, NOW).toISOString(), "2026-10-18T15:30:00.000Z");
  assert.equal(scores24.kickoffOf({ timeStr: "19:00", statusToken: "tomorrow" }, NOW).toISOString(), "2026-10-19T19:00:00.000Z");
});

test("Scores24: tip jen ze sledované ligy", () => {
  const blocks = scores24.parsePage(s24Page([
    s24Block("USA", "MLS", "usa-major-league-soccer", 1, [s24Row({ home: "A", away: "B", pick: "Total goals Over (2,5)" })]),
    s24Block("England", "Premier League", "england-premier-league", 1, [s24Row({ home: "Arsenal", away: "Chelsea", pick: "Arsenal to Win" })]),
  ]), NOW);
  const tips = blocks.flatMap((b) => b.rows).map((r) => scores24.rowToTip(r, NOW));
  assert.equal(tips[0], null); // MLS není ve sledovaných ligách
  assert.deepEqual([tips[1].tipCode, tips[1].leagueKey, tips[1].probability], ["1", "EPL", 86]);
});

test("Scores24: neznámé značky → žádné ligy", () => {
  assert.deepEqual(scores24.parsePage("<html><body><p>nic</p></body></html>", NOW), []);
});

test("Scores24: scraper rozbalí sbalené ligy přes okno prohlížeče", async () => {
  const collapsed = s24Page([
    s24Block("England", "Premier League", "england-premier-league", 1, [s24Row({ home: "Arsenal", away: "Chelsea" })]),
    s24Block("Czech Republic", "1 Liga", "czech-republic-1-liga", 1),
  ]);
  const expanded = s24Page([
    s24Block("England", "Premier League", "england-premier-league", 1, [s24Row({ home: "Arsenal", away: "Chelsea" })]),
    s24Block("Czech Republic", "1 Liga", "czech-republic-1-liga", 1, [s24Row({ home: "Slavia Prague", away: "Sparta Prague", slug: "s-s", pick: "Both Teams to Score – (Yes)", percent: "70" })]),
  ]);
  const calls = [];
  const http = { getText: async () => collapsed };
  const browser = { expandScores24: async (url, slugs) => { calls.push(slugs); return expanded; } };
  const res = await new scores24.Scores24Scraper(http, browser).fetch(NOW);
  assert.deepEqual(calls, [["czech-republic-1-liga"]]);
  assert.deepEqual(res.tips.map((t) => t.leagueKey).sort(), ["CESKO", "EPL"]);
  assert.deepEqual(res.warnings, []);
});

test("Scores24: selhání prohlížeče je jen varování, tipy z HTTP zůstanou", async () => {
  const { BrowserUnavailable } = require("../src/browser");
  const collapsed = s24Page([
    s24Block("England", "Premier League", "england-premier-league", 1, [s24Row({ home: "Arsenal", away: "Chelsea" })]),
    s24Block("Czech Republic", "1 Liga", "czech-republic-1-liga", 1),
  ]);
  const browser = { expandScores24: async () => { throw new BrowserUnavailable("okno nejde otevřít"); } };
  const res = await new scores24.Scores24Scraper({ getText: async () => collapsed }, browser).fetch(NOW);
  assert.equal(res.tips.length, 1);
  assert.match(res.warnings[0], /Česko – 1\. liga.*okno nejde otevřít/);
});

// --- Forebet ------------------------------------------------------------------------------------------------
test("Forebet: řádky, pravděpodobnosti, kurzy a čas", () => {
  const ms = forebet.parsePage(forebetPage([
    forebetRow({ home: "Arsenal", away: "Chelsea", p: [62, 22, 16], pick: "1" }),
    forebetRow({ home: "Everton", away: "Fulham", p: [30, 31, 39], pick: "2", odds: null }),
  ]));
  assert.equal(ms.length, 2);
  const a = ms[0];
  assert.deepEqual([a.home, a.away, a.p1, a.px, a.p2, a.pick], ["Arsenal", "Chelsea", 62, 22, 16, "1"]);
  assert.equal(a.kickoff.toISOString(), "2026-10-18T15:30:00.000Z");
  assert.deepEqual(a.odds, { 1: 1.85, X: 3.4, 2: 4.2 });
  assert.equal(a.pickProbability, 62);
  assert.equal(a.leagueKey, "EPL");
  assert.deepEqual(ms[1].odds, {});
});
test("Forebet: tip bez platné předpovědi se dopočítá z nejvyšší pravděpodobnosti", () => {
  assert.equal(forebet.parsePage(forebetPage([forebetRow({ home: "A", away: "B", p: [20, 25, 55], pick: "?" })]))[0].pick, "2");
});
test("Forebet: vadné řádky a neznámé stránky se přeskočí", () => {
  const ok = forebetRow({ home: "A", away: "B", p: [50, 30, 20], pick: "1" });
  const broken = '<div class="rcnt"><span class="homeTeam">X</span></div>';
  assert.equal(forebet.parsePage(forebetPage([broken, ok])).length, 1);
  assert.deepEqual(forebet.parsePage("<html></html>"), []);
});
test("Forebet: stránka kontroly Cloudflare není hotová stránka", () => {
  assert.equal(forebet.pageReady("<html><head><title>Just a moment...</title></head><body>rcnt</body>"), false);
  assert.equal(forebet.pageReady(forebetPage([forebetRow({ home: "A", away: "B", p: [50, 30, 20], pick: "1" })])), true);
});
test("Forebet: blokace → okno prohlížeče → ověření; bez úspěchu srozumitelná chyba", async () => {
  const { BlockedError } = require("../src/http");
  const cf = "<html><head><title>Just a moment...</title></head></html>";
  const blockedHttp = { getText: async () => { throw new BlockedError("403"); } };
  const seen = [];
  const browserOk = { loadHtml: async (url, opts) => { seen.push(opts.interactive); return forebetPage([forebetRow({ home: "A", away: "B", p: [60, 25, 15], pick: "1" })]); } };
  const ms = await new forebet.ForebetScraper(blockedHttp, browserOk).fetch();
  assert.equal(ms.length, 1);                  // dnešní i zítřejší stránka vrátí tentýž zápas → sloučí se
  assert.deepEqual(seen, [false, false]);
  const browserBlocked = { loadHtml: async () => cf };
  await assert.rejects(() => new forebet.ForebetScraper(blockedHttp, browserBlocked).fetch(), /Cloudflare kontrola neprošla.*Ověřit Forebet/);
  // interaktivní režim přeskočí HTTP a rovnou otevře okno
  const httpNever = { getText: async () => { throw new Error("nemělo se volat"); } };
  await new forebet.ForebetScraper(httpNever, browserOk).fetch(() => {}, { interactive: true });
  assert.deepEqual(seen, [false, false, true]); // ruční ověření jen u první stránky; chyba druhé (HTTP) výsledek první nezahodí
});

// --- SofaScore ------------------------------------------------------------------------------------------------------
const TS = Math.floor(Date.UTC(2026, 9, 18, 15, 30) / 1000);

test("SofaScore: stavy, skóre po 90 minutách a odkaz", () => {
  const evs = sofascore.parseEvents({ events: [
    sofaEvent(1, "A", "B", TS), sofaEvent(2, "C", "D", TS, "inprogress", 1, 0), sofaEvent(3, "E", "F", TS, "finished", 3, 3),
    sofaEvent(4, "G", "H", TS, "postponed"), { broken: true },
  ] });
  assert.deepEqual(evs.map((e) => e.status), [UPCOMING, LIVE, FINISHED, null]);
  assert.equal(evs[3].cancelled, true);
  assert.equal(evs[0].cancelled, false);
  assert.ok(evs[0].url.endsWith("/abc#id:1") && evs[0].url.includes("/cs/football/match/"));
  const et = sofaEvent(9, "A", "B", TS, "finished", 3, 2);
  et.homeScore.normaltime = 1; et.awayScore.normaltime = 1; // po prodloužení: 90 minut skončilo 1:1
  const e = sofascore.parseEvents({ events: [et] })[0];
  assert.deepEqual([e.homeScore, e.awayScore], [1, 1]);
});

const fakeHttp = (payload, error = null) => ({ calls: [], async getJson(url) { this.calls.push(url); if (error) throw error; return payload; } });
const tipAt = (home = "Nottingham Forest", away = "Arsenal", ts = TS) => ({
  home, away, leagueKey: "EPL", league: "x", kickoff: new Date(ts * 1000), tipCode: "2", tipLabel: "2", probability: 80, odds: 1.7, sources: ["Scores24"], sofascoreId: null, sofascoreUrl: "",
});

test("SofaScore: doplní čas, stav a skóre a šetří dotazy (liga + den = jeden)", async () => {
  const http = fakeHttp({ events: [sofaEvent(7, "Nottingham Forest", "Arsenal", TS + 300, "inprogress", 0, 1), sofaEvent(8, "Other", "Team", TS)] });
  const client = new sofascore.SofaScoreClient(http);
  const [t1, t2] = [tipAt(), tipAt()];
  const out = await client.enrich([t1, t2]);
  assert.deepEqual(out, [t1, t2]);
  assert.equal(t1.status, LIVE);
  assert.deepEqual([t1.homeScore, t1.awayScore], [0, 1]);
  assert.equal(t1.kickoff.getTime() / 1000, TS + 300);
  assert.equal(t1.sofascoreId, 7);
  assert.equal(http.calls.length, 1);
  assert.ok(http.calls[0].includes("unique-tournament/17/scheduled-events/2026-10-18"));
});
test("SofaScore: odložený zápas se vyřadí, vzdálené události se nepřiřadí", async () => {
  const http = fakeHttp({ events: [sofaEvent(1, "Nottingham Forest", "Arsenal", TS, "postponed"), sofaEvent(2, "Chelsea", "Everton", TS)] });
  const kept = await new sofascore.SofaScoreClient(http).enrich([tipAt(), tipAt("Chelsea", "Everton", TS + 8 * 3600)]);
  assert.deepEqual(kept.map((t) => t.home), ["Chelsea"]); // druhý zápas je o 8 h dál → nepřiřazen, ale zůstává
  assert.equal(kept[0].sofascoreId, null);
});
test("SofaScore: výpadek není fatální", async () => {
  const client = new sofascore.SofaScoreClient(fakeHttp(null, new SourceError("HTTP 403")));
  const t = tipAt();
  assert.deepEqual(await client.enrich([t]), [t]);
  assert.equal(client.requestsOk, 0);
  assert.deepEqual(client.errors, ["HTTP 403"]);
});

// --- Forebet: pravděpodobnosti gólů na stránce zápasu (struktura NEOVĚŘENÁ – syntetická ukázka) -------------
const { parseGoals } = require("../src/scrapers/forebet");
const { goalsProbability } = require("../src/markets");

const goalsPage = `<html><body><script>var over = "Over 2.5 99 %";</script>
  <div class="prediction"><h3>Over/Under 2.5 goals</h3>
    <div><span>Under 2.5</span><span>43%</span></div><div><span>Over 2.5</span><span class="b">57%</span></div></div>
  <div><span>Over 3.5</span> <span>odds 2.40</span> <span>31 %</span></div>
  <div><h3>Both teams to score</h3><span>Yes</span><span>62%</span><span>No</span><span>38%</span></div>
</body></html>`;

test("Forebet: pravděpodobnosti gólů ze stránky zápasu", () => {
  const g = parseGoals(goalsPage);
  assert.deepEqual(g.over, { "2.5": 57, "3.5": 31 });
  assert.deepEqual(g.under, { "2.5": 43 });
  assert.deepEqual(g.btts, { yes: 62, no: 38 });
});

test("Forebet: stránka bez gólů → null", () => {
  assert.equal(parseGoals("<html><body><p>Nothing here 1.85</p></body></html>"), null);
  assert.equal(parseGoals("<html><body>Over 2.5 odds 1.85</body></html>"), null);
});

test("Forebet: goalsProbability pro BTTS a Over/Under", () => {
  const g = { over: { "2.5": 57 }, under: { "2.5": 43 }, btts: { yes: 62, no: 38 } };
  assert.equal(goalsProbability("O2.5", g), 57);
  assert.equal(goalsProbability("U2.5", g), 43);
  assert.equal(goalsProbability("O3.5", g), null);
  assert.equal(goalsProbability("BTTS", g), 62);
  assert.equal(goalsProbability("NOBTTS", g), 38);
  assert.equal(goalsProbability("BTTS", { btts: { no: 40 } }), 60); // dopočet z druhé strany
  assert.equal(goalsProbability("1", g), null);
  assert.equal(goalsProbability("HO1.5", g), null);
  assert.equal(goalsProbability("BTTS", null), null);
});

test("SofaScore: 404 pro soutěž/den není chyba zdroje", async () => {
  const err = new SourceError("www.sofascore.com vrací HTTP 404 pro /x.");
  err.status = 404;
  const client = new sofascore.SofaScoreClient({ getJson: async () => { throw err; } });
  assert.deepEqual(await client.events(17015, "2026-10-19"), []);
  assert.deepEqual(client.errors, []);
  const other = new SourceError("HTTP 403");
  other.status = 403;
  const bad = new sofascore.SofaScoreClient({ getJson: async () => { throw other; } });
  await bad.events(17, "2026-10-19");
  assert.equal(bad.errors.length, 1);
});

test("Forebet: gólové pravděpodobnosti i bez znaku %, když se dvojice sečte na 100", () => {
  const page = `<html><body><div><span>Over 2.5</span><span>1.85</span><span>58</span></div><div><span>Under 2.5</span><span>1.95</span><span>42</span></div>
    <div><h4>Both teams to score</h4><span>Yes</span><span>61</span><span>No</span><span>39</span></div></body></html>`;
  const g = parseGoals(page);
  assert.deepEqual([g.over["2.5"], g.under["2.5"], g.btts.yes, g.btts.no], [58, 42, 61, 39]);
  // čísla, která nejsou dvojice ≈100, se nepřijmou (např. jen kurzy)
  assert.equal(parseGoals("<body><span>Over 2.5</span><span>12</span><span>Under 2.5</span><span>9</span></body>"), null);
});

// --- Forebet: neúplný seznam (jen první část + „Show more“) --------------------------------------------------------
test("Forebet: tlačítko „Show more“ a značky lig se rozpoznají v diagnostice", () => {
  const more = '<div class="morerows"><span id="mrows" class="mrows_btn">Show more</span></div>';
  const html = forebetPage([forebetRow({ home: "A", away: "B", p: [50, 30, 20], pick: "1" })], "Alb1").replace("</div></body>", `${more}<a href="/en/football-predictions/predictions-1x2/2026-10-24">24</a></div></body>`);
  assert.equal(forebet.hasMoreControl(html), true);
  assert.equal(forebet.hasMoreControl(forebetPage([forebetRow({ home: "A", away: "B", p: [50, 30, 20], pick: "1" })])), false);
  const diag = forebet.listDiagnostics(html);
  assert.match(diag, /Značky lig na stránce \(1\): Alb1:1/);
  assert.match(diag, /Tlačítka „více\/další“: .*mrows_btn.*«Show more»/);
  assert.match(diag, /Odkazy na dny\/ligy: .*2026-10-24/);
});

test("Forebet: seznam bez sledované ligy se doplní rozbalením „Show more“ v okně", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const partial = forebetPage([forebetRow({ home: "Tirana", away: "Vllaznia", p: [50, 30, 20], pick: "1" })], "Alb1")
    .replace("</div></body>", '<span class="mrows_btn">Show more</span></div></body>');
  const full = forebetPage([
    forebetRow({ home: "Tirana", away: "Vllaznia", p: [50, 30, 20], pick: "1" }),
    forebetRow({ home: "Arsenal", away: "Chelsea", p: [60, 25, 15], pick: "1" }),
  ], "Eng1");
  const http = { getText: async () => partial };
  const calls = [];
  const browser = { loadHtml: async (url, opts) => { calls.push(opts); opts.onExpand({ before: 1, after: 2, ms: 1700, clickLog: ["span.mrows_btn «Show more»"] }); return full; } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  const ms = await new forebet.ForebetScraper(http, browser).fetch(() => {}, { debugDir: dir });
  assert.equal(ms.length, 2);
  assert.equal(ms.filter((m) => m.leagueKey).length, 2);
  assert.equal(calls.length, 2);               // dnes + zítra
  assert.match(String(calls[0].expand), /div\.rcnt/);
  const diag = fs.readFileSync(path.join(dir, "forebet-seznam-diagnostika.txt"), "utf8");
  assert.match(diag, /for-today ===\nNačteno přes: okno prohlížeče; zápasů 2, ze sledovaných lig 2/);
  assert.match(diag, /řádků 1 → 2.*span\.mrows_btn «Show more»/);
  assert.equal(fs.existsSync(path.join(dir, "forebet-seznam.html")), false); // sledované ligy tam jsou → HTML netřeba
});

test("Forebet: úplný seznam se sledovanou ligou a bez „Show more“ se nezdržuje oknem prohlížeče", async () => {
  const page = forebetPage([forebetRow({ home: "Arsenal", away: "Chelsea", p: [60, 25, 15], pick: "1" })]);
  const browser = { loadHtml: async () => { throw new Error("okno nemělo být potřeba"); } };
  const ms = await new forebet.ForebetScraper({ getText: async () => page }, browser).fetch();
  assert.equal(ms.length, 1);
});

test("Forebet: když okno selže nebo je zablokované, zůstane aspoň první část seznamu z HTTP", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const partial = forebetPage([forebetRow({ home: "Tirana", away: "Vllaznia", p: [50, 30, 20], pick: "1" })], "Alb1");
  const http = { getText: async () => partial };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  const blocked = { loadHtml: async () => "<html><head><title>Just a moment...</title></head></html>" };
  assert.equal((await new forebet.ForebetScraper(http, blocked).fetch(() => {}, { debugDir: dir })).length, 1);
  assert.match(fs.readFileSync(path.join(dir, "forebet-seznam-diagnostika.txt"), "utf8"), /ze sledovaných lig 0/);
  assert.equal(fs.existsSync(path.join(dir, "forebet-seznam.html")), true); // bez sledované ligy se uloží HTML k ladění
  const broken = { loadHtml: async () => { throw new Error("okno nejde otevřít"); } };
  assert.equal((await new forebet.ForebetScraper(http, broken).fetch()).length, 1);
});

test("Forebet: rozbalení v okně nic nepřidá → použije se delší seznam z HTTP", async () => {
  const partial = forebetPage([forebetRow({ home: "A", away: "B", p: [50, 30, 20], pick: "1" }), forebetRow({ home: "C", away: "D", p: [50, 30, 20], pick: "1" })], "Alb1");
  const smaller = forebetPage([forebetRow({ home: "A", away: "B", p: [50, 30, 20], pick: "1" })], "Alb1");
  const ms = await new forebet.ForebetScraper({ getText: async () => partial }, { loadHtml: async () => smaller }).fetch();
  assert.equal(ms.length, 2);
});

test("Forebet: dnes + zítra se sloučí, zítřejší stránka s chybou nevadí, starý přehled jen jako záloha", async () => {
  const today = forebetPage([forebetRow({ home: "Arsenal", away: "Chelsea", p: [60, 25, 15], pick: "1", href: "/en/football/matches/arsenal-chelsea-1" })], "Eng1");
  const tomorrow = forebetPage([forebetRow({ home: "Everton", away: "Fulham", p: [40, 30, 30], pick: "1", href: "/en/football/matches/everton-fulham-2" })], "Eng1");
  const asked = [];
  const http = {
    getText: async (url) => {
      asked.push(url);
      if (url.endsWith("for-today")) return today;
      if (url.endsWith("for-tomorrow")) return tomorrow;
      throw new Error("záloha neměla být potřeba");
    },
  };
  const browser = { loadHtml: async () => { throw new Error("okno nemělo být potřeba"); } };
  assert.deepEqual((await new forebet.ForebetScraper(http, browser).fetch()).map((m) => m.home), ["Arsenal", "Everton"]);
  assert.equal(asked.length, 2);

  const { SourceError } = require("../src/http");
  const httpTomorrow404 = { getText: async (url) => { if (url.endsWith("for-tomorrow")) throw new SourceError("HTTP 404"); return today; } };
  assert.equal((await new forebet.ForebetScraper(httpTomorrow404, browser).fetch()).length, 1);

  // dnešní přehled nejde → starý přehled jako záloha
  const old = forebetPage([forebetRow({ home: "Torino", away: "Monza", p: [50, 30, 20], pick: "1" })], "Ita1");
  const httpOld = { getText: async (url) => { if (url.endsWith("football-predictions")) return old; throw new SourceError("HTTP 404"); } };
  assert.deepEqual((await new forebet.ForebetScraper(httpOld, browser).fetch()).map((m) => m.home), ["Torino"]);
  // nic nejde → první chyba
  const httpNone = { getText: async () => { throw new SourceError("HTTP 404"); } };
  await assert.rejects(() => new forebet.ForebetScraper(httpNone, browser).fetch(), /404/);
});

test("Forebet: liga se pozná i podle odkazu na ligu v řádku a značka se bere z vlastního řádku", () => {
  const row = (tag, href) => `<div class="rcnt tr_0"><div class="shortagDiv"><span class="shortTag">${tag}</span>${href ? `<a href="${href}">liga</a>` : ""}</div>`
    + '<span class="homeTeam">A</span><span class="awayTeam">B</span><time datetime="2026-10-24 15:00:00"></time><div class="fprc"><span>50</span><span>30</span><span>20</span></div></div>';
  const ms = forebet.parsePage(`<html><body>${row("Zzz", "/en/football-tips-and-predictions-for-england/premier-league")}${row("Cze1", "")}${row("Xx9", "")}</body></html>`);
  assert.deepEqual(ms.map((m) => m.leagueKey), ["EPL", "CESKO", null]);
  assert.equal(ms[0].leagueText, "Zzz"); // značka řádku, ne předchozího
});
