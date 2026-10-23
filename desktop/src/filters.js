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

function passesFilters(tip) {
  if (isWomens(tip)) return false;
  const league = config.leagueByKey(tip.leagueKey);
  if (!league || !league.enabled) return false;
  if (tip.probability === null || tip.probability === undefined || !(tip.probability > config.MIN_PROBABILITY)) return false;
  return tip.odds !== null && tip.odds !== undefined && tip.odds >= config.MIN_ODDS;
}

/** Zpracuje kurzy a nechá jen tipy, které splní všechny povinné podmínky. */
function applyFilters(tips) {
  return tips.map(ensureOdds).filter(passesFilters);
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
  return passesFilters(ensureOdds({ ...tip }));
}

/** Zelená nad 75 %, žlutá v pásmu 60–75 % (včetně 75). */
function probabilityClass(probability) {
  return probability > config.HIGH_PROBABILITY ? HIGH : MID;
}

module.exports = { isWomens, HIGH, MID, ensureOdds, passesFilters, mayPass, applyFilters, probabilityClass };
