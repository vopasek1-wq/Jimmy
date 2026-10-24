// Tikety (2–5 tipů): kandidáti z uložených tipů, statistiky zápasů ze SofaScore (matchstats.js), zadání pro Gemini
// a kontrola odpovědi. Čísla tiketu (kurz, pravděpodobnost, očekávaný výnos) se počítají vždy zde – z AI se berou jen
// výběr tipů a zdůvodnění. Statistiky stahuje aplikace sama, protože vyhledávání na webu (Google Search) Gemini API
// u bezplatného klíče nenabízí.
"use strict";

const { addDays, fmtHourMinute, todayLocal } = require("./timeutil");

const MIN_LEGS = 2;
const MAX_LEGS = 5;
const MIN_TOTAL_ODDS = 2;       // minimální kombinovaný kurz tiketu
const MAX_CANDIDATES = 20;      // víc zápasů najednou je zbytečně dlouhé stahování i zadání
const ASSEMBLE_TIMEOUT = 150000;

const JISTOTA = { vysoka: "good", vysoke: "good", high: "good", dobry: "good", good: "good", stredni: "ok", medium: "ok", prumerny: "ok", ok: "ok",
  nizsi: "risky", nizka: "risky", low: "risky", rizikovy: "risky", risky: "risky" };

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").trim();
const certaintyOf = (v) => JISTOTA[norm(v)] || "";
const czDate = (iso) => { const [y, m, d] = String(iso).split("-").map(Number); return `${d}. ${m}. ${y}`; };

/**
 * Kandidáti jsou tipy z přehledu, které ještě nezačaly, mají skutečný (ne odhadnutý) kurz a patří do zvoleného dne.
 * Vrací nejvýš MAX_CANDIDATES, nejlepší podle součtu „pravděpodobnost + Value“.
 */
function candidatesFrom(tips, { day = "today", now = new Date() } = {}) {
  const today = todayLocal(now);
  const wanted = day === "tomorrow" ? addDays(today, 1) : today;
  const list = tips
    .filter((t) => t.day === wanted && t.status === "upcoming" && Date.parse(t.kickoff) > now.getTime() && t.odds && !t.oddsEstimated)
    .map((t) => ({ ...t, value: Math.round((t.probability - 100 / t.odds) * 10) / 10 }))
    .sort((a, b) => (b.probability + b.value) - (a.probability + a.value))
    .slice(0, MAX_CANDIDATES);
  return list.map((t, i) => ({ ...t, ticketId: `t${i + 1}` }));
}

function calibrationLine(calibration) {
  return calibration && calibration.overall && calibration.overall.n
    ? `Moje dosavadní výsledky: ${calibration.overall.n} vyhodnocených tipů, skutečná úspěšnost ${calibration.overall.actual} % při průměrném odhadu ${calibration.overall.predicted} % (rozdíl ${calibration.overall.gap} p. b.). Pásma: ${JSON.stringify(calibration.bands.filter((b) => b.n).map((b) => ({ pasmo: b.label, n: b.n, odhad: b.predicted, skutecnost: b.actual })))}.`
    : "Zatím nemám dost vyhodnocených tipů, takže kalibraci pravděpodobnosti neznám.";
}

