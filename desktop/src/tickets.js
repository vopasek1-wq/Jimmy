// Tikety (2–5 tipů): kandidáti z uložených tipů a dva kroky přes Gemini:
//   1) vyhledání aktuálních statistik každého zápasu na webu (forma, H2H, góly, zranění, domácí/venku),
//   2) sestavení tiketů z nalezených podkladů (JSON) a kontrola odpovědi.
// Čísla tiketu (kurz, pravděpodobnost, očekávaný výnos) se počítají vždy zde – z AI se berou jen výběr tipů a zdůvodnění.
"use strict";

const { addDays, fmtHourMinute, todayLocal } = require("./timeutil");

const MIN_LEGS = 2;
const MAX_LEGS = 5;
const MIN_TOTAL_ODDS = 2;       // minimální kombinovaný kurz tiketu
const MAX_CANDIDATES = 20;      // víc zápasů najednou už Gemini neprohledá spolehlivě
const RESEARCH_TIMEOUT = 300000;
const ASSEMBLE_TIMEOUT = 120000;
const COVERAGE = 0.8;           // podíl zápasů, ke kterým musí vyhledávání vrátit podklady

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

const RESEARCH_SYSTEM = "Jsi analytik fotbalových sázek. Statistiky zjišťuj vyhledáváním na webu (Google) – nespoléhej na paměť, ta bývá zastaralá. "
  + "Nic si nevymýšlej ani neodhaduj: údaj, který nenajdeš, označ „nenalezeno“. Odpovídáš česky, stručně a věcně.";

/** Krok 1: pro každý zápas z nabídky vyhledat statistiky (výstup je prostý text po blocích, ne JSON). */
function buildResearchPrompt(candidates, { now = new Date() } = {}) {
  const rows = candidates.map((t) => `${t.ticketId} | ${t.matchName} | ${t.leagueShort || t.league} | ${czDate(t.day)} ${fmtHourMinute(new Date(t.kickoff))} | tip: ${t.tipLabel} | pravděpodobnost zdroje ${t.probability} % | kurz ${t.odds}`);
  return `Dnes je ${czDate(todayLocal(now))}. Pro KAŽDÝ zápas z nabídky níže vyhledej na webu aktuální statistiky a posuď je ve vztahu k tipu u zápasu (podporují čísla právě tento tip?):\n`
    + `1. forma obou týmů – výsledky posledních 5 zápasů (V/R/P a skóre),\n`
    + `2. vzájemné zápasy (H2H) – několik posledních,\n`
    + `3. střelecká produktivita – góly vstřelené a obdržené na zápas, u gólových tipů i četnost Over/Under a obou týmů skórujících,\n`
    + `4. zranění, absence a suspendace klíčových hráčů,\n`
    + `5. domácí výkonnost domácího týmu a venkovní výkonnost hostů v aktuální sezóně.\n\n`
    + `Pro každý zápas napiš přesně tento blok (žádný zápas nevynechej ani nesluč, ID zachovej v hranatých závorkách):\n`
    + `[t1] Domácí – Hosté | tip: …\nForma: domácí …; hosté …\nH2H: …\nGóly: …\nZranění: …\nDoma/venku: …\n`
    + `Podpora tipu: SILNÁ | STŘEDNÍ | SLABÁ | NEDOSTATEČNÁ DATA – jedna věta proč\n\n`
    + `Co se nepodaří dohledat, napiš „nenalezeno“. Pokud dat není dost na posouzení tipu, uveď NEDOSTATEČNÁ DATA. Piš česky, každý řádek stručně, na konec nic nepřidávej.\n\n`
    + `NABÍDKA (ID | zápas | soutěž | začátek | tip | pravděpodobnost | kurz):\n${rows.join("\n")}`;
}

function calibrationLine(calibration) {
  return calibration && calibration.overall && calibration.overall.n
    ? `Moje dosavadní výsledky: ${calibration.overall.n} vyhodnocených tipů, skutečná úspěšnost ${calibration.overall.actual} % při průměrném odhadu ${calibration.overall.predicted} % (rozdíl ${calibration.overall.gap} p. b.). Pásma: ${JSON.stringify(calibration.bands.filter((b) => b.n).map((b) => ({ pasmo: b.label, n: b.n, odhad: b.predicted, skutecnost: b.actual })))}.`
    : "Zatím nemám dost vyhodnocených tipů, takže kalibraci pravděpodobnosti neznám.";
}

