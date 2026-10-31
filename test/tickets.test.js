// Tikety: výběr kandidátů, zadání pro Gemini, kontrola odpovědi a celý postup (statistiky → Gemini).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { candidatesFrom, buildTicketPrompt, parseTickets, createTickets, answerCache, ticketGroups } = require("../src/tickets");
const { localDate } = require("../src/timeutil");

const NOW = new Date(Date.UTC(2026, 9, 21, 10, 0));
const at = (h, o = {}) => {
  const ko = new Date(NOW.getTime() + h * 3600e3);
  return { home: `D${h}`, away: `H${h}`, matchName: `D${h} – H${h}`, league: "Liga", leagueShort: "Liga", kickoff: ko.toISOString(), day: localDate(ko),
    tipLabel: "Výhra domácích (1)", probability: 80, odds: 1.8, oddsEstimated: false, probForebet: null, status: "upcoming", sofascoreId: 1000 + h, ...o };
};
const json = (o) => JSON.stringify(o);

test("candidatesFrom: jen nezačaté zápasy se skutečným kurzem v daném dni, seřazené", () => {
  const tips = [at(2), at(3, { probability: 90 }), at(4, { oddsEstimated: true }), at(1, { status: "live" }), at(-1), at(30)];
  const c = candidatesFrom(tips, { day: "today", now: NOW });
  assert.deepEqual(c.map((t) => t.home), ["D3", "D2"]);
  assert.deepEqual(c.map((t) => t.ticketId), ["t1", "t2"]);
  assert.deepEqual(candidatesFrom(tips, { day: "tomorrow", now: NOW }).map((t) => t.home), ["D30"]);
});

test("buildTicketPrompt: zohlední domácí/hosty, absence, odpočinek a výsledky z Vyhodnocení (typy, soutěže, uložené tikety)", () => {
  const c = candidatesFrom([at(2), at(3)], { now: NOW });
  const calibration = {
    overall: { n: 40, actual: 61, predicted: 78, gap: -17 },
    bands: [{ label: "70–80 %", n: 20, predicted: 75, actual: 58 }],
    markets: [{ name: "Góly celkem", n: 12, predicted: 76, actual: 50, roi: -22 }, { name: "Výsledek zápasu (1X2)", n: 2, predicted: 80, actual: 100, roi: 10 }],
    leagues: [{ name: "Anglie – EFL Cup", n: 6, predicted: 78, actual: 33, roi: -40 }],
    insights: ["Trh „Góly celkem“ dlouhodobě zaostává."],
  };
  const ticketResults = ticketGroups([]);
  assert.equal(ticketResults.celkem.n, 0);
  const p = buildTicketPrompt(c, { t1: { dostupnost: { domaci: "chybí 1", hoste: "žádné známé absence" } } }, { calibration, ticketResults: { celkem: { n: 4, wins: 1 }, podle_poctu_zapasu: [{ skupina: "3 zápasy", n: 4 }], podle_jistoty: [] }, now: NOW });
  for (const need of ["kdo hraje doma", "dostupnost", "dny od posledního zápasu", "Podle typu tipu", "Góly celkem", "Podle soutěže", "EFL Cup", "Zjištění z mých výsledků", "Moje uložené tikety", "3 zápasy", "zařazuj jen s oporou SILNÁ"]) {
    assert.ok(p.includes(need), `v zadání chybí: ${need}`);
  }
  assert.ok(!p.includes("Výsledek zápasu (1X2)"), "skupiny s málo tipy (n < 3) se neukazují");
  assert.ok(!buildTicketPrompt(c, {}, { calibration: null, now: NOW }).includes("Podle typu tipu"));
});

