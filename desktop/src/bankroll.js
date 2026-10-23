// Bankroll: jak by dopadl stálý vklad na každý vyhodnocený tip / tiket v čase a kolik vsadit na další tip (Kellyho kritérium).
// Počítají se jen sázky se skutečným kurzem; vrácené (void) sázky na bankroll nemají vliv.
"use strict";

const round = (v, d = 2) => { const k = 10 ** d; return Math.round(v * k) / k; };

/** Vyhodnocené tipy se skutečným kurzem → sázky { at, unit } (unit = zisk při vkladu 1). */
function betsFromTips(tips) {
  return tips
    .filter((t) => (t.outcome === "win" || t.outcome === "loss") && t.odds > 1 && !t.oddsEstimated)
    .map((t) => ({ at: Date.parse(t.kickoff), unit: t.outcome === "win" ? t.odds - 1 : -1 }));
}

/** Vyhodnocené tikety (`settleTicket`) → sázky; tiket se vyhodnotí po posledním ze svých zápasů. */
function betsFromTickets(tickets) {
  return tickets
    .filter((t) => (t.status === "win" || t.status === "loss") && Number.isFinite(t.profit))
    .map((t) => ({ at: Math.max(...t.legs.map((l) => Date.parse(l.kickoff)).filter(Number.isFinite)), unit: t.profit }))
    .filter((b) => Number.isFinite(b.at));
}

/**
 * Průběh bankrollu při stálém vkladu `stake` od počáteční částky `start`.
 * Vrací { start, current, profit, staked, roi, bets, wins, maxDrawdown, longestLosing, series: [[čas, bankroll]…] }.
 */
function simulate(bets, { start, stake }) {
  const sorted = [...bets].sort((a, b) => a.at - b.at);
  let bank = start;
  let peak = start;
  let maxDrawdown = 0;
  let losing = 0;
  let longestLosing = 0;
  let wins = 0;
  const series = sorted.length ? [[sorted[0].at - 3600 * 1000, start]] : [];
  for (const b of sorted) {
    bank += b.unit * stake;
    peak = Math.max(peak, bank);
    maxDrawdown = Math.max(maxDrawdown, peak - bank);
    if (b.unit > 0) { wins += 1; losing = 0; } else { losing += 1; longestLosing = Math.max(longestLosing, losing); }
    series.push([b.at, round(bank)]);
  }
  const staked = sorted.length * stake;
  return {
    start, stake, current: round(bank), profit: round(bank - start), staked: round(staked), bets: sorted.length, wins,
    roi: staked ? round((100 * (bank - start)) / staked, 1) : null,
    maxDrawdown: round(maxDrawdown), longestLosing, series,
  };
}

/**
 * Doporučený vklad podle zlomku Kellyho kritéria: f = (p·o − 1) / (o − 1) z bankrollu, násobené `fraction` a omezené `cap`.
 * `probability` je v %, `odds` desetinný kurz. Vrací { stake, share } (share = podíl z bankrollu v %), stake 0 = bez výhody.
 */
function kellyStake({ probability, odds, bankroll, fraction = 0.25, cap = 0.05 }) {
  const p = Number(probability) / 100;
  if (!(p > 0 && p < 1) || !(odds > 1) || !(bankroll > 0)) return { stake: 0, share: 0 };
  const full = (p * odds - 1) / (odds - 1);
  if (full <= 0) return { stake: 0, share: 0 };
  const share = Math.min(full * fraction, cap);
  const raw = bankroll * share;
  const stake = raw >= 100 ? Math.round(raw / 10) * 10 : Math.max(1, Math.round(raw));
  return { stake, share: round(share * 100, 1) };
}

const NUMBER = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Nastavení z okna (může být cokoli) → rozumná čísla. */
function normalizeSettings(s = {}) {
  return {
    start: NUMBER(s.start, 100, 100000000, 10000),
    tipStake: NUMBER(s.tipStake, 1, 10000000, 100),
    ticketStake: NUMBER(s.ticketStake, 1, 10000000, 100),
  };
}

module.exports = { betsFromTips, betsFromTickets, simulate, kellyStake, normalizeSettings };
