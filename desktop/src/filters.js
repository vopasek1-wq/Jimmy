// Povinné filtry tipů (ze zadání). Tip se zobrazí, jen když platí všechno z toho:
//   1. soutěž je ve sledovaném seznamu (config.LEAGUES),
//   2. pravděpodobnost je STRIKTNĚ vyšší než 60 %,
//   3. kurz je alespoň 1,50 (ze zdroje, nebo – když chybí – odhadnutý z pravděpodobnosti).
"use strict";

const config = require("./config");
const { estimateOdds } = require("./odds");

const HIGH = "high";
const MID = "mid";

/** Doplní odhad kurzu, pokud zdroj žádný neuvedl (a označí ho jako odhad). */
function ensureOdds(tip) {
  if (tip.odds === null || tip.odds === undefined) {
    const est = estimateOdds(tip.probability);
    if (est !== null) {
      tip.odds = est;
      tip.oddsEstimated = true;
    }
  }
  return tip;
}

// Ženské zápasy se nesledují: „Cruzeiro W“, „Arsenal Women“, „… (W)“, „Femenina“, „Frauen“ apod.
const WOMENS = /(?:^|\s)(?:W|Women|Womens|Women's|Ladies|Femenina|Femenino|Feminino|Féminin|Feminin|Femminile|Frauen|Vrouwen|Kobiet)\)?$|\((?:W|Women)\)|\bwomen\b/i;
const isWomens = (tip) => WOMENS.test(String(tip.home || "").trim()) || WOMENS.test(String(tip.away || "").trim());

const cs = (x) => String(x).replace(".", ","); // 1.5 → „1,5“

// Názvy důvodů zamítnutí do souhrnu v diagnostice.
const REASON_NAMES = {
  women: "ženský zápas",
  league: "soutěž se nesleduje",
  noprob: "bez pravděpodobnosti",
  lowprob: `pravděpodobnost do ${cs(config.MIN_PROBABILITY)} %`,
  noodds: "bez kurzu",
  lowodds: `kurz pod ${cs(config.MIN_ODDS.toFixed(2))}`,
};

/** Proč tip filtrem neprošel: { code, text }, nebo null, když prošel. Pořadí kontrol je pořadí povinných podmínek. */
function rejectReason(tip) {
  if (isWomens(tip)) return { code: "women", text: "ženský zápas" };
  const league = config.leagueByKey(tip.leagueKey);
  if (!league || !league.enabled) return { code: "league", text: "soutěž se nesleduje" };
  const p = tip.probability;
  if (p === null || p === undefined) return { code: "noprob", text: "bez pravděpodobnosti" };
  if (!(p > config.MIN_PROBABILITY)) {
    const src = tip.probSource ? ` (${tip.probSource})` : "";
    return { code: "lowprob", text: `pravděpodobnost ${cs(Math.round(p * 10) / 10)} %${src} není nad ${cs(config.MIN_PROBABILITY)} %` };
  }
  if (tip.odds === null || tip.odds === undefined) return { code: "noodds", text: "chybí kurz" };
  if (!(tip.odds >= config.MIN_ODDS)) return { code: "lowodds", text: `kurz ${cs(tip.odds)} je pod ${cs(config.MIN_ODDS.toFixed(2))}` };
  return null;
}

/** Doplní kurzy a rozdělí tipy na ty, které splnily všechny povinné podmínky, a zamítnuté i s důvodem. */
function splitByFilters(tips) {
  const passed = [];
  const rejected = [];
  for (const tip of tips.map(ensureOdds)) {
    const reason = rejectReason(tip);
    if (reason === null) passed.push(tip);
    else rejected.push({ tip, reason });
  }
  return { passed, rejected };
}

/**
 * Má smysl pro tip stahovat doplňující data? Platí, když by po doplnění pravděpodobnosti z Forebetu mohl projít filtry
 * (pravděpodobnost bez zdroje se doplní až z Forebetu). Šetří dotazy na tipy, které se stejně zahodí.
 */
function mayPass(tip) {
  if (isWomens(tip)) return false;
  const league = config.leagueByKey(tip.leagueKey);
  if (!league || !league.enabled) return false;
  if (tip.probability === null || tip.probability === undefined) return true;
  return rejectReason(ensureOdds({ ...tip })) === null;
}

/** Zelená nad 75 %, žlutá v pásmu 60–75 % (včetně 75). */
function probabilityClass(probability) {
  return probability > config.HIGH_PROBABILITY ? HIGH : MID;
}

module.exports = { isWomens, HIGH, MID, REASON_NAMES, rejectReason, mayPass, splitByFilters, probabilityClass };