test("ticketGroups: vyhodnocené tikety podle počtu zápasů a jistoty", () => {
  const leg = (outcome) => ({ outcome, odds: 1.8, probability: 80 });
  const tk = (status, n, verdict, joint = 50) => ({ status, verdict, legs: Array.from({ length: n }, () => leg("win")), jointProbability: joint, profit: status === "win" ? 1 : -1 });
  const g = ticketGroups([tk("win", 2, "good"), tk("loss", 2, "good"), tk("loss", 3, "ok"), tk("pending", 3, "ok")]);
  assert.deepEqual(g.podle_poctu_zapasu, [
    { skupina: "2 zápasy", n: 2, vyhralo: 1, odhad: 50, skutecnost: 50, roi: 0 },
    { skupina: "3 zápasy", n: 1, vyhralo: 0, odhad: 50, skutecnost: 0, roi: -100 },
  ]);
  assert.deepEqual(g.podle_jistoty.map((x) => [x.skupina, x.n]), [["vysoká", 2], ["střední", 1]]);
  assert.equal(g.celkem.n, 3);
});

test("candidatesFrom: nejvýš 20 nejlepších zápasů", () => {
  const tips = Array.from({ length: 30 }, (_, i) => at(1 + (i % 9), { home: `X${i}`, away: `Y${i}`, matchName: `X${i} – Y${i}`, probability: 60 + i }));
  const c = candidatesFrom(tips, { day: "today", now: NOW });
  assert.equal(c.length, 20);
  assert.equal(c[0].home, "X29");
});

test("buildTicketPrompt: pravidla, tipy a jejich statistiky", () => {
  const c = candidatesFrom([at(2, { tipLabel: "Více než 2,5 gólu" }), at(3)], { now: NOW });
  const stats = { t1: { forma_domaci: { forma: "V V R V P" }, h2h: { zapasu: 3 } }, t2: { forma_domaci: { forma: "P P R V V" } } };
  const p = buildTicketPrompt(c, stats, { calibration: null, now: NOW });
  for (const need of ["Maximálně 3 zápasy na tiket", "2.00", "seskupuj dohromady", "SILNÁ", "STŘEDNÍ", "SLABÁ", "NEDOSTATEČNÁ DATA", "vytvoř víc tiketů", '"vynechane"',
    "KAŽDÉMU zápasu v tiketu zvlášť", "1–2 věty", '"shrnuti"', "Piš česky", "nejvýš v jednom tiketu",
    "21. 10. 2026", "ze SofaScore", "posledních 5 zápasů", "vzájemné zápasy (H2H)", "střelecká produktivita", "zranění", "domácí výkonnost", "Legenda: V = výhra, R = remíza, P = prohra", "Zatím nemám dost",
    '"id":"t1"', '"tip":"Více než 2,5 gólu"', '"forma":"V V R V P"', '"h2h":{"zapasu":3}']) {
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

test("parseTickets: zdůvodnění u každého tipu zvlášť + shrnutí tiketu; starší tvar (jen shrnutí) dál funguje", () => {
  const c = candidatesFrom([at(2), at(3), at(4)], { now: NOW });
  const idOf = (home) => c.find((x) => x.home === home).ticketId;
  const out = parseTickets(json({ tikety: [{
    nazev: "A", jistota: "stredni", shrnuti: "Samí domácí.",
    tipy: [{ id: idOf("D3"), zduvodneni: "  Domácí forma V V V.  " }, { id: idOf("D2"), duvod: "Hosté venku prohrávají." }, { id: idOf("D4") }],
  }] }), c);
  const t = out.tickets[0];
  assert.equal(t.summary, "Samí domácí.");
  assert.deepEqual(t.legs.map((l) => [l.matchName, l.reason]), [["D2 – H2", "Hosté venku prohrávají."], ["D3 – H3", "Domácí forma V V V."], ["D4 – H4", ""]]);
  const old = parseTickets(json({ tikety: [{ nazev: "B", zduvodneni: "Celkové zdůvodnění.", tipy: [idOf("D2"), idOf("D3")] }] }), c).tickets[0];
  assert.equal(old.summary, "Celkové zdůvodnění.");
  assert.ok(old.legs.every((l) => l.reason === ""));
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
    { nazev: "čtyři", tipy: [d5, d6, d7, d8] },
    { nazev: "tři", tipy: [d5, d6, d7] },
  ] });
  const out = parseTickets(reply, c);
  assert.deepEqual(out.tickets.map((t) => t.name), ["dobrý", "tři"]);
  assert.equal(out.tickets[1].legs.length, 3);
  assert.equal(out.rejected.length, 8);
  assert.match(out.rejected.join("|"), /neznámý tip t99/);
  assert.match(out.rejected.join("|"), /dva tipy ze stejného zápasu/);
  assert.match(out.rejected.join("|"), /už v dřívějším tiketu/);
  assert.match(out.rejected.join("|"), /kombinovaný kurz 1\.56 je pod 2\.00/);
  assert.match(out.rejected.join("|"), /6 zápasů \(povoleno 2–3\)/);
  assert.match(out.rejected.join("|"), /4 zápasů \(povoleno 2–3\)/);
  const same = parseTickets(json({ tikety: [{ nazev: "S", tipy: [d2, d2btts] }] }), c);
  assert.equal(same.tickets.length, 0);
  assert.match(same.rejected[0], /dva tipy ze stejného zápasu/);
});

