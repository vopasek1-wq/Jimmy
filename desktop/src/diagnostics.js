// Textová diagnostika pro vývojáře (v aplikaci Ctrl + Shift + D ji zkopíruje do schránky): verze, stav zdrojů posledního
// stahování, pokrytí Forebetu a SofaScore a obsah ladicích souborů ze složky `ladeni`. Neobsahuje nic osobního ani API klíč.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Obsah souboru, nejvýš `limit` znaků (delší se zkrátí); null, když soubor není. */
function readLimited(file, limit) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.length > limit ? `${text.slice(0, limit)}\n… (zkráceno, celkem ${text.length} znaků)` : text;
  } catch {
    return null;
  }
}

// [soubor, limit znaků]
const FILES = [
  ["zdroje-diagnostika.txt", 8000],
  ["forebet-diagnostika.txt", 3000],
  ["forebet-seznam-diagnostika.txt", 8000],
  ["tikety-statistiky.txt", 6000],
];

/** @param {object} o { version, electron, platform, run, tips, dir, now } */
function buildDiagnostics({ version, electron, platform, run, tips = [], dir, now = new Date() }) {
  const out = [`FOTBALOVÉ TIPY – DIAGNOSTIKA (${now.toISOString()})`, `Verze ${version}, Electron ${electron}, ${platform}`, ""];
  if (run) {
    out.push(`Poslední stažení: ${run.finishedAt instanceof Date ? run.finishedAt.toISOString() : run.finishedAt}`);
    for (const s of Object.values(run.statuses || {})) out.push(`  ${s.name}: ${s.state}${s.message ? ` – ${s.message}` : ""}`);
    for (const w of run.warnings || []) out.push(`  upozornění: ${w}`);
    const by = new Map();
    for (const t of tips) by.set(t.probSource || "Scores24", (by.get(t.probSource || "Scores24") || 0) + 1);
    out.push(`  tipů v posledním stažení: ${tips.length} (zdroj pravděpodobnosti: ${[...by].map(([k, n]) => `${k} ${n}`).join(", ") || "–"}), s Forebetem ${tips.filter((t) => t.probForebet !== null && t.probForebet !== undefined).length}, se SofaScore ${tips.filter((t) => t.sofascoreId).length}`);
  } else {
    out.push("Zatím žádné stažení tipů.");
  }
  for (const [name, limit] of FILES) {
    const text = readLimited(path.join(dir, name), limit);
    out.push("", `===== ${name} =====`);
    out.push(text === null ? "(soubor není)" : text.trimEnd());
  }
  return `${out.join("\n")}\n`;
}

module.exports = { buildDiagnostics };
