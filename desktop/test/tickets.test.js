// Tikety: výběr kandidátů, zadání pro Gemini (vyhledání statistik + sestavení), kontrola odpovědi a celý postup.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { candidatesFrom, buildResearchPrompt, buildAssemblePrompt, parseTickets, coveredIds, createTickets } = require("../src/tickets");
const { localDate } = require("../src/timeutil");

const NOW = new Date(Date.UTC(2026, 9, 21, 10, 0));
const at = (h, o = {}) => {
  const ko = new Date(NOW.getTime() + h * 3600e3);
  return { home: `D${h}`, away: `H${h}`, matchName: `D${h} – H${h}`, league: "Liga", leagueShort: "Liga", kickoff: ko.toISOString(), day: localDate(ko),
    tipLabel: "Výhra domácích (1)", probability: 80, odds: 1.8, oddsEstimated: false, probForebet: null, status: "upcoming", ...o };
};
const json = (o) => JSON.stringify(o);

test("candidatesFrom: jen nezačaté zápasy se skutečným kurzem v daném dni, seřazené", () => {
  const tips = [at(2), at(3, { probability: 90 }), at(4, { oddsEstimated: true }), at(1, { status: "live" }), at(-1), at(30)];
  const c = candidatesFrom(tips, { day: "today", now: NOW });
  assert.deepEqual(c.map((t) => t.home), ["D3", "D2"]);
  assert.deepEqual(c.map((t) => t.ticketId), ["t1", "t2"]);
  assert.deepEqual(candidatesFrom(tips, { day: "tomorrow", now: NOW }).map((t) => t.home), ["D30"]);
});

test("candidatesFrom: nejvýš 20 nejlepších zápasů", () => {
  const tips = Array.from({ length: 30 }, (_, i) => at(1 + (i % 9), { home: `X${i}`, away: `Y${i}`, matchName: `X${i} – Y${i}`, probability: 60 + i }));
  const c = candidatesFrom(tips, { day: "today", now: NOW });
  assert.equal(c.length, 20);
  assert.equal(c[0].home, "X29");
});

test("buildResearchPrompt: všechny zápasy s tipem a požadované statistiky", () => {
  const c = candidatesFrom([at(2, { tipLabel: "Více než 2,5 gólu" }), at(3)], { now: NOW });
  const p = buildResearchPrompt(c, { now: NOW });
  assert.ok(p.includes("t1 | D2 – H2 |") && p.includes("tip: Více než 2,5 gólu") && p.includes("t2 | D3 – H3 |"));
  for (const need of ["posledních 5 zápasů", "vzájemné zápasy (H2H)", "střelecká produktivita", "zranění", "domácí výkonnost", "nenalezeno", "NEDOSTATEČNÁ DATA", "21. 10. 2026"]) {
    assert.ok(p.includes(need), need);
  }
});

test("buildAssemblePrompt: pravidla, nabídka a podklady", () => {
  const c = candidatesFrom([at(2), at(3)], { now: NOW });
  const p = buildAssemblePrompt(c, "[t1] podklady k prvnímu zápasu", { calibration: null, now: NOW });
  for (const need of ["Maximálně 5 zápasy na tiket", "2.00", "nejjistější tipy seskupuj dohromady", "2–4 věty", "Piš česky", '"id":"t1"', "[t1] podklady k prvnímu zápasu", "Zatím nemám dost", "nejvýš v jednom tiketu"]) {
    assert.ok(p.includes(need), need);
  }
  assert.ok(!p.includes("po přesně"), "počet tipů ani tiketů se už nezadává");
});

test("parseTickets: dopočte čísla, seřadí zápasy podle času a přijme různé tvary ID", () => {
  const c = candidatesFrom([at(2, { odds: 2, probability: 50 }), at(3, { odds: 1.5, probability: 80 }), at(4)], { now: NOW });
  const idOf = (home) => c.find((x) => x.home === home).ticketId;
  const out = parseTickets("```json\n" + json({ tikety: [{ nazev: "A", jistota: "Vysoká", zduvodneni: "ok", tipy: [idOf("D3").toUpperCase(), `[${idOf("D2")}]`] }], poznamka: "pozn" }) + "\n```", c);
  assert.equal(out.rejected.length, 0);
  assert.equal(out.note, "pozn");
  const t = out.tickets[0];
  assert.deepEqual([t.name, t.verdict, t.summary], ["A", "good", "ok"]);
  assert.deepEqual(t.legs.map((l) => l.matchName), ["D2 – H2", "D3 – H3"]);  // podle začátku zápasu
  assert.equal(t.totalOdds, 3);          // 2 × 1,5
  assert.equal(t.jointProbability, 40);  // 0,5 × 0,8
  assert.equal(t.expectedReturn, 20);    // 0,4 × 3 − 1
  const objs = parseTickets(json({ tickets: [{ name: "B", tipy: [{ id: idOf("D2") }, { id: idOf("D4") }] }] }), c);
  assert.equal(objs.tickets.length, 1);
  assert.equal(objs.tickets[0].verdict, "");
});