test("parseTickets: důvody vynechání od AI (pole, řetězce i objekt) a zápasy ze zahozených tiketů", () => {
  const c = candidatesFrom([at(2), at(3), at(4), at(5)], { now: NOW });
  const [a, b, d, e] = c.map((x) => x.ticketId);
  const arr = parseTickets(json({ tikety: [{ tipy: [a, b] }, { nazev: "špatný", tipy: [d, "t99"] }], vynechane: [{ id: d, duvod: "forma hostů tip nepodporuje" }, { id: `[${e.toUpperCase()}]`, duvod: " chybí H2H " }, { id: "t99", duvod: "x" }] }), c);
  assert.deepEqual([...arr.skipped], [[d, "forma hostů tip nepodporuje"], [e, "chybí H2H"], ["t99", "x"]]);
  assert.deepEqual([...arr.dropped.keys()], [d]);          // jen známé tipy ze zahozeného tiketu
  const str = parseTickets(json({ tikety: [], vynechane: [`${a}: málo dat`, `${b} - slabá forma`, "nesmysl"] }), c);
  assert.deepEqual([...str.skipped], [[a, "málo dat"], [b, "slabá forma"]]);
  const obj = parseTickets(json({ tikety: [], vynechane: { [a]: "důvod A" } }), c);
  assert.deepEqual([...obj.skipped], [[a, "důvod A"]]);
  assert.equal(parseTickets(json({ tikety: [] }), c).skipped.size, 0);
});

test("parseTickets: prázdný výsledek s poznámkou a nevalidní JSON", () => {
  const out = parseTickets(json({ tikety: [], poznamka: "Žádný zápas nemá dost dat." }), []);
  assert.deepEqual([out.tickets.length, out.note], [0, "Žádný zápas nemá dost dat."]);
  assert.throws(() => parseTickets("tohle není json", []), /JSON/);
  assert.throws(() => parseTickets("{ rozbité", []), /JSON/);
});

/** Napodobené stahování statistik a Gemini (`replies` se vydávají postupně). */
const fakes = ({ covered, replies = [], collectResult }) => {
  const calls = { collect: 0, ask: [] };
  const collect = async (candidates, progress) => {
    calls.collect += 1;
    progress("Stahuji statistiky…");
    if (collectResult) return collectResult;
    const stats = {};
    for (const c of candidates) if (covered.includes(c.ticketId)) stats[c.ticketId] = { forma_domaci: { forma: "V V V" } };
    return { stats, covered: Object.keys(stats).length, total: candidates.length, noId: 0, blocked: false };
  };
  const ask = async (options) => {
    calls.ask.push(options);
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return { text: r, model: "gemini-flash-latest" };
  };
  return { collect, ask, calls };
};
const four = () => candidatesFrom([at(2), at(3), at(4), at(5)], { now: NOW });

