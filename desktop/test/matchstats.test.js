// Statistiky zápasů ze SofaScore pro tikety (ukázková data ve tvaru API) a jejich stahování.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MatchStats, finishedEvents, teamForm, h2hFromEvents, h2hFromDuel, missingFrom, buildStats } = require("../src/matchstats");
const { SourceError, BlockedError } = require("../src/http");

const T0 = Date.UTC(2025, 2, 12, 12) / 1000; // 12. 3. 2025
const day = (n) => T0 + n * 86400;
/** Odehraný zápas ve tvaru SofaScore: domácí [id, jméno], hosté [id, jméno], skóre. */
const ev = (home, away, hs, as, ts, o = {}) => ({
  id: ts, startTimestamp: ts, status: { type: "finished" }, homeTeam: { id: home[0], name: home[1] }, awayTeam: { id: away[0], name: away[1] },
  homeScore: { current: hs, normaltime: hs }, awayScore: { current: as, normaltime: as }, tournament: { name: "Liga" }, ...o,
});
const A = [1, "A"];
const B = [2, "B"];
const aEvents = () => ({ events: [
  ev(A, [9, "R"], 4, 0, day(1)), ev(A, [8, "Q"], 2, 2, day(2)),
  ev([7, "W"], A, 0, 3, day(3)), ev(A, [6, "Z"], 0, 1, day(4)), ev([5, "Y"], A, 1, 1, day(5)), ev(A, [4, "X"], 2, 0, day(6)),
  ev(A, [3, "budoucí"], 0, 0, day(7), { status: { type: "notstarted" } }),     // neodehraný se nepočítá
  ev(A, [3, "zrušený"], null, null, day(8), { status: { type: "canceled" } }),
] });

test("finishedEvents: jen odehrané se skóre, nejnovější první; po 90 minutách", () => {
  const list = finishedEvents({ events: [
    ev(A, B, 1, 0, day(1)), ev(A, B, 2, 2, day(3), { homeScore: { current: 3, normaltime: 2 }, awayScore: { current: 2, normaltime: 2 } }),
    ev(A, B, 0, 0, day(2), { status: { type: "inprogress" } }), { rozbitý: true },
  ] });
  assert.deepEqual(list.map((e) => [e.ts, e.hs, e.as]), [[day(3), 2, 2], [day(1), 1, 0]]);
});

test("finishedEvents: událost bez údaje o stavu, ale se skóre, se bere jako odehraná", () => {
  const noStatus = ev(A, B, 1, 0, day(1));
  delete noStatus.status;
  assert.equal(finishedEvents({ events: [noStatus, ev(A, B, null, null, day(2), { status: { type: "canceled" } })] }).length, 1);
});

test("teamForm: forma, góly, domácí a venkovní výkonnost", () => {
  const f = teamForm(aEvents(), 1);
  assert.equal(f.forma, "V R P V R");                     // posledních 5, nejnovější první
  assert.equal(f.posledni[0], "V 2:0 doma s X");
  assert.equal(f.posledni[1], "R 1:1 venku s Y");
  assert.deepEqual(f.goly, { zapasu: 6, dal: 2, obdrzel: 0.7 });
  assert.deepEqual(f.doma, { zapasu: 4, V: 2, R: 1, P: 1, dal: 2, obdrzel: 0.8 });
  assert.deepEqual(f.venku, { zapasu: 2, V: 1, R: 1, P: 0, dal: 2, obdrzel: 0.5 });
  assert.equal(teamForm({ events: [] }, 1), null);
  assert.equal(teamForm(null, 1), null);
});

test("teamForm: série gólů (více než 1,5 / 2,5 / 3,5 a oba skórovali) z posledních zápasů", () => {
  assert.deepEqual(teamForm(aEvents(), 1).serie, { zapasu: 6, over15: 5, over25: 3, over35: 2, btts: 2 });
  const many = { events: Array.from({ length: 15 }, (_, i) => ev(A, B, 1, 1, day(i + 1))) };
  assert.deepEqual(teamForm(many, 1).serie, { zapasu: 11, over15: 11, over25: 0, over35: 0, btts: 11 }); // jen posledních 11
});

test("buildStats: koláče pro detail tipu (charts) nejdou do podkladů pro AI", () => {
  const r = buildStats({ homeLast: aEvents(), awayLast: aEvents(), homeId: 1, awayId: 1, h2h: null, missing: null });
  assert.equal(r.charts.home.zapasu, 6);
  assert.equal(JSON.stringify(r.stats).includes("over15"), false);
});

test("h2h: seznam zápasů z pohledu domácího týmu, záložní počty výher", () => {
  const h = h2hFromEvents({ events: [ev(A, B, 2, 1, day(3)), ev(B, A, 1, 1, day(2)), ev(B, A, 3, 0, day(1)), ev(A, [9, "cizí"], 5, 0, day(4))] }, 1, 2);
  assert.deepEqual([h.zapasu, h.domaci_vyhry, h.remizy, h.hoste_vyhry, h.goly_na_zapas, h.oba_skorovaly], [3, 1, 1, 1, 2.7, 2]);
  assert.match(h.posledni[0], /^\d+\. \d+\. 2025 A 2:1 B$/);
  assert.deepEqual(h2hFromEvents({ events: [] }, 1, 2), { zapasu: 0 });
  assert.equal(h2hFromEvents(null, 1, 2), null);
  assert.deepEqual(h2hFromDuel({ teamDuel: { homeWins: 3, awayWins: 1, draws: 2 } }), { zapasu: 6, domaci_vyhry: 3, remizy: 2, hoste_vyhry: 1 });
  assert.equal(h2hFromDuel({}), null);
});

