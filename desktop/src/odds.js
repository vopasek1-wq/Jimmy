// Převody kurzů: americké / zlomkové / desetinné → desetinné, odhad kurzu.
"use strict";

const { ESTIMATED_MARGIN } = require("./config");

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

/** −143 → 1,70;  +150 → 2,50. */
function americanToDecimal(value) {
  return value < 0 ? 1 + 100 / Math.abs(value) : 1 + value / 100;
}

/**
 * Rozpozná kurz v libovolném běžném formátu a vrátí desetinný kurz (2 desetinná místa).
 * Scores24 podle geolokace IP ukazuje buď desetinné kurzy (1.85), nebo americké (-118).
 * Vrací null, pokud text kurz neobsahuje nebo vychází nesmyslně (≤ 1,00).
 */
function parseOdds(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).trim().replace(/−/g, "-").replace(/[\s ]/g, "");
  if (!s || ["-", "–", "—"].includes(s)) return null;

  let value = null;
  let m;
  if (/^[+-]\d{3,5}$/.test(s)) {
    const n = Number(s);
    if (Math.abs(n) >= 100) value = americanToDecimal(n);
  } else if ((m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(s))) {
    const den = Number(m[2]);
    if (den > 0) value = 1 + Number(m[1]) / den;
  } else if (/^\d{1,3}(?:[.,]\d{1,3})?$/.test(s)) {
    const n = Number(s.replace(",", "."));
    // Holé celé číslo ≥ 100 bez znaménka je americký kurz (+150); jinak desetinný.
    value = n >= 100 ? americanToDecimal(n) : n;
  }
  if (value === null || value <= 1.0) return null;
  return round2(value);
}

/** Odhad kurzu z pravděpodobnosti (v procentech), když zdroj kurz neuvádí. */
function estimateOdds(probability, margin = ESTIMATED_MARGIN) {
  if (!probability || probability <= 0 || probability >= 100) return null;
  return round2((100 / probability) * (1 - margin));
}

/** „1.70“, odhad „~1.60“, chybějící „–“ (UI si tečku mění na čárku samo). */
function fmtOdds(odds, estimated = false) {
  if (odds === null || odds === undefined) return "–";
  return `${estimated ? "~" : ""}${odds.toFixed(2)}`;
}

module.exports = { americanToDecimal, parseOdds, estimateOdds, fmtOdds, round2 };