/** Krok 2: z nabídky a nalezených podkladů sestavit tikety (odpověď v JSON režimu). */
function buildAssemblePrompt(candidates, research, { calibration = null, now = new Date() } = {}) {
  const rows = candidates.map((t) => ({ id: t.ticketId, zapas: t.matchName, soutez: t.leagueShort || t.league, zacatek: `${czDate(t.day)} ${fmtHourMinute(new Date(t.kickoff))}`, tip: t.tipLabel, pravdepodobnost: t.probability, kurz: t.odds }));
  return `Z nabídky a podkladů níže sestav tikety (dnes je ${czDate(todayLocal(now))}).\n\n`
    + `PRAVIDLA:\n`
    + `- Vyber pouze sázky s dobrou pravděpodobností úspěchu podle podkladů. Zápas, u kterého je podpora tipu SLABÁ nebo NEDOSTATEČNÁ DATA nebo který v podkladech chybí, do žádného tiketu nezařazuj. Vyhýbej se riskantním sázkám bez datové opory.\n`
    + `- Vybrané zápasy rozděl do tiketů logicky: nejjistější tipy seskupuj dohromady (první tiket je nejjistější, další jsou méně jisté).\n`
    + `- Maximálně ${MAX_LEGS} zápasy na tiket, minimálně ${MIN_LEGS}.\n`
    + `- Minimální kombinovaný kurz tiketu (součin kurzů tipů) je ${MIN_TOTAL_ODDS.toFixed(2)}. Tiket, který to nesplňuje, nevytvářej.\n`
    + `- Každý zápas smí být nejvýš v jednom tiketu.\n`
    + `- Zdůvodnění tiketu: 2–4 věty, stručné, věcné a srozumitelné pro běžného sázkaře; odkaž na formu týmů, vzájemné zápasy, góly, zranění nebo domácí/venkovní výkonnost z podkladů. Nepřidávej fakta, která v podkladech nejsou.\n`
    + `- Piš česky.\n`
    + `- Pokud žádný tiket pravidla nesplňuje, vrať prázdné pole "tikety" a v "poznamka" stručně napiš proč.\n\n`
    + `${calibrationLine(calibration)} Pravděpodobnost v nabídce je odhad zdroje, ne kalibrovaná šance.\n\n`
    + `NABÍDKA (JSON): ${JSON.stringify(rows)}\n\n`
    + `PODKLADY (výsledek vyhledávání na webu):\n${research}\n\n`
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

/** ID zápasů, ke kterým vyhledávání vrátilo blok `[t1] …`. */
function coveredIds(text, candidates) {
  const known = new Set(candidates.map((c) => c.ticketId));
  const found = new Set();
  for (const m of String(text || "").matchAll(/\[\s*(t\d+)\s*\]/gi)) if (known.has(m[1].toLowerCase())) found.add(m[1].toLowerCase());
  return found;
}

/** Vyhledání statistik; neúplný výsledek (model nevyhledával, nebo chybí zápasy) se zkusí ještě jednou a vybere se lepší pokus. */
async function gatherResearch({ candidates, ask, progress, now }) {
  const prompt = buildResearchPrompt(candidates, { now });
  const need = Math.ceil(candidates.length * COVERAGE);
  const score = (r) => (r.grounded ? 1000 : 0) + r.covered;
  let best = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) progress("Výsledek vyhledávání je neúplný, zkouším to ještě jednou…");
    let reply;
    try {
      reply = await ask({ prompt, system: RESEARCH_SYSTEM, search: true, temperature: null, maxTokens: 12000, timeoutMs: RESEARCH_TIMEOUT });
    } catch (err) {
      if (best) break;       // první pokus aspoň něco dal
      throw err;
    }
    const cur = { text: reply.text, grounded: Boolean(reply.grounded), searches: (reply.queries || []).length, covered: coveredIds(reply.text, candidates).size };
    if (!best || score(cur) > score(best)) best = cur;
    if (cur.grounded && cur.covered >= need) break;
  }
  return best;
}

/**
 * Celý postup: vyhledání statistik → sestavení tiketů. `ask` je funkce `generate` z analysis.js (s klíčem a síťovou funkcí),
 * `progress` dostává textové zprávy o průběhu. Vrací { tickets, note, analyzed, covered, grounded, searches }.
 */
async function createTickets({ candidates, ask, calibration = null, progress = () => {}, now = new Date() }) {
  if (candidates.length < MIN_LEGS) {
    throw new Error(`Na tikety je málo vhodných tipů (${candidates.length}): potřebuju alespoň ${MIN_LEGS}, které ještě nezačaly a mají skutečný kurz. Zkus jiný den, nebo nejdřív stáhni tipy.`);
  }
  progress("Gemini vyhledává statistiky zápasů: forma, vzájemné zápasy, góly, zranění…");
  const research = await gatherResearch({ candidates, ask, progress, now });
  progress("Gemini sestavuje tikety z nalezených statistik…");
  const prompt = buildAssemblePrompt(candidates, research.text, { calibration, now });
  let parsed = null;
  for (let attempt = 0; !parsed; attempt += 1) {
    const reply = await ask({ prompt, json: true, temperature: null, maxTokens: 8000, timeoutMs: ASSEMBLE_TIMEOUT });
    try {
      parsed = parseTickets(reply.text, candidates);
    } catch (err) {
      if (attempt) throw err;      // neplatný JSON: jeden další pokus
    }
  }
  if (!parsed.tickets.length && parsed.rejected.length) {
    throw new Error(`AI navrhla tikety, které nesplňují pravidla (${parsed.rejected.slice(0, 3).join("; ")}). Zkus to znovu.`);
  }
  return {
    tickets: parsed.tickets, note: parsed.note, analyzed: candidates.length, covered: research.covered, grounded: research.grounded, searches: research.searches,
  };
}

module.exports = {
  candidatesFrom, buildResearchPrompt, buildAssemblePrompt, parseTickets, parseJson, coveredIds, createTickets,
  MIN_LEGS, MAX_LEGS, MIN_TOTAL_ODDS, MAX_CANDIDATES,
};