test("zranění: chybějící a pochybní hráči, česky", () => {
  const m = missingFrom({ confirmed: false, home: { missingPlayers: [{ player: { name: "Jan Novák", shortName: "J. Novák", position: "D" }, type: "missing" }, { player: { name: "Karel" }, type: "doubtful" }] }, away: {} });
  assert.deepEqual(m, { domaci: ["J. Novák (obránce) – chybí", "Karel – pochybný"], hoste: [] });
  assert.equal(missingFrom(null), null);
  assert.equal(missingFrom({}), null);
});

test("buildStats: kompletní jen se známou formou obou týmů", () => {
  const full = buildStats({ homeLast: aEvents(), awayLast: { events: [ev(B, [9, "Z"], 1, 0, day(1))] }, homeId: 1, awayId: 2, h2h: { zapasu: 0 }, missing: null });
  assert.equal(full.complete, true);
  assert.deepEqual(Object.keys(full.stats), ["forma_domaci", "forma_hoste", "h2h"]);
  const partial = buildStats({ homeLast: aEvents(), awayLast: null, homeId: 1, awayId: 2, h2h: null, missing: null });
  assert.equal(partial.complete, false);
});

/** Napodobený HttpClient: odpovědi podle cesty; chybějící cesta = 404. */
function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    async getJson(url, opts) {
      const p = new URL(url).pathname.replace("/api/v1", "");
      calls.push({ path: p, opts });
      const r = routes[p];
      if (r instanceof Error) throw r;
      if (r === undefined) { const e = new SourceError(`HTTP 404 pro ${p}`); e.status = 404; throw e; }
      return r;
    },
  };
}
const routes101 = () => ({
  "/event/101": { event: { id: 101, customId: "abcD", homeTeam: { id: 1, name: "A" }, awayTeam: { id: 2, name: "B" } } },
  "/team/1/events/last/0": aEvents(),
  "/team/2/events/last/0": { events: [ev(B, [9, "Z"], 1, 0, day(1)), ev([8, "Y"], B, 2, 2, day(2))] },
  "/event/abcD/h2h/events": { events: [ev(A, B, 2, 1, day(3))] },
  "/event/101/lineups": { home: { missingPlayers: [{ player: { name: "Jan", position: "G" }, type: "missing" }] }, away: { missingPlayers: [] } },
});
const cand = (ticketId, sofascoreId, name = ticketId) => ({ ticketId, sofascoreId, matchName: name });

