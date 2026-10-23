// Bankroll: průběh při stálém vkladu a Kellyho vklad.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { betsFromTips, betsFromTickets, simulate, kellyStake, normalizeSettings } = require("../src/bankroll");

const tip = (day, outcome, odds, extra = {}) => ({ kickoff: `2026-10-${day}T15:00:00.000Z`, outcome, odds, oddsEstimated: false, ...extra });

test("Bankroll: jen vyhodnocené tipy se skutečným kurzem", () => {
  const bets = betsFromTips([
    tip("10", "win", 2), tip("11", "loss", 1.8), tip("12", "void", 1.5), tip("13", null, 1.9),
    tip("14", "win", 1.5, { oddsEstimated: true }), tip("15", "win", null),
  ]);
  assert.deepEqual(bets.map((b) => b.unit), [1, -1]);
});

test("Bankroll: průběh, zisk, ROI, propad a série proher", () => {
  const bets = betsFromTips([tip("10", "win", 2), tip("11", "loss", 2), tip("12", "loss", 2), tip("13", "loss", 2), tip("14", "win", 3)]);
  const r = simulate(bets, { start: 1000, stake: 100 });
  // +100, −100, −100, −100, +200 → 1000 → 1100 → 1000 → 900 → 800 → 1000
  assert.equal(r.current, 1000);
  assert.equal(r.profit, 0);
  assert.equal(r.staked, 500);
  assert.equal(r.roi, 0);
  assert.equal(r.bets, 5);
  assert.equal(r.wins, 2);
  assert.equal(r.maxDrawdown, 300);
  assert.equal(r.longestLosing, 3);
  assert.deepEqual(r.series.map((p) => p[1]), [1000, 1100, 1000, 900, 800, 1000]);
  assert.ok(r.series[0][0] < r.series[1][0]); // výchozí bod je před první sázkou
});

test("Bankroll: pořadí sázek podle času, ne podle vstupu; bez sázek prázdný průběh", () => {
  const r = simulate(betsFromTips([tip("12", "loss", 2), tip("10", "win", 2)]), { start: 500, stake: 50 });
  assert.deepEqual(r.series.map((p) => p[1]), [500, 550, 500]);
  const none = simulate([], { start: 500, stake: 50 });
  assert.deepEqual(none.series, []);
  assert.equal(none.roi, null);
  assert.equal(none.current, 500);
});

test("Bankroll: tikety – zisk při vkladu 1 na tiket, čas podle posledního zápasu", () => {
  const leg = (day) => ({ kickoff: `2026-10-${day}T15:00:00.000Z` });
  const bets = betsFromTickets([
    { status: "win", profit: 2.5, legs: [leg("10"), leg("12")] }, { status: "loss", profit: -1, legs: [leg("11")] },
    { status: "pending", profit: null, legs: [leg("13")] }, { status: "void", profit: 0, legs: [leg("14")] },
  ]);
  assert.equal(bets.length, 2);
  const r = simulate(bets, { start: 1000, stake: 200 });
  assert.deepEqual(r.series.map((p) => p[1]), [1000, 800, 1300]); // prohra z 11. je dřív než výhra dokončená 12.
});

test("Kelly: čtvrtinový, omezený 5 % bankrollu; bez výhody 0", () => {
  // p = 60 %, kurz 2.0 → f = (1.2 − 1) / 1 = 0.2 → ¼ = 5 % (strop) → 500 z 10 000
  assert.deepEqual(kellyStake({ probability: 60, odds: 2, bankroll: 10000 }), { stake: 500, share: 5 });
  // p = 52 %, kurz 2.0 → f = 0.04 → ¼ = 1 % → 100
  assert.deepEqual(kellyStake({ probability: 52, odds: 2, bankroll: 10000 }), { stake: 100, share: 1 });
  assert.deepEqual(kellyStake({ probability: 45, odds: 2, bankroll: 10000 }), { stake: 0, share: 0 });
  assert.deepEqual(kellyStake({ probability: 70, odds: 1, bankroll: 10000 }), { stake: 0, share: 0 });
  assert.deepEqual(kellyStake({ probability: null, odds: 2, bankroll: 10000 }), { stake: 0, share: 0 });
  assert.equal(kellyStake({ probability: 52, odds: 2, bankroll: 1000 }).stake, 10); // malé částky na celé koruny
});

test("Bankroll: nastavení z okna se ořízne na rozumné hodnoty", () => {
  assert.deepEqual(normalizeSettings({}), { start: 10000, tipStake: 100, ticketStake: 100 });
  assert.deepEqual(normalizeSettings({ start: "abc", tipStake: -5, ticketStake: "250" }), { start: 10000, tipStake: 1, ticketStake: 250 });
});