test("parseTickets: zahodí tikety, které nesplňují pravidla", () => {
  const c = candidatesFrom([
    at(2), at(3), at(4), at(5), at(6), at(7), at(8),
    at(9, { odds: 1.2 }), at(10, { odds: 1.3 }),
    at(11, { home: "D2", away: "H2", matchName: "D2 – H2", kickoff: at(2).kickoff, tipLabel: "Oba týmy dají gól – ano", odds: 1.9 }),
  ], { now: NOW });
  const id = (home, label) => c.find((x) => x.home === home && (!label || x.tipLabel === label)).ticketId;
  const [d2, d3, d4, d5, d6, d7, d8, d9, d10] = ["D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10"].map((h) => id(h));
  const d2btts = id("D2", "Oba týmy dají gól – ano");
  const reply = json({ tikety: [
    { nazev: "dobrý", tipy: [d2, d3, d4] },
    { nazev: "neznámý", tipy: [d5, "t99"] },
    { nazev: "dvakrát stejný tip", tipy: [d5, d5] },
    { nazev: "jeden", tipy: [d5] },
    { nazev: "šest", tipy: [d4, d5, d6, d7, d8, d3] },
    { nazev: "jiný tip zápasu z prvního tiketu", tipy: [d5, d2btts] },
    { nazev: "už použitý zápas", tipy: [d5, d3] },
    { nazev: "nízký kurz", tipy: [d9, d10] },
    { nazev: "pět", tipy: [d5, d6, d7, d8, d9] },
  ] });
  const out = parseTickets(reply, c);
  assert.deepEqual(out.tickets.map((t) => t.name), ["dobrý", "pět"]);
  assert.equal(out.tickets[1].legs.length, 5);
  assert.equal(out.rejected.length, 7);
  assert.match(out.rejected.join("|"), /neznámý tip t99/);
  assert.match(out.rejected.join("|"), /dva tipy ze stejného zápasu/);
  assert.match(out.rejected.join("|"), /už v dřívějším tiketu/);
  assert.match(out.rejected.join("|"), /kombinovaný kurz 1\.56 je pod 2\.00/);
  assert.match(out.rejected.join("|"), /6 zápasů \(povoleno 2–5\)/);
  const same = parseTickets(json({ tikety: [{ nazev: "S", tipy: [d2, d2btts] }] }), c);
  assert.equal(same.tickets.length, 0);
  assert.match(same.rejected[0], /dva tipy ze stejného zápasu/);
});

test("parseTickets: prázdný výsledek s poznámkou a nevalidní JSON", () => {
  const out = parseTickets(json({ tikety: [], poznamka: "Žádný zápas nemá dost dat." }), []);
  assert.deepEqual([out.tickets.length, out.note], [0, "Žádný zápas nemá dost dat."]);
  assert.throws(() => parseTickets("tohle není json", []), /JSON/);
  assert.throws(() => parseTickets("{ rozbité", []), /JSON/);
});

test("coveredIds: zápasy, ke kterým vyhledávání vrátilo blok", () => {
  const c = candidatesFrom([at(2), at(3), at(4)], { now: NOW });
  assert.deepEqual([...coveredIds("[t1] A – B\nForma\n[ t3 ] C – D\n[t9] neznámý", c)].sort(), ["t1", "t3"]);
});

/** Napodobený Gemini: nejdřív vyhledávání (prostý text), potom sestavení tiketů (JSON). */
function fakeAsk({ research, assemble }) {
  const calls = [];
  const ask = async (options) => {
    calls.push(options);
    const step = options.search ? research.shift() : assemble.shift();
    if (step instanceof Error) throw step;
    return step;
  };
  return { ask, calls };
}
const notes = (ids) => ids.map((id) => `[${id}] zápas\nForma: …\nPodpora tipu: SILNÁ – ok`).join("\n\n");
const candidates = () => candidatesFrom([at(2), at(3), at(4), at(5)], { now: NOW });

test("createTickets: vyhledání statistik, pak sestavení; vrací tikety a údaje o vyhledávání", async () => {
  const c = candidates();
  const ids = c.map((x) => x.ticketId);
  const { ask, calls } = fakeAsk({
    research: [{ text: notes(ids), grounded: true, queries: ["a", "b", "c"] }],
    assemble: [{ text: json({ tikety: [{ nazev: "Tiket 1", jistota: "stredni", zduvodneni: "Dobrá forma.", tipy: [ids[0], ids[1]] }] }) }],
  });
  const messages = [];
  const r = await createTickets({ candidates: c, ask, calibration: null, progress: (m) => messages.push(m), now: NOW });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].search, true);
  assert.ok(calls[0].system.includes("vyhledáváním na webu"));
  assert.equal(calls[1].json, true);
  assert.ok(calls[1].prompt.includes("[t1] zápas") && calls[1].prompt.includes("Podpora tipu: SILNÁ"));
  assert.deepEqual(messages.length, 2);
  assert.match(messages[0], /vyhledává statistiky/);
  assert.match(messages[1], /sestavuje tikety/);
  assert.equal(r.tickets.length, 1);
  assert.deepEqual([r.analyzed, r.covered, r.grounded, r.searches], [4, 4, true, 3]);
  assert.equal(r.tickets[0].summary, "Dobrá forma.");
});