test("MatchStats.collect: stahuje zápas jednou i při dvou tipech, nepoužitelné zápasy vynechá", async () => {
  const http = fakeHttp({ ...routes101() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-"));
  const progress = [];
  const out = await new MatchStats(http, { debugDir: dir, delayMs: [0, 0] }).collect(
    [cand("t1", 101, "A – B"), cand("t2", 101, "A – B"), cand("t3", 102, "C – D"), cand("t4", null, "E – F")], (m) => progress.push(m));
  assert.deepEqual([out.covered, out.total, out.noId, out.blocked], [2, 4, 1, false]);
  assert.deepEqual(Object.keys(out.stats), ["t1", "t2"]);
  assert.equal(out.stats.t1, out.stats.t2);
  assert.equal(out.stats.t1.forma_domaci.forma, "V R P V R");
  assert.equal(out.stats.t1.forma_hoste.forma, "R V");
  assert.equal(out.stats.t1.h2h.zapasu, 1);
  assert.deepEqual(out.stats.t1.zraneni, { domaci: ["Jan (brankář) – chybí"], hoste: [] });
  const paths = http.calls.map((c) => c.path).sort();
  assert.deepEqual(paths, ["/event/101", "/event/101/lineups", "/event/102", "/event/abcD/h2h/events", "/team/1/events/last/0", "/team/2/events/last/0"]);
  assert.deepEqual(http.calls[0].opts.delayMs, [0, 0]);
  assert.match(http.calls[0].opts.headers.Referer, /sofascore\.com/);
  assert.ok(progress.some((m) => /\(2\/2\)/.test(m)));
  const diag = fs.readFileSync(path.join(dir, "tikety-statistiky.txt"), "utf8");
  assert.match(diag, /t1 A – B \| SofaScore ID 101 \| OK/);
  assert.match(diag, /t3 C – D \| SofaScore ID 102 \| NEÚPLNÉ \{"event":"404"\}/);
  assert.match(diag, /t4 E – F \| SofaScore ID chybí/);
  assert.match(diag, /--- event ---/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("MatchStats.collect: H2H se při chybě seznamu doplní počty, chybějící sestavy nevadí", async () => {
  const r = routes101();
  delete r["/event/abcD/h2h/events"];
  delete r["/event/101/lineups"];
  r["/event/101/h2h"] = { teamDuel: { homeWins: 2, awayWins: 1, draws: 1 } };
  const out = await new MatchStats(fakeHttp(r), { delayMs: [0, 0] }).collect([cand("t1", 101)]);
  assert.equal(out.covered, 1);
  assert.deepEqual(out.stats.t1.h2h, { zapasu: 4, domaci_vyhry: 2, remizy: 1, hoste_vyhry: 1 });
  assert.equal(out.stats.t1.zraneni, undefined);
});

test("MatchStats.collect: SofaScore blokuje → po třech zamítnutích se přestane", async () => {
  const blocked = new BlockedError("www.sofascore.com požaduje ověření (ochrana proti robotům, HTTP 403).");
  const http = fakeHttp({ "/event/1": blocked, "/event/2": blocked, "/event/3": blocked, "/event/4": blocked, "/event/5": blocked, "/event/6": blocked });
  const out = await new MatchStats(http, { delayMs: [0, 0] }).collect([1, 2, 3, 4, 5, 6].map((i) => cand(`t${i}`, i)));
  assert.deepEqual([out.blocked, out.covered], [true, 0]);
  assert.ok(http.calls.length >= 3 && http.calls.length < 6, `dotazů: ${http.calls.length}`);
});

test("MatchStats.collect: když chybí seznam posledních zápasů, použije se přehled výkonnosti týmu", async () => {
  const r = routes101();
  r["/team/1/events/last/0"] = { events: [] };
  delete r["/team/2/events/last/0"];                       // 404
  r["/team/1/performance"] = aEvents();
  r["/team/2/performance"] = { events: [ev(B, [9, "Z"], 1, 0, day(1))] };
  const http = fakeHttp(r);
  const out = await new MatchStats(http, { delayMs: [0, 0] }).collect([cand("t1", 101)]);
  assert.equal(out.covered, 1);
  assert.equal(out.stats.t1.forma_domaci.forma, "V R P V R");
  assert.ok(http.calls.some((c) => c.path === "/team/2/performance"));
});

test("MatchStats.collect: bez seznamu H2H i počtů se použijí setkání z posledních zápasů domácího týmu", async () => {
  const r = routes101();
  delete r["/event/abcD/h2h/events"];
  r["/team/1/events/last/0"] = { events: [...aEvents().events, ev(A, B, 3, 1, day(9))] };   // domácí tým hrál nedávno proti B
  const out = await new MatchStats(fakeHttp(r), { delayMs: [0, 0] }).collect([cand("t1", 101)]);
  assert.deepEqual([out.stats.t1.h2h.zapasu, out.stats.t1.h2h.domaci_vyhry], [1, 1]);
  assert.match(out.stats.t1.h2h.poznamka, /jen setkání z posledních zápasů/);
});

test("MatchStats.collect: úplné statistiky se na 30 minut uloží do mezipaměti a znovu se nestahují", async () => {
  const cache = new Map();
  let t = 1_000_000;
  const http1 = fakeHttp({ ...routes101() });
  const first = await new MatchStats(http1, { delayMs: [0, 0], cache, now: () => t }).collect([cand("t1", 101), cand("t3", 102)]);
  assert.equal(first.covered, 1);
  assert.equal(cache.size, 1);                       // neúplný zápas 102 se neukládá
  const http2 = fakeHttp({ ...routes101() });
  const second = await new MatchStats(http2, { delayMs: [0, 0], cache, now: () => t + 10 * 60 * 1000 }).collect([cand("t1", 101)]);
  assert.equal(http2.calls.length, 0);
  assert.equal(second.stats.t1.forma_domaci.forma, "V R P V R");
  const http3 = fakeHttp({ ...routes101() });
  await new MatchStats(http3, { delayMs: [0, 0], cache, now: () => t + 31 * 60 * 1000 }).collect([cand("t1", 101)]);
  assert.ok(http3.calls.length > 0);                 // po půl hodině se stahuje znovu
});

test("MatchStats.detail: statistiky jednoho zápasu pro detail tipu, úplné se pamatují (mezipaměť sdílená s tikety)", async () => {
  const cache = new Map();
  let t = 5_000_000;
  const http1 = fakeHttp({ ...routes101() });
  const first = await new MatchStats(http1, { delayMs: [0, 0], cache, now: () => t }).detail(101);
  assert.equal(first.complete, true);
  assert.equal(first.stats.forma_domaci.forma, "V R P V R");
  assert.ok(http1.calls.length > 0);
  const http2 = fakeHttp({ ...routes101() });
  const second = await new MatchStats(http2, { delayMs: [0, 0], cache, now: () => t + 60_000 }).detail(101);
  assert.equal(http2.calls.length, 0);
  assert.equal(second, first);
  const bad = await new MatchStats(fakeHttp({ ...routes101() }), { delayMs: [0, 0], cache, now: () => t }).detail(102); // neúplné se neukládá
  assert.equal(bad.complete, false);
  assert.equal(cache.has(102), false);
});
