// Uložené tikety: ukládání, vyhodnocení podle výsledků tipů a souhrn.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Database } = require("../src/database");
const { settleTicket, ticketStats } = require("../src/tickets");
const { newResult } = require("../src/models");

const KO = new Date(Date.UTC(2026, 9, 23, 15, 0));
const tipOf = (home, o = {}) => ({
  home, away: "B", leagueKey: "EPL", league: "Liga", kickoff: KO, tipCode: "1", tipLabel: "Výhra domácích (1)", rawLabel: "", probability: 80, odds: 1.5,
  oddsEstimated: false, sources: ["Scores24"], probForebet: null, status: "upcoming", homeScore: null, awayScore: null, url: "", sofascoreUrl: "", sofascoreId: null, ...o,
});
const leg = (tipId, odds = 1.5) => ({ id: `t${tipId}`, tipId, matchName: `M${tipId}`, league: "Liga", kickoff: KO.toISOString(), tipLabel: "x", odds, probability: 80, value: 5 });
const ticket = (legs, o = {}) => ({ name: "Tiket 1", verdict: "good", summary: "ok", legs, totalOdds: 2.25, jointProbability: 64, ...o });

test("settleTicket: prohra, čekání, výhra a vrácený tip", () => {
  const t = ticket([leg(1, 1.5), leg(2, 2), leg(3, 1.2)]);
  const o = (a, b, c) => new Map([[1, a], [2, b], [3, c]].filter(([, v]) => v));
  assert.deepEqual([settleTicket(t, o("win", "loss", null)).status, settleTicket(t, o("win", "loss", null)).profit], ["loss", -1]);   // prohra platí hned
  assert.deepEqual([settleTicket(t, o("win", "win", null)).status, settleTicket(t, o("win", "win", null)).profit], ["pending", null]);
  const win = settleTicket(t, o("win", "win", "win"));
  assert.deepEqual([win.status, win.effectiveOdds, Math.round(win.profit * 100) / 100], ["win", 3.6, 2.6]);
  const voidLeg = settleTicket(t, o("win", "void", "win"));
  assert.deepEqual([voidLeg.status, voidLeg.effectiveOdds], ["win", 1.8]);                  // vrácený tip se z kurzu vyjme
  assert.deepEqual([settleTicket(t, o("void", "void", "void")).status, settleTicket(t, o("void", "void", "void")).profit], ["void", 0]);
  assert.equal(win.legs[0].outcome, "win");
});

test("ticketStats: úspěšnost, odhad, rozdíl a ROI z vyhodnocených tiketů", () => {
  const mk = (status, profit, joint = 60) => ({ status, profit, jointProbability: joint });
  const s = ticketStats([mk("win", 2.6), mk("loss", -1, 50), mk("loss", -1), mk("pending", null), mk("void", 0)]);
  assert.deepEqual(s, { n: 3, wins: 1, pending: 1, predicted: 56.7, actual: 33.3, gap: -23.4, roi: 20, });
  assert.deepEqual(ticketStats([mk("pending", null)]), { n: 0, wins: 0, pending: 1, predicted: null, actual: null, gap: null, roi: null });
});

test("DB: ukládání tiketů (bez duplicit), seznam a výsledky tipů", () => {
  const db = new Database(":memory:");
  const run = { ...newResult(new Date()), tips: [tipOf("A"), tipOf("C"), tipOf("D")], finishedAt: new Date(), statuses: {} };
  db.saveRun(run);
  const ids = db.tipsOfLatestRun().map((t) => t.id);
  const t = ticket([leg(ids[0]), leg(ids[1])]);
  assert.equal(db.saveTicket(t), true);
  assert.equal(db.saveTicket({ ...t, legs: [...t.legs].reverse() }), false);   // stejná sada tipů ve stejný den
  assert.equal(db.saveTicket(ticket([leg(ids[0]), leg(ids[2])], { name: "Tiket 2" })), true);
  const list = db.listTickets();
  assert.deepEqual(list.map((x) => x.name), ["Tiket 2", "Tiket 1"]);
  assert.equal(list[1].legs.length, 2);
  assert.equal(db.listTickets(1).length, 1);
  db.setOutcome(ids[0], "win");
  db.setOutcome(ids[1], "loss");
  const outcomes = db.outcomesByIds(ids);
  assert.deepEqual([...outcomes], [[ids[0], "win"], [ids[1], "loss"]]);
  assert.equal(settleTicket(list[1], outcomes).status, "loss");
  assert.equal(settleTicket(list[0], outcomes).status, "pending");
  db.close();
});

const { dueKickoffs } = require("../src/tickets");

test("dueKickoffs: jen čekající zápasy do 15 minut, jednou na zápas, ne z prohraných tiketů", () => {
  const now = new Date(Date.UTC(2026, 9, 23, 12, 0));
  const at = (min) => new Date(now.getTime() + min * 60000).toISOString();
  const tk = (id, ...legs) => ({ id, name: `Tiket ${id}`, legs });
  const l = (tipId, min) => ({ tipId, matchName: `M${tipId}`, kickoff: at(min) });
  const tickets = [tk(1, l(1, 10), l(2, 40)), tk(2, l(3, 5), l(4, -5)), tk(3, l(5, 12), l(6, 8))];
  const notified = new Set();
  const outcomes = new Map([[6, "loss"], [3, "win"]]);                 // tiket 3 je prohraný, zápas 3 už má výsledek
  assert.deepEqual(dueKickoffs(tickets, outcomes, now, notified).map((k) => [k.matchName, k.minutes]), [["M1", 10]]);
  assert.deepEqual(dueKickoffs(tickets, outcomes, now, notified), []);   // podruhé už ne
  const later = new Date(now.getTime() + 30 * 60000);
  assert.deepEqual(dueKickoffs(tickets, outcomes, later, notified).map((k) => k.matchName), ["M2"]);
});
