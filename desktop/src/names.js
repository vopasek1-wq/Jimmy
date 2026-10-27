// Párování názvů týmů mezi zdroji („Brighton & Hove Albion“ vs. „Brighton“).
"use strict";

// Zkratky a předpony, které nenesou informaci o klubu.
const NOISE = new Set(["fc", "cf", "sc", "ac", "as", "afc", "ssc", "us", "rc", "rcd", "fk", "sk", "cd", "ud",
  "sv", "vfb", "vfl", "tsg", "fsv", "calcio", "club", "de", "the", "ii"]);

// Ustálené odlišnosti, které se podobností řetězců nechytí.
const ALIASES = {
  "manchester utd": "manchester united", "man united": "manchester united", "man utd": "manchester united",
  "man city": "manchester city", spurs: "tottenham hotspur", tottenham: "tottenham hotspur",
  wolves: "wolverhampton wanderers", newcastle: "newcastle united", internazionale: "inter",
  "inter milan": "inter", "atletico madrid": "atletico", "athletic club": "athletic bilbao",
  "borussia monchengladbach": "monchengladbach", gladbach: "monchengladbach", psg: "paris saint germain",
  "paris sg": "paris saint germain", "olympique marseille": "marseille", "olympique lyon": "lyon",
  "olympique lyonnais": "lyon", "sparta prague": "sparta praha", "slavia prague": "slavia praha",
  // názvy, které se mezi zdroji liší (přejmenované kluby, anglický × domácí název)
  cologne: "koln", "amed sportif faaliyetler": "amedspor", lisen: "artis brno", "fastav zlin": "trinity zlin",
  "royal charleroi": "charleroi", "sporting charleroi": "charleroi", "oud heverlee": "leuven", "oud heverlee leuven": "leuven", "oh leuven": "leuven",
  "psv eindhoven": "psv", "feyenoord rotterdam": "feyenoord", "sporting lisbon": "sporting cp", "heart of midlothian": "hearts",
};

const stripAccents = (text) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** Malá písmena, bez diakritiky a interpunkce, bez bezvýznamných zkratek (FC, CF…). */
function normalize(name) {
  let s = stripAccents(String(name)).toLowerCase().replace(/ı/g, "i").replace(/&/g, " and "); // tureckou tečkovanou/netečkovanou řeší i
  s = s.replace(/[^a-z0-9 ]+/g, " ");
  s = s.split(/\s+/).filter((t) => t && !NOISE.has(t)).join(" ");
  return Object.prototype.hasOwnProperty.call(ALIASES, s) ? ALIASES[s] : s;
}

/**
 * Totéž co Python difflib.SequenceMatcher(None, a, b).ratio(): 2·M / T, kde M je počet znaků
 * ve shodných blocích nalezených rekurzivně od nejdelšího společného podřetězce.
 */
function sequenceRatio(a, b) {
  const total = a.length + b.length;
  if (total === 0) return 1.0;
  return (2.0 * matchCount(a, 0, a.length, b, 0, b.length)) / total;
}

function longestMatch(a, alo, ahi, b, blo, bhi) {
  // nejdelší společný blok; při shodě délky ten, co začíná nejdřív v a, pak nejdřív v b
  let bestI = alo, bestJ = blo, bestK = 0;
  let prev = new Array(bhi - blo + 1).fill(0);
  for (let i = alo; i < ahi; i++) {
    const cur = new Array(bhi - blo + 1).fill(0);
    for (let j = blo; j < bhi; j++) {
      if (a[i] === b[j]) {
        const k = prev[j - blo] + 1;
        cur[j - blo + 1] = k;
        if (k > bestK) { bestI = i - k + 1; bestJ = j - k + 1; bestK = k; }
      }
    }
    prev = cur;
  }
  return [bestI, bestJ, bestK];
}

function matchCount(a, alo, ahi, b, blo, bhi) {
  if (alo >= ahi || blo >= bhi) return 0;
  const [i, j, k] = longestMatch(a, alo, ahi, b, blo, bhi);
  if (k === 0) return 0;
  return k + matchCount(a, alo, i, b, blo, j) + matchCount(a, i + k, ahi, b, j + k, bhi);
}

function differOnlyByDistinctWord(a, b) {
  // Dva víceslovné názvy sdílí první (nebo poslední) slovo, ale zbytek je jiný klub.
  if (a.length < 2 || b.length < 2) return false;
  const pairs = [
    [a[0], b[0], a.slice(1), b.slice(1)],
    [a[a.length - 1], b[b.length - 1], a.slice(0, -1), b.slice(0, -1)],
  ];
  return pairs.some(([ha, hb, ra, rb]) => ha === hb && sequenceRatio(ra.join(" "), rb.join(" ")) < 0.6);
}

/** Podobnost dvou názvů týmů 0–1. */
function teamSimilarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0.0;
  if (na === nb) return 1.0;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  // „Brighton“ ⊂ „Brighton and Hove Albion“; krátké zbytky typu „al“ ale neberem.
  const smallLen = [...small].reduce((n, t) => n + t.length, 0);
  if ([...small].every((t) => big.has(t)) && smallLen >= 4) return 0.92;
  if (differOnlyByDistinctWord(na.split(" "), nb.split(" "))) return 0.5; // Manchester City ≠ Manchester United
  return sequenceRatio(na, nb);
}

/**
 * Skóre 0–1, že jde o týž zápas (domácí vs. domácí, hosté vs. hosté). Vrací 0, pokud některý z týmů
 * nesedí aspoň z 60 %; jinak průměr obou podobností. Zrcadlový zápas je jiný zápas.
 */
function sameMatch(homeA, awayA, homeB, awayB) {
  const h = teamSimilarity(homeA, homeB);
  const a = teamSimilarity(awayA, awayB);
  if (h < 0.6 || a < 0.6) return 0.0;
  return (h + a) / 2;
}

module.exports = { normalize, teamSimilarity, sameMatch };
