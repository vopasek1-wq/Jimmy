// Typy tipů: převod textů ze Scores24 na kanonické kódy, české popisky a vyhodnocení výsledku.
//
// Kanonické kódy:
//   1  X  2            výsledek zápasu (domácí / remíza / hosté)
//   1X  X2  12         dvojitá šance
//   O2.5  U3           celkový počet gólů – více / méně než linie
//   BTTS  NOBTTS       oba týmy skórují – ano / ne
//   HO1.5  AU0.5       góly jednoho týmu (H = domácí, A = hosté; O = over, U = under)
//   AH1:+1.5  AH2:0    handicap týmu 1/2 (linie 0 = sázka bez remízy)
//   OTHER:<text>       trh, který neumíme interpretovat (zobrazí se původní text)
"use strict";

const WIN = "win";
const LOSS = "loss";
const VOID = "void";

const lineOf = (text) => {
  const n = Number(String(text).replace(",", ".").replace("+", ""));
  return Number.isFinite(n) && String(text).trim() !== "" ? n : null;
};
const numCs = (x) => String(x).replace(".", ","); // 2.5 → „2,5“, 3 → „3“
const signed = (x) => (x === 0 ? "0" : x > 0 ? `+${x}` : String(x));

const BTTS_RE = /^both teams to score\s*[–-]?\s*\(?\s*(yes|no)\s*\)?$/i;
const TOTAL_RE = /^total goals\s+(over|under)\s*\(\s*([\d.,]+)\s*\)$/i;
const HANDICAP_RE = /^handicap\s*\(\s*([+-]?[\d.,]+)\s*\)$/i;

/** „2,5 gólu“, „1 gól“, „3 góly“, „5 gólů“ – správný český tvar podle linie. */
function goalsCs(line) {
  if (!Number.isInteger(line)) return `${numCs(line)} gólu`;
  return `${line} ${line === 1 ? "gól" : line >= 2 && line <= 4 ? "góly" : "gólů"}`;
}

function totalMarket(direction, lineText, side, home, away) {
  const line = lineOf(lineText);
  if (line === null) return null;
  const over = direction.toLowerCase() === "over";
  const word = over ? "více než" : "méně než";
  if (side === null) {
    return { code: `${over ? "O" : "U"}${line}`, labelCs: `${over ? "Více" : "Méně"} než ${goalsCs(line)}` };
  }
  const prefix = (side === "1" ? "H" : "A") + (over ? "O" : "U");
  const team = side === "1" ? home : away;
  return { code: `${prefix}${line}`, labelCs: `${team}: ${word} ${goalsCs(line)}` };
}

/** Nezná-li se trh, přeloží se aspoň běžná slova; názvy týmů zůstanou beze změny. */
const WORDS = [
  [/\bwill not score\b/gi, "nedá gól"], [/\bwill score\b/gi, "dá gól"], [/\bwill not lose\b/gi, "neprohraje"],
  [/\bnot to lose\b/gi, "neprohraje"], [/\bto win to nil\b/gi, "vyhraje s čistým kontem"], [/\bto win\b/gi, "vyhraje"],
  [/\bboth teams to score\b/gi, "Oba týmy dají gól"], [/\btotal goals\b/gi, "góly celkem"], [/\btotal corners\b/gi, "rohy celkem"],
  [/\btotal yellow cards\b/gi, "žluté karty celkem"], [/\btotal cards\b/gi, "karty celkem"],
  [/\bover\b/gi, "více než"], [/\bunder\b/gi, "méně než"], [/\bhandicap\b/gi, "handicap"],
  [/\bcorners\b/gi, "rohů"], [/\bcards\b/gi, "karet"], [/\bdraw no bet\b/gi, "sázka bez remízy"], [/\bdraw\b/gi, "remíza"],
  [/\bhalf\b/gi, "poločas"], [/\b1st\b/gi, "1."], [/\b2nd\b/gi, "2."],
];
const STAT_CS = { corners: ["roh", "rohy", "rohů"], "yellow cards": ["žlutou kartu", "žluté karty", "žlutých karet"], cards: ["kartu", "karty", "karet"] };
const COUNT_RE = /^(.*?)\s*total (corners|yellow cards|cards)\s+(over|under)\s*\(\s*([\d.,]+)\s*\)$/i;