/** Zadání pro Gemini: tipy se statistikami ze SofaScore (`stats[ticketId]`) a pravidla výběru. */
function buildTicketPrompt(candidates, stats, { calibration = null, now = new Date() } = {}) {
  const rows = candidates.map((t) => ({
    id: t.ticketId, zapas: t.matchName, soutez: t.leagueShort || t.league, zacatek: `${czDate(t.day)} ${fmtHourMinute(new Date(t.kickoff))}`,
    tip: t.tipLabel, pravdepodobnost: t.probability, kurz: t.odds, statistiky: stats[t.ticketId] || null,
  }));
  return `Z nabídky níže sestav tikety (dnes je ${czDate(todayLocal(now))}). U každého zápasu máš aktuální statistiky ze SofaScore: forma obou týmů `
    + `(posledních 5 zápasů a počty výher/remíz/proher), vzájemné zápasy (H2H), střelecká produktivita (vstřelené a obdržené góly na zápas), `
    + `domácí výkonnost domácího týmu a venkovní výkonnost hostů a zranění či absence hráčů. Posuď, jestli tyto statistiky podporují právě tip u zápasu. `
    + `Legenda: V = výhra, R = remíza, P = prohra; forma a seznam zápasů jsou od nejnovějšího; „dal“ a „obdrzel“ jsou průměry vstřelených a obdržených gólů na zápas; `
    + `„doma“ je výkonnost domácího týmu v jeho posledních domácích zápasech, „venku“ výkonnost hostů v jejich posledních venkovních zápasech.\n\n`
    + `POSTUP:\n`
    + `1. U každého zápasu posuď, jak statistiky podporují tip u zápasu: SILNÁ (forma, H2H, góly a domácí/venkovní výkonnost tip jasně podporují), STŘEDNÍ (většina údajů tip podporuje a nic mu výrazně neodporuje), SLABÁ (údaje si odporují nebo tip podporují jen málo) nebo NEDOSTATEČNÁ DATA (chybí forma nebo góly alespoň jednoho týmu). Chybějící H2H nebo zranění samo o sobě zápas nevyřazuje – posuzuj podle údajů, které máš.\n`
    + `2. Do tiketů zařaď zápasy s podporou SILNÁ a STŘEDNÍ. SLABÁ a NEDOSTATEČNÁ DATA nezařazuj – vyhýbej se riskantním sázkám bez datové opory.\n`
    + `3. Zařazené zápasy rozděl do tiketů logicky: nejjistější (SILNÁ) tipy seskupuj dohromady do prvního tiketu, další tikety skládej z méně jistých. Je-li zápasů s dostatečnou oporou víc, vytvoř víc tiketů – zápas nenech bez tiketu jen proto, že není mezi nejlepšími.\n\n`
    + `PRAVIDLA:\n`
    + `- Maximálně ${MAX_LEGS} zápasy na tiket, minimálně ${MIN_LEGS}.\n`
    + `- Minimální kombinovaný kurz tiketu (součin kurzů tipů) je ${MIN_TOTAL_ODDS.toFixed(2)}. Tiket, který to nesplňuje, nevytvářej.\n`
    + `- Každý zápas smí být nejvýš v jednom tiketu (tikety se v zápasech nepřekrývají).\n`
    + `- Zdůvodnění piš ke KAŽDÉMU zápasu v tiketu zvlášť („zduvodneni“ u daného tipu): 1–2 věty, stručné, věcné a srozumitelné pro běžného sázkaře; odkaž na formu týmů, vzájemné zápasy, góly, zranění nebo domácí/venkovní výkonnost z dodaných statistik právě pro tento zápas. Nepřidávej čísla ani fakta, která ve statistikách nejsou. Chybějící údaj (zraneni není uvedeno) nic nedokazuje.\n`
    + `- Shrnutí tiketu („shrnuti“): jedna krátká věta, proč jsou tyto zápasy pohromadě (např. „samé silné domácí týmy“). Neopakuj v něm zdůvodnění jednotlivých zápasů.\n`
    + `- U každého zápasu, který v žádném tiketu není, uveď v poli "vynechane" jeho id a důvod (nejvýš 12 slov, např. „forma hostů tip nepodporuje“, „chybí údaje o H2H i zraněních“).\n`
    + `- Piš česky.\n`
    + `- Pokud žádný tiket pravidla nesplňuje, vrať prázdné pole "tikety" a v "poznamka" stručně napiš proč.\n\n`
    + `${calibrationLine(calibration)} Pravděpodobnost v nabídce je odhad zdroje, ne kalibrovaná šance.\n\n`
    + `NABÍDKA SE STATISTIKAMI (JSON): ${JSON.stringify(rows)}\n\n`
    + `Odpověz POUZE JSON podle tohoto tvaru (česky, bez dalšího textu):\n`
    + `{"tikety":[{"nazev":"Tiket 1","jistota":"vysoka|stredni|nizsi","shrnuti":"1 věta","tipy":[{"id":"id zápasu z nabídky","zduvodneni":"1–2 věty k tomuto zápasu"}]}],"vynechane":[{"id":"t2","duvod":"max. 12 slov"}],"poznamka":""}`;
}

/** Vytáhne JSON i z odpovědi obalené v ```json … ```. */
function parseJson(text) {
  const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch { /* níže */ }
    }
    throw new Error("AI nevrátila platný JSON.");
  }
}