test("createTickets: statistiky → jediný dotaz na Gemini jen se zápasy, které mají statistiky", async () => {
  const c = four();
  const ids = c.map((x) => x.ticketId);
  const f = fakes({ covered: [ids[0], ids[1], ids[2]], replies: [json({ tikety: [{ nazev: "Tiket 1", jistota: "stredni", zduvodneni: "Dobrá forma.", tipy: [ids[0], ids[1]] }] })] });
  const messages = [];
  const r = await createTickets({ candidates: c, collect: f.collect, ask: f.ask, calibration: null, progress: (m) => messages.push(m), now: NOW });
  assert.equal(f.calls.collect, 1);
  assert.equal(f.calls.ask.length, 1);
  assert.equal(f.calls.ask[0].json, true);
  assert.equal(f.calls.ask[0].temperature, null);
  assert.ok(f.calls.ask[0].prompt.includes(`"id":"${ids[2]}"`) && !f.calls.ask[0].prompt.includes(`"id":"${ids[3]}"`), "zápas bez statistik se do zadání nedává");
  assert.ok(messages.includes("Stahuji statistiky…") && messages.some((m) => /Gemini vyhodnocuje/.test(m)));
  assert.deepEqual([r.tickets.length, r.analyzed, r.covered], [1, 4, 3]);
  assert.equal(r.tickets[0].summary, "Dobrá forma.");
});

test("createTickets: stejné podklady do 20 minut = předchozí odpověď bez nového dotazu na Gemini; omezené přemýšlení modelu", async () => {
  const c = four();
  const ids = c.map((x) => x.ticketId);
  const f = fakes({ covered: ids, replies: [json({ tikety: [{ nazev: "Tiket 1", jistota: "stredni", tipy: [ids[0], ids[1]] }] })] });
  let clock = 0;
  const reuse = answerCache({ now: () => clock });
  const first = await createTickets({ candidates: c, collect: f.collect, ask: f.ask, now: NOW, reuse });
  assert.equal(f.calls.ask.length, 1);
  assert.equal(f.calls.ask[0].thinkingBudget, 1024);
  assert.equal(first.reused, false);
  const msgs = [];
  const second = await createTickets({ candidates: c, collect: f.collect, ask: f.ask, now: NOW, reuse, progress: (m) => msgs.push(m) });
  assert.equal(f.calls.ask.length, 1);                                   // žádný další dotaz
  assert.deepEqual([second.reused, second.tickets.length], [true, 1]);
  assert.ok(msgs.some((m) => /předchozí odpověď/.test(m)));
  clock = 21 * 60e3;                                                      // po 20 minutách platí odpověď už jen starší
  const f2 = fakes({ covered: ids, replies: [json({ tikety: [{ nazev: "Tiket 1", tipy: [ids[0], ids[1]] }] })] });
  const third = await createTickets({ candidates: c, collect: f2.collect, ask: f2.ask, now: NOW, reuse });
  assert.deepEqual([f2.calls.ask.length, third.reused], [1, false]);
});

test("createTickets: málo zápasů se statistikami = srozumitelná chyba a Gemini se nevolá", async () => {
  const c = four();
  const f = fakes({ covered: [c[0].ticketId] });
  await assert.rejects(() => createTickets({ candidates: c, collect: f.collect, ask: f.ask, now: NOW, hint: " Podrobnosti: soubor.txt" }),
    /nepodařilo získat statistiky aspoň ke 2 zápasům\. Statistiky se podařilo najít jen ke 1 z 4 zápasů\. Podrobnosti: soubor\.txt/);
  assert.equal(f.calls.ask.length, 0);
  const blocked = fakes({ collectResult: { stats: {}, covered: 0, total: 4, noId: 0, blocked: true } });
  await assert.rejects(() => createTickets({ candidates: c, collect: blocked.collect, ask: blocked.ask, now: NOW }), /SofaScore zamítá dotazy/);
  const noId = fakes({ collectResult: { stats: {}, covered: 0, total: 4, noId: 4, blocked: false } });
  await assert.rejects(() => createTickets({ candidates: c, collect: noId.collect, ask: noId.ask, now: NOW }), /Obnovit tipy/);
  const one = fakes({ covered: [] });
  await assert.rejects(() => createTickets({ candidates: candidatesFrom([at(2)], { now: NOW }), collect: one.collect, ask: one.ask, now: NOW }), /málo vhodných tipů \(1\)/);
  assert.equal(one.calls.collect, 0);
});

