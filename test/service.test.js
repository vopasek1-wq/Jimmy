// Služba nad databází: doplnění zápasů ze SofaScore při vytváření tiketů.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TipService } = require("../src/service");
const { newResult } = require("../src/models");
const { sofaEvent } = require("./helpers/html");

const TS = Math.floor(Date.UTC(2026, 9, 18, 15, 30) / 1000);
const tipOf = (home, away, o = {}) => ({
  home, away, leagueKey: "EPL", league: "Anglie – Premier League", kickoff: new Date(TS * 1000), tipCode: "1", tipLabel: "Výhra domácích (1)", rawLabel: "", probability: 80, odds: 1.5,
  oddsEstimated: false, sources: ["Scores24"], probForebet: null, status: "upcoming", homeScore: null, awayScore: null, url: "", sofascoreUrl: "", sofascoreId: null, ...o,
});

test("linkSofaScore: tipům bez zápasu na SofaScore si ho aplikace najde sama a uloží, ostatní nechá", async () => {
  const http = { calls: 0, async getJson() { this.calls += 1; return { events: [sofaEvent(77, "Arsenal", "Everton", TS)] }; } };
  const svc = new TipService({ dbFile: ":memory:", http, browser: {} });
  svc.db.saveRun({ ...newResult(new Date()), tips: [tipOf("Arsenal", "Everton"), tipOf("Chelsea", "Fulham", { sofascoreId: 5, sofascoreUrl: "u" })], finishedAt: new Date(), statuses: {} });
  const all = svc.db.tipsOfLatestRun().map((t) => ({ ...t, kickoff: t.kickoff.toISOString() }));
  assert.equal(await svc.linkSofaScore(all), 1);
  assert.equal(all[0].sofascoreId, 77);
  assert.equal(all[1].sofascoreId, 5);                                    // už spárovaný zápas se nehledá znovu
  assert.equal(http.calls, 1);
  assert.equal(svc.db.tipsOfLatestRun().find((t) => t.home === "Arsenal").sofascoreId, 77);   // uloženo i v databázi
  assert.equal(await svc.linkSofaScore(all), 0);                          // podruhé není co hledat a nic se nestahuje
  assert.equal(http.calls, 1);
  svc.close();
});

test("linkSofaScore: výpadek SofaScore není fatální", async () => {
  const http = { async getJson() { throw new Error("síť"); } };
  const svc = new TipService({ dbFile: ":memory:", http, browser: {} });
  svc.db.saveRun({ ...newResult(new Date()), tips: [tipOf("Arsenal", "Everton")], finishedAt: new Date(), statuses: {} });
  const all = svc.db.tipsOfLatestRun().map((t) => ({ ...t, kickoff: t.kickoff.toISOString() }));
  assert.equal(await svc.linkSofaScore(all), 0);
  assert.equal(all[0].sofascoreId ?? null, null);
  svc.close();
});
