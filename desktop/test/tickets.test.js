// Tikety: výběr kandidátů, zadání pro AI a kontrola odpovědi.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { candidatesFrom, buildTicketPrompt, parseTickets } = require("../src/tickets");
const { localDate } = require("../src/timeutil");

const NOW = new Date(Date.UTC(2026, 9, 21, 10, 0));
const at = (h, o = {}) => {
  const ko = new Date(NOW.getTime() + h * 3600e3);
  return { home: `D${h}`, away: `H${h}`, matchName: `D${h} – H${h}`, league: "Liga", leagueShort: "Liga", kickoff: ko.toISOString(), day: localDate(ko),
    tipLabel: "Výhra domácích (1)", probability: 80, odds: 1.8, oddsEstimated: false, probForebet: null, status: "upcoming", ...o };
};

test("candidatesFrom: jen nezačaté zápasy se skutečným kurzem v daném dni, seřazené", () => {
  const tips = [at(2), at(3, { probability: 90 }), at(4, { oddsEstimated: true }), at(1, { status: "live" }), at(-1), at(30)];
  const c = candidatesFrom(tips, { day: "today", now: NOW });
  assert.deepEqual(c.map((t) => t.home), ["D3", "D2"]);
  assert.deepEqual(c.map((t) => t.ticketId), ["t1", "t2"]);
  assert.deepEqual(candidatesFrom(tips, { day: "tomorrow", now: NOW }).map((t) => t.home), ["D30"]);
});

test("buildTicketPrompt: obsahuje nabídku a požadavek na počet", () => {
  const c = candidatesFrom([at(2), at(3)], { now: NOW });
  const p = buildTicketPrompt(c, { legs: 2, count: 1, calibration: null });
  assert.ok(p.includes('"id":"t1"') && p.includes("po přesně 2 tipech") && p.includes("Zatím nemám dost"));
});

test("parseTickets: dopočte čísla a zahodí neplatné tikety", () => {
  const c = candidatesFrom([at(2, { odds: 2, probability: 50 }), at(3, { odds: 1.5, probability: 80 }), at(4)], { now: NOW });
  const idOf = (home) => c.find((x) => x.home === home).ticketId;
  const ids = [idOf("D2"), idOf("D3"), idOf("D4")]; // D2: 50 % @ 2,0; D3: 80 % @ 1,5
  const good = { nazev: "A", verdikt: "dobry", shrnuti: "ok", tipy: [{ id: ids[0], verdikt: "rizikovy", komentar: "x" }, { id: ids[1], verdikt: "dobry", komentar: "y" }] };
  const unknown = { nazev: "B", tipy: [{ id: "t99" }, { id: ids[0] }] };
  const dup = { nazev: "C", tipy: [{ id: ids[0] }, { id: ids[0] }] };
  const wrongCount = { nazev: "D", tipy: [{ id: ids[0] }, { id: ids[1] }, { id: ids[2] }] };
  const out = parseTickets("```json\n" + JSON.stringify({ tikety: [good, unknown, dup, wrongCount] }) + "\n```", c, { legs: 2 });
  assert.equal(out.length, 1);
  const t = out[0];
  assert.deepEqual([t.name, t.verdict, t.legs.length], ["A", "good", 2]);
  assert.equal(t.legs[0].verdict, "risky");
  assert.equal(t.totalOdds, 3);          // 2 × 1,5
  assert.equal(t.jointProbability, 40);  // 0,5 × 0,8
  assert.equal(t.expectedReturn, 20);    // 0,4 × 3 − 1
});

test("parseTickets: nevalidní JSON vyhodí chybu", () => {
  assert.throws(() => parseTickets("tohle není json", [], { legs: 2 }), /JSON/);
});