/** Rohy a karty: „Total corners Over (9,5)“ → „Více než 9,5 rohů“. */
function countMarket(text, home, away) {
  const m = COUNT_RE.exec(text);
  if (!m) return null;
  const line = lineOf(m[4]);
  if (line === null) return null;
  const forms = STAT_CS[m[2].toLowerCase()];
  const unit = Number.isInteger(line) ? (line === 1 ? forms[0] : line >= 2 && line <= 4 ? forms[1] : forms[2]) : forms[2];
  const who = m[1] ? `${m[1]}: ` : "";
  const word = m[3].toLowerCase() === "over" ? (who ? "více než" : "Více než") : (who ? "méně než" : "Méně než");
  return `${who}${word} ${numCs(line)} ${unit}`;
}

function translateOther(text) {
  return WORDS.reduce((t, [re, cs]) => t.replace(re, cs), text).replace(/\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase());
}

function splitTeam(text, home, away) {
  // Odtrhne od textu název domácích/hostů; vrátí ['1'|'2'|null, zbytek]. Delší název má přednost.
  const candidates = [[home, "1"], [away, "2"]].sort((p, q) => q[0].length - p[0].length);
  for (const [name, side] of candidates) {
    if (name && text.toLowerCase().startsWith(name.toLowerCase())) return [side, text.slice(name.length).trim()];
  }
  return [null, text];
}

function sideOf(name, home, away) {
  const n = name.trim().toLowerCase();
  if (n === home.trim().toLowerCase()) return "1";
  if (n === away.trim().toLowerCase()) return "2";
  return null;
}

function doubleChance(side, home, away) {
  return side === "1" ? { code: "1X", labelCs: `1X – ${home} neprohraje` } : { code: "X2", labelCs: `X2 – ${away} neprohraje` };
}

/**
 * Přeloží anglický popis tipu ze Scores24 na {code, labelCs}.
 * Příklady vstupů: „Arsenal to Win“, „Both Teams to Score – (Yes)“, „Total goals Over (2,5)“,
 * „Brighton Total goals Under (1,5)“, „Como 1907 Handicap (+1,5)“. Neznámý trh nezahazujeme –
 * vrátí se jako OTHER s původním textem.
 */
function normalizePick(label, home, away) {
  const text = String(label).replace(/\s+/g, " ").trim();
  const other = { code: `OTHER:${text}`, labelCs: countMarket(text, home, away) || translateOther(text) };
  if (!text) return other;
  let m;

  if ((m = BTTS_RE.exec(text))) {
    return m[1].toLowerCase() === "yes"
      ? { code: "BTTS", labelCs: "Oba týmy dají gól – ano" }
      : { code: "NOBTTS", labelCs: "Oba týmy dají gól – ne" };
  }
  if ((m = TOTAL_RE.exec(text))) return totalMarket(m[1], m[2], null, home, away) || other;
  if (/^draw$/i.test(text)) return { code: "X", labelCs: "X – remíza" };

  // „Cagliari will not lose“
  if ((m = /^(.+?)\s+(?:will not lose|not to lose)$/i.exec(text))) {
    const side = sideOf(m[1], home, away);
    if (side) return doubleChance(side, home, away);
  }
  // „Draw or Arsenal“
  if ((m = /^draw or (.+)$/i.exec(text))) {
    const side = sideOf(m[1], home, away);
    if (side) return doubleChance(side, home, away);
  }
  // „Arsenal or Draw“ / „Arsenal to Win or Draw“ / „Arsenal or Tottenham“
  if ((m = /^(.+?)\s+(?:to win\s+)?or\s+(.+)$/i.exec(text))) {
    const left = sideOf(m[1], home, away);
    const right = m[2].trim();
    if (left && right.toLowerCase() === "draw") return doubleChance(left, home, away);
    const rightSide = sideOf(right, home, away);
    if (left && rightSide && left !== rightSide) return { code: "12", labelCs: "12 – nebude remíza" };
  }

  // „Slovan Bratislava will not score“ / „… will score“ = týmový total pod / nad 0,5 gólu
  if ((m = /^(.+?)\s+will (not )?score$/i.exec(text))) {
    const side = sideOf(m[1], home, away);
    if (side) {
      const team = side === "1" ? home : away;
      return { code: `${side === "1" ? "H" : "A"}${m[2] ? "U" : "O"}0.5`, labelCs: `${team} ${m[2] ? "nedá gól" : "dá gól"}` };
    }
  }

  // Všechno ostatní začíná názvem týmu: „<tým> to Win“, „<tým> Total goals…“, „<tým> Handicap…“
  const [side, rest] = splitTeam(text, home, away);
  if (side && rest) {
    const team = side === "1" ? home : away;
    if (/^to win$/i.test(rest)) return { code: side, labelCs: `${side} – výhra ${team}` };
    if ((m = TOTAL_RE.exec(rest))) return totalMarket(m[1], m[2], side, home, away) || other;
    if ((m = HANDICAP_RE.exec(rest))) {
      const h = lineOf(m[1]);
      if (h !== null) {
        if (h === 0) return { code: `AH${side}:0`, labelCs: `${team}: bez remízy` };
        return { code: `AH${side}:${signed(h)}`, labelCs: `${team}: handicap ${signed(h).replace(".", ",")}` };
      }
    }
  }
  return other;
}

