// Úklid složky s ladicími soubory (`ladeni`): staré soubory se mažou a celá složka dostane strop, aby nerostla.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DAY_MS = 24 * 3600 * 1000;
const MAX_AGE_MS = 7 * DAY_MS;
const MAX_BYTES = 2 * 1024 * 1024;
const LEGACY = ["forebet-goals.json"]; // soubory starších verzí, které už nikdo nečte

/**
 * Smaže soubory starší než `maxAgeMs`; když zbylé zabírají víc než `maxBytes`, maže další od nejstarších.
 * Vrací { removed: [názvy], bytes: zbývající velikost }. Chyby (zamčený soubor…) se ignorují.
 */
function cleanDir(dir, { maxAgeMs = MAX_AGE_MS, maxBytes = MAX_BYTES, now = Date.now() } = {}) {
  const out = { removed: [], bytes: 0 };
  let files = [];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
      const file = path.join(dir, e.name);
      const st = fs.statSync(file);
      return { name: e.name, file, size: st.size, mtime: st.mtimeMs };
    });
  } catch {
    return out;
  }
  const drop = (f) => {
    try { fs.rmSync(f.file, { force: true }); out.removed.push(f.name); return true; } catch { return false; }
  };
  files = files.filter((f) => !(now - f.mtime > maxAgeMs && drop(f)));
  files.sort((a, b) => a.mtime - b.mtime);                       // nejstarší první
  let total = files.reduce((n, f) => n + f.size, 0);
  while (total > maxBytes && files.length > 1) {
    const f = files.shift();
    if (drop(f)) total -= f.size;
  }
  out.bytes = total;
  return out;
}

/** Úklid po spuštění a po stahování: ladicí složka + zbytky starých verzí v datové složce. */
function tidy(dataDir, opts) {
  for (const name of LEGACY) {
    try { fs.rmSync(path.join(dataDir, name), { force: true }); } catch { /* nevadí */ }
  }
  return cleanDir(path.join(dataDir, "ladeni"), opts);
}

module.exports = { cleanDir, tidy, MAX_AGE_MS, MAX_BYTES };