const cleanId = (x) => String(x || "").replace(/[[\]\s]/g, "").toLowerCase();

/** Pole `vynechane` od AI → Map id → důvod; přijme pole objektů { id, duvod }, řetězce „t2: důvod“ i objekt { t2: "důvod" }. */
function parseSkipped(raw) {
  const out = new Map();
  const add = (id, why) => { const k = cleanId(id); if (k && !out.has(k)) out.set(k, String(why || "").trim()); };
  if (Array.isArray(raw)) {
    for (const x of raw) {
      if (x && typeof x === "object") add(x.id, x.duvod || x.reason || x.dovod);
      else { const m = /^\s*\[?(t\d+)\]?\s*[:\-–—]?\s*(.*)$/i.exec(String(x)); if (m) add(m[1], m[2]); }
    }
  } else if (raw && typeof raw === "object") {
    for (const [id, why] of Object.entries(raw)) add(id, why);
  }
  return out;
}

/**
 * Zkontroluje odpověď AI a dopočítá čísla. Zahodí tikety s neznámým tipem, špatným počtem zápasů (2–5),
 * zápasem použitým už v dřívějším tiketu nebo s kombinovaným kurzem pod minimem.
 * Vrací { tickets, note, rejected: [důvod, …], dropped: Map id → důvod zahození tiketu, skipped: Map id → důvod vynechání od AI }.
 */
function parseTickets(text, candidates) {
  const data = parseJson(text) || {};
  const list = Array.isArray(data) ? data : data.tikety || data.tickets || [];
  const byId = new Map(candidates.map((c) => [c.ticketId, c]));
  const usedMatches = new Set();
  const tickets = [];
  const rejected = [];
  const dropped = new Map();
  (Array.isArray(list) ? list : []).forEach((raw, i) => {
    const name = String((raw && (raw.nazev || raw.name)) || `Tiket ${i + 1}`).trim();
    const rawItems = (raw && (raw.tipy || raw.legs)) || [];
    const items = rawItems.map((x) => cleanId(x && typeof x === "object" ? x.id : x));
    const reasons = new Map(); // zdůvodnění u jednotlivých tipů (starší tvar odpovědi má jen shrnutí celého tiketu)
    for (const x of rawItems) {
      if (x && typeof x === "object") reasons.set(cleanId(x.id), String(x.zduvodneni || x.duvod || x.reason || x.komentar || "").trim());
    }
    const reject = (why) => {
      rejected.push(`${name}: ${why}`);
      for (const id of items) if (byId.has(id) && !dropped.has(id)) dropped.set(id, why);
    };
    if (items.length < MIN_LEGS || items.length > MAX_LEGS) return reject(`${items.length} zápasů (povoleno ${MIN_LEGS}–${MAX_LEGS})`);
    const picked = [];
    const keys = new Set();
    for (const id of items) {
      const c = byId.get(id);
      if (!c) return reject(`neznámý tip ${id}`);
      const key = `${c.home}|${c.away}|${c.kickoff}`;
      if (keys.has(key)) return reject("dva tipy ze stejného zápasu");
      if (usedMatches.has(key)) return reject(`zápas ${c.matchName} je už v dřívějším tiketu`);
      keys.add(key);
      picked.push(c);
    }
    const odds = picked.reduce((p, l) => p * l.odds, 1);
    if (odds < MIN_TOTAL_ODDS) return reject(`kombinovaný kurz ${odds.toFixed(2)} je pod ${MIN_TOTAL_ODDS.toFixed(2)}`);
    keys.forEach((k) => usedMatches.add(k));
    picked.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
    const prob = picked.reduce((p, l) => p * (l.probability / 100), 1);
    tickets.push({
      name,
      verdict: certaintyOf(raw.jistota || raw.verdikt),
      summary: String(raw.shrnuti || raw.zduvodneni || raw.summary || "").trim(),
      legs: picked.map((l) => ({
        id: l.ticketId, tipId: l.id, matchName: l.matchName, league: l.leagueShort || l.league, kickoff: l.kickoff, tipLabel: l.tipLabel,
        odds: l.odds, probability: l.probability, probForebet: l.probForebet ?? null, value: l.value, reason: reasons.get(l.ticketId) || "",
      })),
      totalOdds: Math.round(odds * 100) / 100,
      jointProbability: Math.round(prob * 1000) / 10,
      expectedReturn: Math.round((prob * odds - 1) * 1000) / 10, // v % vsazené částky, jen odhad
    });
  });
  return { tickets, note: String(data.poznamka || data.note || "").trim(), rejected, dropped, skipped: parseSkipped(data.vynechane || data.skipped) };
}