test("createTickets: žádný vhodný tiket (s poznámkou), neplatný JSON se zopakuje, tikety proti pravidlům = chyba, chyba Gemini se předá", async () => {
  const c = four();
  const ids = c.map((x) => x.ticketId);
  const base = { covered: ids };

  const none = fakes({ ...base, replies: [json({ tikety: [], poznamka: "U většiny zápasů chybí data." })] });
  const r = await createTickets({ candidates: c, collect: none.collect, ask: none.ask, now: NOW });
  assert.deepEqual([r.tickets.length, r.note], [0, "U většiny zápasů chybí data."]);

  const retry = fakes({ ...base, replies: ["ne-json", json({ tikety: [{ tipy: ids.slice(0, 2) }] })] });
  assert.equal((await createTickets({ candidates: c, collect: retry.collect, ask: retry.ask, now: NOW })).tickets.length, 1);
  assert.equal(retry.calls.ask.length, 2);

  const broken = fakes({ ...base, replies: ["ne-json", "ani tohle"] });
  await assert.rejects(() => createTickets({ candidates: c, collect: broken.collect, ask: broken.ask, now: NOW }), /JSON/);

  const bad = fakes({ ...base, replies: [json({ tikety: [{ nazev: "X", tipy: [ids[0], "t99"] }] })] });
  await assert.rejects(() => createTickets({ candidates: c, collect: bad.collect, ask: bad.ask, now: NOW }), /nesplňují pravidla.*neznámý tip t99/);

  const limit = fakes({ ...base, replies: [new Error("Vyčerpaný denní limit Gemini API")] });
  await assert.rejects(() => createTickets({ candidates: c, collect: limit.collect, ask: limit.ask, now: NOW }), /Vyčerpaný denní limit/);
});

test("createTickets: nezařazené zápasy mají důvod (AI, bez statistik, jiný tip téhož zápasu, zahozený tiket)", async () => {
  const c = candidatesFrom([at(2), at(3), at(4), at(5), at(6), at(7, { sofascoreId: null }), at(8, { home: "D2", away: "H2", matchName: "D2 – H2", kickoff: at(2).kickoff, tipLabel: "Oba týmy dají gól – ano" })], { now: NOW });
  const idOf = (home, label) => c.find((x) => x.home === home && (!label || x.tipLabel === label)).ticketId;
  const [d2, d3, d4, d5, d6, d7] = ["D2", "D3", "D4", "D5", "D6", "D7"].map((h) => idOf(h));
  const d2btts = idOf("D2", "Oba týmy dají gól – ano");
  // statistiky mají všechny kromě D6 a D7 (D7 nemá ani SofaScore ID)
  const f = fakes({
    covered: [d2, d3, d4, d5, d2btts],
    replies: [json({
      tikety: [{ nazev: "Tiket 1", jistota: "vysoka", zduvodneni: "ok", tipy: [d2, d3] }, { nazev: "Tiket 2", tipy: [d4, "t99"] }],
      vynechane: [{ id: d5, duvod: "forma domácích tip nepodporuje" }],
    })],
  });
  const r = await createTickets({ candidates: c, collect: f.collect, ask: f.ask, now: NOW });
  assert.equal(r.tickets.length, 1);
  assert.equal(r.rejected, 1);
  const why = Object.fromEntries(r.omitted.map((o) => [o.id, [o.kind, o.reason]]));
  assert.deepEqual(why[d4], ["rule", "navržený tiket byl zahozen (neznámý tip t99)"]);
  assert.deepEqual(why[d5], ["model", "forma domácích tip nepodporuje"]);
  assert.deepEqual(why[d6], ["nodata", "statistiky ze SofaScore se nepodařilo stáhnout"]);
  assert.deepEqual(why[d7], ["nodata", "zápas se nepodařilo najít na SofaScore"]);
  assert.deepEqual(why[d2btts], ["same", "zápas je už v tiketu s jiným tipem"]);
  assert.equal(r.omitted.length, 5);               // 7 zápasů − 2 v tiketu

  // AI zápas nezmínila ani nezařadila → obecný důvod
  const silent = fakes({ covered: [d2, d3, d4], replies: [json({ tikety: [{ tipy: [d2, d3] }] })] });
  const r2 = await createTickets({ candidates: c.slice(0, 3), collect: silent.collect, ask: silent.ask, now: NOW });
  assert.match(r2.omitted[0].reason, /nezařadil a nezdůvodnil/);
});
