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
  assert.equal(ms.length, 1);
  assert.deepEqual(seen, [false]);
  const browserBlocked = { loadHtml: async () => cf };
  await assert.rejects(() => new forebet.ForebetScraper(blockedHttp, browserBlocked).fetch(), /Cloudflare kontrola neprošla.*Ověřit Forebet/);
  // interaktivní režim přeskočí HTTP a rovnou otevře okno
  const httpNever = { getText: async () => { throw new Error("nemělo se volat"); } };
  await new forebet.ForebetScraper(httpNever, browserOk).fetch(() => {}, { interactive: true });
  assert.deepEqual(seen, [false, true]);
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

// Koláče „Recent matches“: značky převzaté z HTML stránky zápasu (div.os_goals_section3_pie_chart, --Over, data-team, data-stat)
const pie = (team, stat, over, vars = `--Over: ${over};`) => `<div style="${vars}" class="os_goals_section3_pie_chart text-fade" data-team="${team}" data-stat="${stat}">
  <span class="os_pie_chart_value __under">${100 - over}%</span><span class="os_pie_chart_value __over">${over}%</span></div>`;
const recentPage = (extra = "") => `<html><body>${[["a", [73, 73, 64, 55]], ["b", [82, 73, 55, 55]]].map(([t, v]) => pie(t, "pc-ov1.5", v[0]) + pie(t, "pc-ov2.5", v[1]) + pie(t, "pc-ov3.5", v[2])
  + `<div style="--Yes: ${v[3]};" class="os_goals_section3_pie_chart" data-team="${t}" data-stat="pc-bts"><span class="__yes">${v[3]}%</span><span class="__no">${100 - v[3]}%</span></div>`).join("")}${extra}</body></html>`;

test("Forebet: koláče posledních zápasů (více než 1,5 / 2,5 / 3,5 gólu a oba skórovali) domácích a hostů", () => {
  const g = parseGoals(recentPage());
  assert.deepEqual(g.recent, { a: { over15: 73, over25: 73, over35: 64, btts: 55 }, b: { over15: 82, over25: 73, over35: 55, btts: 55 } });
  assert.deepEqual(g.over, {});                       // jiné pravděpodobnosti na stránce nejsou, koláče se přesto uloží
});