/** Zápasy, které skončily mimo tikety, každý s důvodem (od AI, nebo z toho, co se s ním v aplikaci stalo). */
function omittedMatches(candidates, usableIds, parsed) {
  const keyOf = (c) => `${c.home}|${c.away}|${c.kickoff}`;
  const byId = new Map(candidates.map((c) => [c.ticketId, c]));
  const usedIds = new Set(parsed.tickets.flatMap((t) => t.legs.map((l) => l.id)));
  const usedKeys = new Set([...usedIds].map((id) => keyOf(byId.get(id))));
  const out = [];
  for (const c of candidates) {
    if (usedIds.has(c.ticketId)) continue;
    let kind;
    let reason;
    if (!usableIds.has(c.ticketId)) {
      [kind, reason] = ["nodata", c.sofascoreId ? "statistiky ze SofaScore se nepodařilo stáhnout" : "zápas se nepodařilo najít na SofaScore"];
    } else if (usedKeys.has(keyOf(c))) {
      [kind, reason] = ["same", "zápas je už v tiketu s jiným tipem"];
    } else if (parsed.skipped.get(c.ticketId)) {
      [kind, reason] = ["model", parsed.skipped.get(c.ticketId)];
    } else if (parsed.dropped.has(c.ticketId)) {
      [kind, reason] = ["rule", `navržený tiket byl zahozen (${parsed.dropped.get(c.ticketId)})`];
    } else {
      [kind, reason] = ["model", "Gemini ho do žádného tiketu nezařadil a nezdůvodnil proč"];
    }
    out.push({ id: c.ticketId, matchName: c.matchName, tipLabel: c.tipLabel, odds: c.odds, probability: c.probability, kickoff: c.kickoff, kind, reason });
  }
  return out;
}

/**
 * Zápasy z čekajících tiketů, které začnou do `minutes` minut a ještě se o nich neupozornilo (`notified` = Set klíčů).
 * Vrací [{ key, matchName, ticketName, minutes }] a klíče si zapíše do `notified`.
 */
function dueKickoffs(tickets, outcomes, now = new Date(), notified = new Set(), minutes = 15) {
  const out = [];
  for (const t of tickets) {
    if (t.legs.some((l) => outcomes.get(l.tipId) === "loss")) continue;       // prohraný tiket už nezajímá
    for (const l of t.legs) {
      const left = (Date.parse(l.kickoff) - now.getTime()) / 60000;
      const key = `${t.id}:${l.tipId}`;
      if (left > 0 && left <= minutes && !outcomes.get(l.tipId) && !notified.has(key)) {
        notified.add(key);
        out.push({ key, matchName: l.matchName, ticketName: t.name, minutes: Math.ceil(left) });
      }
    }
  }
  return out;
}

const round1 = (x) => Math.round(x * 10) / 10;

/** Výsledek uloženého tiketu z výsledků jeho tipů (`outcomes`: tipId → win/loss/void): prohra kteréhokoli tipu = prohra, vrácený tip se přeskočí. */
function settleTicket(ticket, outcomes) {
  const legs = ticket.legs.map((l) => ({ ...l, outcome: outcomes.get(l.tipId) || null }));
  const won = legs.filter((l) => l.outcome === "win");
  let status = "pending";
  if (legs.some((l) => l.outcome === "loss")) status = "loss";
  else if (legs.every((l) => l.outcome)) status = won.length ? "win" : "void";
  const effectiveOdds = status === "win" ? Math.round(won.reduce((p, l) => p * l.odds, 1) * 100) / 100 : null;
  const profit = status === "win" ? effectiveOdds - 1 : status === "loss" ? -1 : status === "void" ? 0 : null; // vklad 1 na tiket
  return { ...ticket, legs, status, effectiveOdds, profit };
}

