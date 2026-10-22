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
    + `PRAVIDLA:\n`
    + `- Vyber pouze sázky s dobrou pravděpodobností úspěchu podle statistik. Zápas, u kterého nejsou statistiky dostatečné nebo tip nepodporují, do žádného tiketu nezařazuj. Vyhýbej se riskantním sázkám bez datové opory.\n`
    + `- Vybrané zápasy rozděl do tiketů logicky: nejjistější tipy seskupuj dohromady (první tiket je nejjistější, další jsou méně jisté).\n`
    + `- Maximálně ${MAX_LEGS} zápasy na tiket, minimálně ${MIN_LEGS}.\n`
    + `- Minimální kombinovaný kurz tiketu (součin kurzů tipů) je ${MIN_TOTAL_ODDS.toFixed(2)}. Tiket, který to nesplňuje, nevytvářej.\n`
    + `- Každý zápas smí být nejvýš v jednom tiketu.\n`
    + `- Zdůvodnění tiketu: 2–4 věty, stručné, věcné a srozumitelné pro běžného sázkaře; odkaž na formu týmů, vzájemné zápasy, góly, zranění nebo domácí/venkovní výkonnost z dodaných statistik. Nepřidávej čísla ani fakta, která ve statistikách nejsou. Chybějící údaj (zraneni není uvedeno) nic nedokazuje.\n`
    + `- Piš česky.\n`
    + `- Pokud žádný tiket pravidla nesplňuje, vrať prázdné pole "tikety" a v "poznamka" stručně napiš proč.\n\n`
    + `${calibrationLine(calibration)} Pravděpodobnost v nabídce je odhad zdroje, ne kalibrovaná šance.\n\n`
    + `NABÍDKA SE STATISTIKAMI (JSON): ${JSON.stringify(rows)}\n\n`
    + `Odpověz POUZE JSON podle tohoto tvaru (česky, bez dalšího textu):\n`
    + `{"tikety":[{"nazev":"Tiket 1","jistota":"vysoka|stredni|nizsi","zduvodneni":"2–4 věty","tipy":["t1","t4"]}],"poznamka":""}`;
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

/**
 * Zkontroluje odpověď AI a dopočítá čísla. Zahodí tikety s neznámým tipem, špatným počtem zápasů (2–5),
 * zápasem použitým už v dřívějším tiketu nebo s kombinovaným kurzem pod minimem.
 * Vrací { tickets, note, rejected: [důvod, …] }.
 */
function parseTickets(text, candidates) {
  const data = parseJson(text) || {};
  const list = Array.isArray(data) ? data : data.tikety || data.tickets || [];
  const byId = new Map(candidates.map((c) => [c.ticketId, c]));
  const usedMatches = new Set();
  const tickets = [];
  const rejected = [];
  (Array.isArray(list) ? list : []).forEach((raw, i) => {
    const name = String((raw && (raw.nazev || raw.name)) || `Tiket ${i + 1}`).trim();
    const reject = (why) => rejected.push(`${name}: ${why}`);
    const items = ((raw && (raw.tipy || raw.legs)) || []).map((x) => String(x && typeof x === "object" ? x.id : x).replace(/[[\]\s]/g, "").toLowerCase());
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
      summary: String(raw.zduvodneni || raw.shrnuti || raw.summary || "").trim(),
      legs: picked.map((l) => ({
        id: l.ticketId, matchName: l.matchName, league: l.leagueShort || l.league, kickoff: l.kickoff, tipLabel: l.tipLabel,
        odds: l.odds, probability: l.probability, probForebet: l.probForebet ?? null, value: l.value,
      })),
      totalOdds: Math.round(odds * 100) / 100,
      jointProbability: Math.round(prob * 1000) / 10,
      expectedReturn: Math.round((prob * odds - 1) * 1000) / 10, // v % vsazené částky, jen odhad
    });
  });
  return { tickets, note: String(data.poznamka || data.note || "").trim(), rejected };
}

/**
 * Celý postup: statistiky ze SofaScore → sestavení tiketů v Gemini. `collect(candidates, progress)` stáhne statistiky
 * (matchstats.js), `ask` je funkce `generate` z analysis.js (s klíčem a síťovou funkcí), `progress` dostává zprávy o průběhu.
 * Vrací { tickets, note, analyzed, covered }.
 */
async function createTickets({ candidates, collect, ask, calibration = null, progress = () => {}, now = new Date(), hint = "" }) {
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
  for (let attempt = 0; !parsed; attempt += 1) {
    const reply = await ask({ prompt, json: true, temperature: null, maxTokens: 8000, timeoutMs: ASSEMBLE_TIMEOUT });
    try {
      parsed = parseTickets(reply.text, usable);
    } catch (err) {
      if (attempt) throw err;      // neplatný JSON: jeden další pokus
    }
  }
  if (!parsed.tickets.length && parsed.rejected.length) {
    throw new Error(`AI navrhla tikety, které nesplňují pravidla (${parsed.rejected.slice(0, 3).join("; ")}). Zkus to znovu.`);
  }
  return { tickets: parsed.tickets, note: parsed.note, analyzed: candidates.length, covered: usable.length };
}

module.exports = {
  candidatesFrom, buildTicketPrompt, parseTickets, parseJson, createTickets,
  MIN_LEGS, MAX_LEGS, MIN_TOTAL_ODDS, MAX_CANDIDATES,
};
