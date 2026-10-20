// Živé zápasy ze SofaScore: seznam, minuty a podrobnosti (ukázková data ve tvaru API).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { LiveClient, parseLive, parseGraph, parseShots, parseIncidents, parseStats, minuteText } = require("../src/live");
const { SourceError } = require("../src/http");

const ev = (o = {}) => ({
  id: 1, slug: "a-b", customId: "xYz", status: { type: "inprogress", description: "2nd half" },
  tournament: { name: "Premier League", category: { name: "England" }, uniqueTournament: { id: 17 } },
  homeTeam: { name: "A" }, awayTeam: { name: "B" }, homeScore: { current: 1 }, awayScore: { current: 0 },
  time: { currentPeriodStartTimestamp: 10_000, initial: 2700, max: 5400 }, ...o,
});

test("Live: minuta podle hodin periody", () => {
  assert.equal(minuteText(ev(), 10_000 + 17 * 60), "63'");
  assert.equal(minuteText(ev(), 10_000 + 46 * 60), "90+2'");
  assert.equal(minuteText(ev({ status: { type: "inprogress", description: "Halftime" } }), 10_000), "Poločas");
  assert.equal(minuteText(ev({ time: { currentPeriodStartTimestamp: 10_000, initial: 0, max: 2700 } }), 10_000 + 5 * 60), "6'");
});

test("Live: seznam – jen rozehrané zápasy, sledované soutěže první", () => {
  const list = parseLive({ events: [
    ev({ id: 2, tournament: { name: "Liga X", category: { name: "Zeme" }, uniqueTournament: { id: 99999 } } }),
    ev({ id: 3, status: { type: "finished", description: "Ended" } }),
    ev({ id: 4 }),
    { id: "rozbitý" },
  ] }, 10_000);
  assert.deepEqual(list.map((m) => [m.id, m.tracked]), [[4, true], [2, false]]);
  assert.deepEqual([list[0].homeScore, list[0].awayScore, list[0].minute], [1, 0, "46'"]);
  assert.equal(list[0].title, "Anglie – Premier League"); // sledovaná soutěž česky z configu
  assert.equal(minuteText(ev({ status: { type: "inprogress", description: "Started" }, time: {} }), 0), "Začal");
  assert.match(list[0].url, /sofascore\.com\/cs\/football\/match\/a-b\/xYz#id:4$/);
});

test("Live: momentum, střely, branky a statistiky", () => {
  assert.deepEqual(parseGraph({ graphPoints: [{ minute: 1, value: -7 }, { minute: 2, value: 12 }, { minute: "x", value: 1 }] }), [{ m: 1, v: -7 }, { m: 2, v: 12 }]);
  const shots = parseShots({ shotmap: [{ isHome: true, shotType: "goal", playerCoordinates: { x: 8, y: 50 }, xg: 0.3, time: 12, player: { shortName: "J. Novák" } }, { isHome: false }] });
  assert.deepEqual(shots, [{ home: true, x: 8, y: 50, type: "goal", xg: 0.3, minute: 12, player: "J. Novák" }]);
  const inc = parseIncidents({ incidents: [
    { incidentType: "card", incidentClass: "yellow", time: 30, isHome: false, player: { shortName: "P" } },
    { incidentType: "goal", incidentClass: "regular", time: 12, isHome: true, player: { shortName: "J. Novák" }, homeScore: 1, awayScore: 0 },
    { incidentType: "period", time: 45 },
  ] });
  assert.deepEqual(inc.map((i) => [i.kind, i.minute, i.home]), [["goal", 12, true], ["yellow", 30, false]]);
  const stats = parseStats({ statistics: [{ period: "ALL", groups: [{ statisticsItems: [{ key: "ballPossession", home: "60%", away: "40%", homeValue: 60, awayValue: 40 }, { key: "neznámé", home: "1", away: "2" }] }] }] });
  assert.deepEqual(stats.map((s) => [s.label, s.homeValue]), [["Držení míče", 60]]);
});

test("Live: detail zvládne chybějící část, ale ne úplný výpadek", async () => {
  const part = new LiveClient({ getJson: async (url) => { if (url.endsWith("/shotmap")) throw new SourceError("HTTP 404"); return url.endsWith("/graph") ? { graphPoints: [{ minute: 1, value: 3 }] } : {}; } });
  const d = await part.detail(5);
  assert.deepEqual([d.graph.length, d.shots.length, d.incidents.length], [1, 0, 0]);
  const none = new LiveClient({ getJson: async () => { throw new SourceError("HTTP 403"); } });
  await assert.rejects(() => none.detail(5), /nepodařilo načíst/);
});