/** Souhrn vyhodnocených tiketů ve tvaru jako u tipů v Analýze: počet, průměrný odhad, skutečná úspěšnost, rozdíl, ROI. */
function ticketStats(settled) {
  const done = settled.filter((t) => t.status === "win" || t.status === "loss");
  const n = done.length;
  const wins = done.filter((t) => t.status === "win").length;
  const out = { n, wins, pending: settled.filter((t) => t.status === "pending").length, predicted: null, actual: null, gap: null, roi: null };
  if (!n) return out;
  out.predicted = round1(done.reduce((s, t) => s + t.jointProbability, 0) / n);
  out.actual = round1((100 * wins) / n);
  out.gap = round1(out.actual - out.predicted);
  out.roi = round1((100 * done.reduce((s, t) => s + t.profit, 0)) / n);
  return out;
}

/**
 * Celý postup: statistiky ze SofaScore → sestavení tiketů v Gemini. `collect(candidates, progress)` stáhne statistiky
 * (matchstats.js), `ask` je funkce `generate` z analysis.js (s klíčem a síťovou funkcí), `progress` dostává zprávy o průběhu.
 * Vrací { tickets, note, analyzed, covered, rejected, omitted } (omitted = zápasy mimo tikety s důvodem; `log` dostane text pro ladicí soubor).
 */
async function createTickets({ candidates, collect, ask, calibration = null, progress = () => {}, now = new Date(), hint = "", log = () => {} }) {
  if (candidates.length < MIN_LEGS) {
    throw new Error(`Na tikety je málo vhodných tipů (${candidates.length}): potřebuju alespoň ${MIN_LEGS}, které ještě nezačaly a mají skutečný kurz. Zkus jiný den, nebo nejdřív stáhni tipy.`);
  }
  const data = await collect(candidates, progress);
  const usable = candidates.filter((c) => data.stats[c.ticketId]);
  if (usable.length < MIN_LEGS) {
    const why = data.blocked ? "SofaScore zamítá dotazy (ochrana proti robotům), zkus to později."
      : data.noId === candidates.length ? "Zápasy nemají přiřazený zápas na SofaScore – zkus nejdřív „Obnovit tipy“."
        : `Statistiky se podařilo najít jen ke ${usable.length} z ${candidates.length} zápasů.`;
    throw new Error(`Ze SofaScore se nepodařilo získat statistiky aspoň ke ${MIN_LEGS} zápasům. ${why}${hint}`);
  }
  progress("Gemini vyhodnocuje statistiky a sestavuje tikety…");
  const prompt = buildTicketPrompt(usable, data.stats, { calibration, now });
  let parsed = null;
  let text = "";
  for (let attempt = 0; !parsed; attempt += 1) {
    text = (await ask({ prompt, json: true, temperature: null, maxTokens: 8000, timeoutMs: ASSEMBLE_TIMEOUT })).text;
    try {
      parsed = parseTickets(text, usable);
    } catch (err) {
      if (attempt) { log(`Tikety – ${new Date().toISOString()}\nNeplatná odpověď Gemini:\n${text}\n`); throw err; }      // neplatný JSON: jeden další pokus
    }
  }
  log([`Tikety – ${new Date().toISOString()}`, `Zápasů: ${candidates.length}, se statistikami: ${usable.length}, tiketů: ${parsed.tickets.length}, zahozených: ${parsed.rejected.length}`, "",
    "=== ODPOVĚĎ GEMINI ===", text, "", "=== ZAHOZENÉ TIKETY ===", ...parsed.rejected, "", "=== ZADÁNÍ ===", prompt, ""].join("\n"));
  if (!parsed.tickets.length && parsed.rejected.length) {
    throw new Error(`AI navrhla tikety, které nesplňují pravidla (${parsed.rejected.slice(0, 3).join("; ")}). Zkus to znovu.`);
  }
  return {
    tickets: parsed.tickets, note: parsed.note, analyzed: candidates.length, covered: usable.length, rejected: parsed.rejected.length,
    omitted: omittedMatches(candidates, new Set(usable.map((c) => c.ticketId)), parsed),
  };
}

module.exports = {
  candidatesFrom, buildTicketPrompt, parseTickets, createTickets, settleTicket, ticketStats, dueKickoffs,
  MIN_LEGS,
};