/** Popisek pro trhy 1 / X / 2 (používá ho Forebet, který dává jen výsledek zápasu). */
function resultMarket(code, home, away) {
  if (code === "1") return { code: "1", labelCs: `1 – výhra ${home}` };
  if (code === "2") return { code: "2", labelCs: `2 – výhra ${away}` };
  return { code: "X", labelCs: "X – remíza" };
}

/**
 * Pravděpodobnost trhu z rozdělení 1/X/2; pro ostatní trhy null (Forebet je zde nedává).
 * Handicap 0 (sázka bez remízy) je odhad: pravděpodobnost výhry týmu při vyřazení remízy, tedy p / (p1 + p2).
 */
function forebetProbability(code, p1, px, p2) {
  const table = { 1: p1, X: px, 2: p2, "1X": p1 + px, X2: px + p2, 12: p1 + p2 };
  if (Object.prototype.hasOwnProperty.call(table, code)) return table[code];
  const noDraw = /^AH([12]):0$/.exec(code);
  if (noDraw && p1 + p2 > 0) return Math.round(((noDraw[1] === "1" ? p1 : p2) / (p1 + p2)) * 1000) / 10;
  return null;
}

/**
 * Pravděpodobnost trhu „góly“ ze stránky zápasu na Forebetu (BTTS a Over/Under celého zápasu);
 * jinak null. `goals` = { over: {"2.5": 55}, under: {"2.5": 45}, btts: { yes: 52, no: 48 } }.
 */
function goalsProbability(code, goals) {
  if (!goals) return null;
  const pick = (a, b) => (a ?? null) !== null ? a : ((b ?? null) !== null ? 100 - b : null);
  if (code === "BTTS") return pick(goals.btts?.yes, goals.btts?.no);
  if (code === "NOBTTS") return pick(goals.btts?.no, goals.btts?.yes);
  const m = /^([OU])(\d+(?:\.\d+)?)$/.exec(code);
  if (!m) return null;
  const line = String(Number(m[2]));
  const over = goals.over?.[line];
  const under = goals.under?.[line];
  return m[1] === "O" ? pick(over, under) : pick(under, over);
}

const TOTAL_CODE = /^([HA]?)([OU])(\d+(?:\.\d+)?)$/;
const AH_CODE = /^AH([12]):([+-]?\d+(?:\.\d+)?)$/;

function vsLine(diff, over, line) {
  if ((line * 2) % 1 !== 0) return null; // čtvrtinová linie
  if (diff === 0) return VOID; // celočíselná linie, přesně na ní → vrácená sázka
  return (diff > 0) === over ? WIN : LOSS;
}

/**
 * Vrátí WIN / LOSS / VOID, nebo null, když trh neumíme automaticky vyhodnotit.
 * Čtvrtinové linie se vyhodnocují půl na půl, takže je raději nechávám ručně (null).
 */
function evaluate(code, homeGoals, awayGoals) {
  const hg = homeGoals;
  const ag = awayGoals;
  const simple = {
    1: hg > ag, X: hg === ag, 2: hg < ag, "1X": hg >= ag, X2: hg <= ag, 12: hg !== ag,
    BTTS: hg > 0 && ag > 0, NOBTTS: !(hg > 0 && ag > 0),
  };
  if (Object.prototype.hasOwnProperty.call(simple, code)) return simple[code] ? WIN : LOSS;

  let m = TOTAL_CODE.exec(code);
  if (m) {
    const [, who, direction, lineText] = m;
    const line = Number(lineText);
    const goals = who === "" ? hg + ag : who === "H" ? hg : ag;
    return vsLine(goals - line, direction === "O", line);
  }
  m = AH_CODE.exec(code);
  if (m) {
    const h = Number(m[2]);
    const [mine, theirs] = m[1] === "1" ? [hg, ag] : [ag, hg];
    if ((h * 2) % 1 !== 0) return null; // čtvrtinový handicap
    const diff = mine + h - theirs;
    return diff > 0 ? WIN : diff === 0 ? VOID : LOSS;
  }
  return null;
}

module.exports = { WIN, LOSS, VOID, normalizePick, resultMarket, forebetProbability, goalsProbability, evaluate };
