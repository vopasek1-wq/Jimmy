// Na co sázet a na co ne podle tiketů.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ticketAdvice } = require("../src/advice");

let nextTip = 1;
const leg = (outcome, { odds = 1.8, probability = 70, league = "Premier League", tipCode = "1" } = {}) => ({ tipId: nextTip++, outcome, odds, probability, league, tipCode });
const ticket = (legs, o = {}) => {
  const status = legs.some((l) => l.outcome === "loss") ? "loss" : "win";
  const totalOdds = o.totalOdds ?? Math.round(legs.reduce((p, l) => p * l.odds, 1) * 100) / 100;
  return { status, legs, totalOdds, jointProbability: 40, verdict: "ok", profit: status === "win" ? totalOdds - 1 : -1, ...o };
};
const info = (tickets) => new Map(tickets.flatMap((t) => t.legs.map((l) => [l.tipId, { tipCode: l.tipCode }])));

test("ticketAdvice: bez tiketů / jen čekající – vysvětlení místo doporučení", () => {
  assert.match(ticketAdvice([]).note, /Zatím nejsou uložené žádné tikety/);
  const pending = { status: "pending", legs: [{ tipId: 1, outcome: null }], totalOdds: 2, jointProbability: 40, verdict: "", profit: null };
  assert.match(ticketAdvice([pending]).note, /čekají na výsledky/);
  assert.deepEqual([ticketAdvice([]).bet, ticketAdvice([]).avoid], [[], []]);
});

test("ticketAdvice: skupina s dost případy a dobrým ROI se doporučí, ztrátová ne; málo případů se nehodnotí", () => {
  const two = (win) => ticket([leg(win ? "win" : "loss", { odds: 1.9 }), leg("win", { odds: 1.9 })]);   // 2 zápasy, kurz 3,61
  const four = () => ticket([leg("win"), leg("win"), leg("loss"), leg("win")]);                          // 4 zápasy, prohra
  const tickets = [two(true), two(true), two(true), two(false), four(), four(), four(), four()];
  const a = ticketAdvice(tickets, info(tickets));
  assert.equal(a.tickets, 8);
  const bet = a.bet.map((x) => x.label);
  const avoid = a.avoid.map((x) => x.label);
  assert.ok(bet.includes("Tikety o 2 zápasech"), bet.join());           // 3 výhry ze 4: ROI = (3·2,61 − 1)/4 ≈ +1,7… až +40 % podle kurzu
  assert.ok(avoid.includes("Tikety o 4–5 zápasech"), avoid.join());       // 0 z 4, ROI −100 %
  const four4 = a.avoid.find((x) => x.label === "Tikety o 4–5 zápasech");
  assert.deepEqual([four4.n, four4.wins, four4.roi], [4, 0, -100]);
  assert.match(four4.text, /vyhráno 0 z 4 tiketů \(0 %\), ROI −100 %/);
  assert.ok(!a.bet.concat(a.avoid).some((x) => x.label === "Tikety o 3 zápasech")); // žádný takový tiket
});

test("ticketAdvice: tipy v tiketech podle typu a soutěže; každý tip se počítá jednou", () => {
  const goals = () => leg("loss", { tipCode: "O2.5", league: "Serie A", probability: 72 });
  const result = () => leg("win", { tipCode: "1", league: "Premier League", probability: 72 });
  const t1 = ticket([goals(), result()]);
  const t2 = ticket([goals(), result()]);
  const t3 = ticket([goals(), result()]);
  const t4 = ticket([goals(), result()]);
  const t5 = ticket([goals(), result()]);
  const t6 = ticket([goals(), result()]);
  const tickets = [t1, t2, t3, t4, t5, t6];
  const dup = { ...t6, legs: t6.legs.map((l) => ({ ...l })) };         // totéž v dalším tiketu → tipy se nezdvojí
  const a = ticketAdvice([...tickets, dup], info(tickets));
  assert.equal(a.legs, 12);
  assert.ok(a.avoid.some((x) => x.label === "Typ tipu: Góly celkem" && x.wins === 0 && x.n === 6), JSON.stringify(a.avoid));
  assert.ok(a.avoid.some((x) => x.label === "Soutěž: Serie A"));
  assert.ok(a.bet.some((x) => x.label === "Typ tipu: Výsledek zápasu (1X2)" && x.n === 6 && x.roi > 0), JSON.stringify(a.bet));
  assert.ok(a.bet.some((x) => x.label === "Soutěž: Premier League"));
});

test("ticketAdvice: bez výrazných skupin zůstane jen poznámka s počty a upozorněním na malý vzorek", () => {
  const t = [ticket([leg("win"), leg("loss")]), ticket([leg("win"), leg("win")])];
  const a = ticketAdvice(t, info(t));
  assert.deepEqual([a.bet.length, a.avoid.length], [0, 0]);
  assert.match(a.note, /Vyhodnoceno 2 tiketů \(vyhráno 1, ROI [+−]?\d/);
  assert.match(a.note, /Žádná skupina zatím nevybočuje/);
});
