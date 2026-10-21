// Tikety (2–5 tipů): kandidáti z uložených tipů, zadání pro Gemini a kontrola odpovědi.
// Čísla tiketu (kurz, pravděpodobnost, očekávaný výnos) se počítají vždy zde – z AI se berou jen výběr tipů a komentáře.
"use strict";

const { addDays, fmtHourMinute, todayLocal } = require("./timeutil");

const MIN_LEGS = 2;
const MAX_LEGS = 5;
const MAX_CANDIDATES = 40;
const VERDICTS = { good: "good", dobry: "good", dobrý: "good", ok: "ok", prumerny: "ok", průměrný: "ok", risky: "risky", riziko: "risky", rizikovy: "risky", rizikový: "risky" };

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").trim();
const verdictOf = (v) => VERDICTS[norm(v)] || VERDICTS[String(v || "").toLowerCase().trim()] || "ok";

/**
 * Kandidáty jsou tipy, které ještě nezačaly, mají skutečný (ne odhadnutý) kurz a patří do zvoleného dne.
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

function buildTicketPrompt(candidates, { legs, count, calibration }) {
  const rows = candidates.map((t) => ({
    id: t.ticketId, zapas: t.matchName, soutez: t.leagueShort || t.league, zacatek: fmtHourMinute(new Date(t.kickoff)), tip: t.tipLabel,
    pravdepodobnost: t.probability, kurz: t.odds, forebet: t.probForebet, value: t.value,
  }));
  const cal = calibration && calibration.overall && calibration.overall.n
    ? `Moje dosavadní výsledky: ${calibration.overall.n} vyhodnocených tipů, skutečná úspěšnost ${calibration.overall.actual} % při průměrném odhadu ${calibration.overall.predicted} % (rozdíl ${calibration.overall.gap} p. b.). Pásma: ${JSON.stringify(calibration.bands.filter((b) => b.n).map((b) => ({ pasmo: b.label, n: b.n, odhad: b.predicted, skutecnost: b.actual })))}.`
    : "Zatím nemám dost vyhodnocených tipů, takže kalibraci pravděpodobnosti neznám.";
  return `Sestav ${count} různé tikety (kombinace) po přesně ${legs} tipech z nabídky níže. Každý tip je z jiného zápasu (nikdy dva tipy ze stejného zápasu). `
    + `Tikety se mají lišit sadou tipů. Pravděpodobnost je odhad zdroje, NE kalibrovaná šance; kurzy jsou orientační. `
    + `Vyber tipy s dobrým poměrem pravděpodobnosti a kurzu, pozor na vzájemně související tipy a na příliš nízké kurzy.\n\n${cal}\n\n`
    + `NABÍDKA (JSON): ${JSON.stringify(rows)}\n\n`
    + `Odpověz POUZE JSON podle tohoto tvaru (česky, bez dalšího textu):\n`
    + `{"tikety":[{"nazev":"krátký název","verdikt":"dobry|prumerny|rizikovy","shrnuti":"2–3 věty: je to dobrý tiket a proč, hlavní riziko",`
    + `"tipy":[{"id":"t1","verdikt":"dobry|prumerny|rizikovy","komentar":"1 věta, zda je to dobrý tip"}]}]}`;
}

/** Vytáhne JSON i z odpovědi obalené v ```json … ```. */
function parseJson(text) {
  const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("AI nevrátila platný JSON.");
  }
}

/** Zkontroluje odpověď AI a dopočítá čísla. Neplatné tikety (neznámé tipy, duplicitní zápas, špatný počet) zahodí. */
function parseTickets(text, candidates, { legs }) {
  const data = parseJson(text);
  const byId = new Map(candidates.map((c) => [c.ticketId, c]));
  const out = [];
  for (const raw of (data && (data.tikety || data.tickets)) || []) {
    const items = raw.tipy || raw.legs || [];
    const seenMatches = new Set();
    const seenIds = new Set();
    const picked = [];
    let ok = items.length >= MIN_LEGS && items.length <= MAX_LEGS && items.length === legs;
    for (const it of items) {
      const c = byId.get(it.id);
      if (!c || seenIds.has(it.id)) { ok = false; break; }
      const matchKey = `${c.home}|${c.away}|${c.kickoff}`;
      if (seenMatches.has(matchKey)) { ok = false; break; }
      seenIds.add(it.id);
      seenMatches.add(matchKey);
      picked.push({ ...c, verdict: verdictOf(it.verdikt), comment: String(it.komentar || it.comment || "").trim() });
    }
    if (!ok || !picked.length) continue;
    const odds = picked.reduce((p, l) => p * l.odds, 1);
    const prob = picked.reduce((p, l) => p * (l.probability / 100), 1);
    out.push({
      name: String(raw.nazev || raw.name || "Tiket").trim(),
      verdict: verdictOf(raw.verdikt),
      summary: String(raw.shrnuti || raw.summary || "").trim(),
      legs: picked.map((l) => ({
        id: l.ticketId, matchName: l.matchName, league: l.leagueShort || l.league, kickoff: l.kickoff, tipLabel: l.tipLabel,
        odds: l.odds, probability: l.probability, probForebet: l.probForebet ?? null, value: l.value, verdict: l.verdict, comment: l.comment,
      })),
      totalOdds: Math.round(odds * 100) / 100,
      jointProbability: Math.round(prob * 1000) / 10,
      expectedReturn: Math.round((prob * odds - 1) * 1000) / 10, // v % vsazené částky, jen odhad
    });
  }
  return out;
}

module.exports = { candidatesFrom, buildTicketPrompt, parseTickets, parseJson, MIN_LEGS, MAX_LEGS };
