// Export historie tipů do CSV, které se dá otevřít v Excelu (středníky, UTF-8 s BOM, desetinná čárka).
"use strict";

const { fmtKickoff } = require("./timeutil");

const OUTCOME = { win: "výhra", loss: "prohra", void: "vráceno" };
const num = (x) => (x === null || x === undefined ? "" : String(x).replace(".", ","));
const cell = (v) => { const s = String(v ?? ""); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

const HEAD = ["Začátek", "Soutěž", "Zápas", "Tip", "Pravděpodobnost %", "Kurz", "Kurz je odhad", "Skóre", "Výsledek"];

/** @param {object[]} tips  tipy z historie (serializeTip) */
function historyCsv(tips) {
  const rows = tips.map((t) => [
    fmtKickoff(new Date(t.kickoff)), t.league, t.matchName, t.tipLabel, num(t.probability), num(t.odds), t.oddsEstimated ? "ano" : "ne",
    t.homeScore !== null && t.homeScore !== undefined && t.awayScore !== null && t.awayScore !== undefined ? `${t.homeScore}:${t.awayScore}` : "", OUTCOME[t.outcome] || "",
  ]);
  return `\uFEFF${[HEAD, ...rows].map((r) => r.map(cell).join(";")).join("\r\n")}\r\n`;
}

module.exports = { historyCsv };