test("Forebet: koláče bez hodnoty, bez jednoho týmu nebo s doplňkem (No / Under) se nepoužijí", () => {
  assert.equal(parseGoals(`<html><body>${pie("a", "pc-ov1.5", 70)}${pie("a", "pc-ov2.5", 60)}${pie("a", "pc-ov3.5", 50)}</body></html>`), null); // hosté chybí
  const noVar = `<html><body>${["a", "b"].map((t) => ["1.5", "2.5", "3.5"].map((l) => `<div class="os_goals_section3_pie_chart" data-team="${t}" data-stat="pc-ov${l}"></div>`).join("")).join("")}</body></html>`;
  assert.equal(parseGoals(noVar), null);
  const g = parseGoals(recentPage(`<div style="--No: 45;" class="os_goals_section3_pie_chart" data-team="a" data-stat="pc-bts2"></div>`));
  assert.equal(g.recent.a.btts, 55);                  // druhý (nerozpoznaný) koláč s doplňkem No se za „ano“ nebere
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

// --- Forebet: stránky sledovaných lig podle nabídky na přehledu „dnes“ ---------------------------------------------
const menu = (...paths) => `<div class="menu">${paths.map((p) => `<a href="/en/football-tips-and-predictions-for-${p}">${p}</a>`).join("")}</div>`;
const withMenu = (html, ...paths) => html.replace("</body>", `${menu(...paths)}</body>`);
const eplRow = (home, away, p, href) => forebetRow({ home, away, p, pick: "1", href });

test("Forebet: odkazy na ligy z nabídky a výběr stránek sledovaných lig", () => {
  const links = forebet.leagueLinks(withMenu(forebetPage([]), "england/premier-league", "england/championship", "czech-rep/chance-liga", "spain/primera-division", "france/ligue1", "england/premier-league"));
  assert.deepEqual(links.map((l) => l.path), ["england/premier-league", "england/championship", "czech-rep/chance-liga", "spain/primera-division", "france/ligue1"]);
  const t = forebet.leagueTargets(links, ["EPL", "CESKO", "LALIGA", "LIGUE1", "SERIEA", "BELGIE"]);
  const first = (x) => x.candidates[0];
  assert.deepEqual(t.map((x) => [x.key, first(x).from]), [["EPL", "nabídka"], ["CESKO", "nabídka"], ["LALIGA", "nabídka"], ["LIGUE1", "nabídka"], ["SERIEA", "odhad"], ["BELGIE", "odhad"]]);
  assert.equal(first(t[0]).url, "https://www.forebet.com/en/football-tips-and-predictions-for-england/premier-league"); // ne championship
  assert.equal(first(t[3]).path, "france/ligue1");
  assert.equal(first(t[4]).url, "https://www.forebet.com/en/football-tips-and-predictions-for-italy/serie-a");
  assert.equal(t[0].candidates.length, 1);                                                                // z nabídky se nic dalšího nezkouší
  const belgium = t[5].candidates;                                                                         // odhady adres a nakonec stránka celé země
  assert.deepEqual(belgium.map((c) => [c.path, c.from, c.force]), [["belgium/jupiler-pro-league", "odhad", true], ["belgium/pro-league", "odhad", true],
    ["belgium/first-division-a", "odhad", true], ["belgium", "země", false]]);
  assert.deepEqual(forebet.leagueTargets(links, ["NEZNAMA"]), []);
});

test("Forebet: přehled dnes → stránky sledovaných lig, zápasy mají ligu podle stránky", async () => {
  const today = withMenu(forebetPage([eplRow("Tirana", "Vllaznia", [50, 30, 20])], "Alb1"), "england/premier-league", "italy/serie-a");
  const epl = forebetPage([eplRow("Arsenal", "Everton", [60, 25, 15], "/en/football/matches/arsenal-everton-1")], "Zzz");
  const seriea = forebetPage([eplRow("Torino", "Monza", [50, 30, 20], "/en/football/matches/torino-monza-2")], "Zzz");
  const asked = [];
  const http = { getText: async (url) => { asked.push(url); return url.endsWith("for-today") ? today : url.endsWith("premier-league") ? epl : seriea; } };
  const browser = { loadHtml: async () => { throw new Error("okno nemělo být potřeba"); } };
  const scraper = new forebet.ForebetScraper(http, browser);
  const ms = await scraper.fetch(() => {}, { leagues: ["EPL", "SERIEA"] });
  assert.deepEqual(asked.map((u) => u.split("for-").pop()), ["today", "england/premier-league", "italy/serie-a"]);
  assert.deepEqual(ms.map((m) => [m.home, m.leagueKey]), [["Tirana", null], ["Arsenal", "EPL"], ["Torino", "SERIEA"]]);
  const report = scraper.report.join("\n");
  assert.match(report, /for-england\/premier-league.*: HTTP, zápasů 1, ze sledovaných lig 1/);
  assert.match(report, /sledované ligy: EPL=england\/premier-league .*LALIGA=NENALEZENO/);
});

test("Forebet: blokace → zbylé stránky lig se načtou v jednom okně prohlížeče", async () => {
  const { BlockedError } = require("../src/http");
  const today = withMenu(forebetPage([eplRow("Tirana", "Vllaznia", [50, 30, 20])], "Alb1"), "england/premier-league", "italy/serie-a");
  const http = { getText: async () => { throw new BlockedError("403"); } };
  const calls = [];
  const browser = {
    loadHtml: async () => today,
    loadPages: async (urls, opts) => {
      calls.push(urls);
      assert.equal(typeof opts.ready, "function");
      return urls.map((u) => (u.endsWith("serie-a") ? "" : forebetPage([eplRow("Arsenal", "Everton", [60, 25, 15])], "Zzz")));
    },
  };
  const ms = await new forebet.ForebetScraper(http, browser).fetch(() => {}, { leagues: ["EPL", "SERIEA"] });
  assert.equal(calls.length, 1);                      // jedno okno pro obě stránky
  assert.equal(calls[0].length, 2);
  assert.deepEqual(ms.map((m) => [m.home, m.leagueKey]), [["Tirana", null], ["Arsenal", "EPL"]]); // stránka, která se nenačetla, nevadí
});

test("Forebet: bez nabídky lig se použije odhad adresy; chybná stránka ligy ostatní nezahodí", async () => {
  const { SourceError } = require("../src/http");
  const today = forebetPage([eplRow("Tirana", "Vllaznia", [50, 30, 20])], "Alb1");
  const asked = [];
  const http = {
    getText: async (url) => {
      asked.push(url);
      if (url.endsWith("for-today")) return today;
      if (url.endsWith("england/premier-league")) throw new SourceError("HTTP 404");
      return forebetPage([eplRow("Torino", "Monza", [50, 30, 20])], "Zzz");
    },
  };
  const ms = await new forebet.ForebetScraper(http, { loadHtml: async () => today }).fetch(() => {}, { leagues: ["EPL", "SERIEA"] });
  assert.ok(asked.includes("https://www.forebet.com/en/football-tips-and-predictions-for-england/premier-league"));
  assert.deepEqual(ms.map((m) => m.home), ["Tirana", "Torino"]);
});

test("Forebet: když nevyjde ani přehled ani ligy, použije se starý přehled; jinak první chyba", async () => {
  const { SourceError } = require("../src/http");
  const old = forebetPage([eplRow("Torino", "Monza", [50, 30, 20])], "Ita1");
  const http = { getText: async (url) => { if (url.endsWith("football-predictions")) return old; throw new SourceError("HTTP 404"); } };
  const browser = { loadHtml: async () => { throw new Error("okno nemělo být potřeba"); } };
  assert.deepEqual((await new forebet.ForebetScraper(http, browser).fetch()).map((m) => m.home), ["Torino"]);
  await assert.rejects(() => new forebet.ForebetScraper({ getText: async () => { throw new SourceError("HTTP 404"); } }, browser).fetch(), /404/);
});

test("Forebet: ligu poznáme i z onclick znaku ligy", () => {
  const row = '<div class="rcnt"><img onclick="getstag(this,1,\'England\',\'Premier League\',\'england/premier-league\',\'en\')"><span class="shortTag">Zzz</span>'
    + '<span class="homeTeam">A</span><span class="awayTeam">B</span><div class="fprc"><span>50</span><span>30</span><span>20</span></div></div>';
  assert.equal(forebet.parsePage(`<html><body>${row}</body></html>`)[0].leagueKey, "EPL");
});

test("Forebet: liga se pozná i podle odkazu na ligu v řádku a značka se bere z vlastního řádku", () => {
  const row = (tag, href) => `<div class="rcnt tr_0"><div class="shortagDiv"><span class="shortTag">${tag}</span>${href ? `<a href="${href}">liga</a>` : ""}</div>`
    + '<span class="homeTeam">A</span><span class="awayTeam">B</span><time datetime="2026-10-24 15:00:00"></time><div class="fprc"><span>50</span><span>30</span><span>20</span></div></div>';
  const ms = forebet.parsePage(`<html><body>${row("Zzz", "/en/football-tips-and-predictions-for-england/premier-league")}${row("Cze1", "")}${row("Xx9", "")}</body></html>`);
  assert.deepEqual(ms.map((m) => m.leagueKey), ["EPL", "CESKO", null]);
  assert.equal(ms[0].leagueText, "Zzz"); // značka řádku, ne předchozího
});

test("Forebet: liga bez odkazu v nabídce – další odhad adresy, nakonec stránka země s filtrem podle značky", async () => {
  const { SourceError } = require("../src/http");
  const today = forebetPage([eplRow("Tirana", "Vllaznia", [50, 30, 20])], "Alb1");
  const country = forebetPage([eplRow("Kortrijk", "Mechelen", [40, 30, 30], "/en/football/matches/kortrijk-mechelen-1"), eplRow("Lommel", "Beerschot", [30, 30, 40])], "Be1")
    .replace("</body>", `${forebetPage([eplRow("Genk U23", "Anderlecht U23", [30, 30, 40])], "Be2").replace(/^.*<body>|<\/body>.*$/g, "")}</body>`);
  const asked = [];
  const http = {
    getText: async (url) => {
      asked.push(url.split("for-").pop());
      if (url.endsWith("for-today")) return today;
      if (url.endsWith("belgium")) return country;
      throw new SourceError("HTTP 404");
    },
  };
  const ms = await new forebet.ForebetScraper(http, { loadHtml: async () => today }).fetch(() => {}, { leagues: ["BELGIE"] });
  assert.deepEqual(asked, ["today", "belgium/jupiler-pro-league", "belgium/pro-league", "belgium/first-division-a", "belgium"]);
  assert.deepEqual(ms.filter((m) => m.leagueKey).map((m) => [m.home, m.leagueKey]), [["Kortrijk", "BELGIE"], ["Lommel", "BELGIE"]]); // Be2 se nebere
});

test("Forebet: čas zápasu je pražský (letní i zimní), liga i z onclick s předponou adresy", () => {
  const row = (when, onclick) => `<div class="rcnt"><img onclick="${onclick}"><span class="shortTag">Zzz</span><span class="homeTeam">A</span><span class="awayTeam">B</span>`
    + `<time datetime="${when.slice(0, 10)}"><span class="date_bah">${when}</span></time><div class="fprc"><span>50</span><span>30</span><span>20</span></div></div>`;
  const click = "getstag(this,1,'France','Ligue 1','football-tips-and-predictions-for-france/ligue1','fr')";
  const [summer, winter] = forebet.parsePage(`<html><body>${row("23/10/2026 15:00", click)}${row("26/10/2026 15:00", click)}</body></html>`);
  assert.equal(summer.kickoff.toISOString(), "2026-10-23T13:00:00.000Z"); // UTC+2
  assert.equal(winter.kickoff.toISOString(), "2026-10-26T14:00:00.000Z"); // po změně času UTC+1
  assert.equal(summer.leagueKey, "LIGUE1");
});

test("Forebet: stránky lig se stahují po třech najednou; když se objeví ověření, zbylé jdou do okna", async () => {
  const { BlockedError } = require("../src/http");
  const today = withMenu(forebetPage([eplRow("Tirana", "Vllaznia", [50, 30, 20])], "Alb1"), "england/premier-league", "spain/primera-division", "italy/serie-a",
    "germany/bundesliga", "netherlands/eredivisie");
  let running = 0;
  let peak = 0;
  const http = {
    getText: async (url, opts) => {
      if (url.endsWith("for-today")) return today;
      assert.deepEqual(opts.delayMs, [300, 700]);
      running += 1; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      if (url.endsWith("serie-a")) throw new BlockedError("403");
      return forebetPage([eplRow(`H-${url.split("for-").pop()}`, "X", [50, 30, 20])], "Zzz");
    },
  };
  const loaded = [];
  const browser = { loadHtml: async () => today, loadPages: async (urls) => { loaded.push(...urls); return urls.map((u) => forebetPage([eplRow(`B-${u.split("for-").pop()}`, "X", [50, 30, 20])], "Zzz")); } };
  const ms = await new forebet.ForebetScraper(http, browser).fetch(() => {}, { leagues: ["EPL", "LALIGA", "SERIEA", "BUNDESLIGA", "EREDIVISIE"] });
  assert.ok(peak >= 2 && peak <= 3, `souběžně ${peak}`);
  assert.ok(loaded.some((u) => u.endsWith("serie-a")));                         // blokovaná stránka šla do okna
  assert.equal(ms.filter((m) => m.leagueKey).length, 5);                        // všech pět lig má zápas
});

test("Forebet: tip BTTS bez BTTS v mezipaměti stáhne stránku znovu", async () => {
  const { GoalsCache } = require("../src/goalscache");
  const cache = new GoalsCache(null);
  cache.set("https://www.forebet.com/en/football/matches/x-1", { over: { 2.5: 60 }, under: { 2.5: 40 }, btts: {} });
  const page = "<html><body><p>Over 2.5 goals 61%</p><p>Under 2.5 goals 39%</p><p>Both teams to score: something else</p></body></html>";
  let asked = 0;
  const http = { getText: async () => { asked += 1; return page; } };
  const m = { url: "https://www.forebet.com/en/football/matches/x-1", needBtts: true };
  const other = { url: "https://www.forebet.com/en/football/matches/y-2" };
  cache.set(other.url, { over: { 2.5: 55 }, under: {}, btts: {} });
  const sum = await new forebet.ForebetScraper(http, { loadHtml: async () => page }).fetchGoals([m, other], () => {}, { cache });
  assert.equal(asked >= 1, true);
  assert.equal(sum.cached, 1);                                   // jen zápas bez potřeby BTTS zůstal z mezipaměti
  assert.equal(m.goals.over["2.5"], 61);
});

test("Forebet: góly a BTTS z tabulek na skutečné stránce zápasu (text ze zachycené diagnostiky)", () => {
  const html = `<html><body>
    <div>Football Predictions for TODAY 455 &gt; Predictions 1X2 Under/Over 2.5 goals Half Time Half Time/Full Time Both To Score Double chance LIVE predictions 39</div>
    <div>17th place Spain La Liga 16th place &lt; 1X2 Under/Over 2.5 Half Time HT/FT Btts Double Handicap Scorers Corners Cards &gt;</div>
    <table>
    <tr><td>Home team Away team Prob. % 1 X 2 Pred Correct score Avg. goals Weather conditions Coef. Score Live coef. Round 10 Es1 Racing Santander Espanyol 24/10/2026 16:15 41 35 24 1 2 - 1 2 - 1 2.81 15° 2.35</td></tr>
    <tr><td>Home team Away team Prob. % Under/Over 2.5 Pred Correct score Avg. goals Weather conditions Coef. Score Round 10 Es1 Racing Santander Espanyol 24/10/2026 16:15 44 56 Over 2.81 2 - 1 2.81 15° 1.68 2.21 1.68 PRE VIEW</td></tr>
    <tr><td>Home team Away team Prob. % No Yes Pred Correct score Avg. goals Weather conditions Coef. Score Round 10 Es1 Racing Santander Espanyol 24/10/2026 16:15 41 59 Yes 2 - 1 2 - 1 2.81 15° 1.53 1.53 2.37 PRE VIEW</td></tr>
    <tr><td>Home team Away team Prob. % 1X/2X/12 Pred Correct score Round 10 Es1 Racing Santander Espanyol 24/10/2026 16:15 72% 29% 17%</td></tr>
    </table></body></html>`;
  assert.deepEqual(parseGoals(html), { over: { 2.5: 56 }, under: { 2.5: 44 }, btts: { no: 41, yes: 59 } });
  // dvojice, která se nesečte na ≈100, se nebere
  assert.equal(parseGoals(html.replace("44 56 Over", "20 56 Over").replace("41 59 Yes", "10 59 Yes")), null);
});