test("createTickets: neúplné vyhledávání se zkusí znovu a vybere se lepší pokus", async () => {
  const c = candidates();
  const ids = c.map((x) => x.ticketId);
  const { ask, calls } = fakeAsk({
    research: [{ text: notes(ids.slice(2)), grounded: true, queries: ["a"] }, { text: notes(ids), grounded: true, queries: ["a", "b"] }],
    assemble: [{ text: json({ tikety: [{ tipy: ids.slice(0, 2) }] }) }],
  });
  const messages = [];
  const r = await createTickets({ candidates: c, ask, progress: (m) => messages.push(m), now: NOW });
  assert.equal(calls.filter((x) => x.search).length, 2);
  assert.ok(messages.some((m) => /zkouším to ještě jednou/.test(m)));
  assert.deepEqual([r.covered, r.searches, r.tickets[0].name], [4, 2, "Tiket 1"]);
  assert.ok(calls[1].prompt.includes(ids[0]));
});

test("createTickets: model nevyhledával → grounded false (po dvou pokusech); chyba druhého pokusu nevadí", async () => {
  const c = candidates();
  const ids = c.map((x) => x.ticketId);
  const assemble = () => [{ text: json({ tikety: [{ tipy: ids.slice(0, 2) }] }) }];
  const twice = fakeAsk({ research: [{ text: notes(ids), grounded: false, queries: [] }, { text: notes(ids), grounded: false, queries: [] }], assemble: assemble() });
  const a = await createTickets({ candidates: c, ask: twice.ask, now: NOW });
  assert.equal(a.grounded, false);
  assert.equal(twice.calls.filter((x) => x.search).length, 2);

  const second = fakeAsk({ research: [{ text: notes(ids), grounded: false, queries: [] }, new Error("přetížené")], assemble: assemble() });
  const b = await createTickets({ candidates: c, ask: second.ask, now: NOW });
  assert.equal(b.grounded, false);
  assert.equal(b.tickets.length, 1);

  const first = fakeAsk({ research: [new Error("Gemini je teď přetížené")], assemble: assemble() });
  await assert.rejects(() => createTickets({ candidates: c, ask: first.ask, now: NOW }), /přetížené/);
});

test("createTickets: žádný vhodný tiket (s poznámkou), neplatný JSON se opakuje, tikety proti pravidlům = chyba", async () => {
  const c = candidates();
  const ids = c.map((x) => x.ticketId);
  const research = () => [{ text: notes(ids), grounded: true, queries: ["a"] }];

  const none = fakeAsk({ research: research(), assemble: [{ text: json({ tikety: [], poznamka: "U většiny zápasů chybí data." }) }] });
  const r = await createTickets({ candidates: c, ask: none.ask, now: NOW });
  assert.deepEqual([r.tickets.length, r.note], [0, "U většiny zápasů chybí data."]);

  const retry = fakeAsk({ research: research(), assemble: [{ text: "ne-json" }, { text: json({ tikety: [{ tipy: ids.slice(0, 2) }] }) }] });
  assert.equal((await createTickets({ candidates: c, ask: retry.ask, now: NOW })).tickets.length, 1);
  assert.equal(retry.calls.filter((x) => x.json).length, 2);

  const broken = fakeAsk({ research: research(), assemble: [{ text: "ne-json" }, { text: "ani tohle" }] });
  await assert.rejects(() => createTickets({ candidates: c, ask: broken.ask, now: NOW }), /JSON/);

  const bad = fakeAsk({ research: research(), assemble: [{ text: json({ tikety: [{ nazev: "X", tipy: [ids[0], "t99"] }] }) }] });
  await assert.rejects(() => createTickets({ candidates: c, ask: bad.ask, now: NOW }), /nesplňují pravidla.*neznámý tip t99/);
});

test("createTickets: méně než 2 tipy → srozumitelná chyba, Gemini se nevolá", async () => {
  const { ask, calls } = fakeAsk({ research: [], assemble: [] });
  await assert.rejects(() => createTickets({ candidates: candidatesFrom([at(2)], { now: NOW }), ask, now: NOW }), /málo vhodných tipů \(1\)/);
  assert.equal(calls.length, 0);
});
