// Na co sázet a na co ne podle výsledků uložených tiketů: skupiny tiketů (počet zápasů, jistota podle AI, kurz) a tipů v nich
// (typ tipu, soutěž, pravděpodobnost) se porovnají podle skutečné úspěšnosti a ROI. Doporučení se dává jen u skupin s dost případy.
"use strict";

const { marketGroup } = require("./analysis");

const MIN_TICKETS = 4;   // tiketů ve skupině, aby šlo o skupině něco říct
const MIN_LEGS = 6;      // tipů ve skupině
const BET_ROI = 5;       // ROI v %, od kterého se skupina doporučí
const AVOID_ROI = -10;   // ROI v %, pod kterým se skupina nedoporučí
const GAP_AVOID = -10;   // rozdíl úspěšnosti a odhadu (p. b.), od kterého se tipy nedoporučí

const round1 = (x) => Math.round(x * 10) / 10;
const signed = (x) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${String(Math.abs(round1(x))).replace(".", ",")}`;
const pctText = (x) => String(round1(x)).replace(".", ",");

const CERTAINTY = { good: "Jistota AI: vysoká", ok: "Jistota AI: střední", risky: "Jistota AI: nižší" };

function ticketBuckets(t) {
  const n = t.legs.length;
  const odds = t.totalOdds;
  return [
    ["Tikety o 2 zápasech", n === 2], ["Tikety o 3 zápasech", n === 3], ["Tikety o 4–5 zápasech", n >= 4],
    ...Object.entries(CERTAINTY).map(([k, label]) => [label, t.verdict === k]),
    ["Tikety s kurzem do 3,00", odds < 3], ["Tikety s kurzem 3,00–5,00", odds >= 3 && odds < 5], ["Tikety s kurzem nad 5,00", odds >= 5],
  ].filter(([, on]) => on).map(([label]) => label);
}

function legBuckets(l) {
  const p = l.probability;
  return [
    `Typ tipu: ${marketGroup(l.tipCode)}`,
    l.league ? `Soutěž: ${l.league}` : null,
    p < 70 ? "Pravděpodobnost 60–70 %" : p < 80 ? "Pravděpodobnost 70–80 %" : "Pravděpodobnost nad 80 %",
  ].filter(Boolean);
}

function addTo(map, label, item) {
  if (!map.has(label)) map.set(label, []);
  map.get(label).push(item);
}

/**
 * @param {object[]} settled  tikety po `settleTicket` (status, profit, totalOdds, verdict, legs s outcome/odds/probability/league/tipId)
 * @param {Map} tipInfo       tipId → { tipCode } (z databáze; pro skupinu „typ tipu“)
 * @returns {{ tickets: number, legs: number, bet: object[], avoid: object[], note: string }}
 */
function ticketAdvice(settled, tipInfo = new Map()) {
  const done = settled.filter((t) => t.status === "win" || t.status === "loss");
  const tickets = new Map();
  for (const t of done) for (const label of ticketBuckets(t)) addTo(tickets, label, t);

  // každý tip jednou, i když byl ve více tiketech
  const legsById = new Map();
  for (const t of settled) {
    for (const l of t.legs) {
      if ((l.outcome === "win" || l.outcome === "loss") && Number.isFinite(l.tipId) && !legsById.has(l.tipId)) {
        legsById.set(l.tipId, { ...l, tipCode: (tipInfo.get(l.tipId) || {}).tipCode || "" });
      }
    }
  }
  const legs = new Map();
  for (const l of legsById.values()) for (const label of legBuckets(l)) addTo(legs, label, l);

  const bet = [];
  const avoid = [];
  const judge = (label, list, { minN, isTicket }) => {
    const n = list.length;
    if (n < minN) return;
    const wins = list.filter((x) => (isTicket ? x.status : x.outcome) === "win").length;
    const profit = list.reduce((s, x) => s + (isTicket ? x.profit : (x.outcome === "win" ? x.odds - 1 : -1)), 0);
    const roi = (100 * profit) / n;
    const hit = (100 * wins) / n;
    const predicted = list.reduce((s, x) => s + (isTicket ? x.jointProbability : x.probability), 0) / n;
    const gap = hit - predicted;
    const what = isTicket ? "tiketů" : "tipů";
    const text = `vyhráno ${wins} z ${n} ${what} (${pctText(hit)} %), ROI ${signed(roi)} %${isTicket ? "" : `, odhad ${pctText(predicted)} %`}`;
    const item = { label, n, wins, roi: round1(roi), hit: round1(hit), text };
    if (roi >= BET_ROI && (isTicket || gap >= -3)) bet.push(item);
    else if (roi <= AVOID_ROI || (!isTicket && gap <= GAP_AVOID)) avoid.push(item);
  };
  for (const [label, list] of tickets) judge(label, list, { minN: MIN_TICKETS, isTicket: true });
  for (const [label, list] of legs) judge(label, list, { minN: MIN_LEGS, isTicket: false });
  bet.sort((a, b) => b.roi - a.roi);
  avoid.sort((a, b) => a.roi - b.roi);

  let note;
  if (!done.length) {
    note = settled.length
      ? "Uložené tikety zatím čekají na výsledky zápasů – doporučení se objeví po prvních vyhodnocených tiketech."
      : "Zatím nejsou uložené žádné tikety. Vytvoř je v záložce Tikety, po zápasech se tady ukáže, na co sázet a na co ne.";
  } else {
    const wins = done.filter((t) => t.status === "win").length;
    const roi = (100 * done.reduce((s, t) => s + t.profit, 0)) / done.length;
    note = `Vyhodnoceno ${done.length} tiketů (vyhráno ${wins}, ROI ${signed(roi)} %) a ${legsById.size} tipů v nich.`;
    if (!bet.length && !avoid.length) note += ` Žádná skupina zatím nevybočuje – doporučení se dává od ${MIN_TICKETS} tiketů nebo ${MIN_LEGS} tipů ve skupině.`;
    else if (done.length < 15) note += " Vzorek je malý, berte to jako orientační.";
  }
  return { tickets: done.length, legs: legsById.size, bet: bet.slice(0, 5), avoid: avoid.slice(0, 5), note };
}

module.exports = { ticketAdvice, MIN_TICKETS, MIN_LEGS };
