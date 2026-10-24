// Poslední místo okna: monitor, na kterém aplikace byla, a jeho velikost po zmenšení. Při dalším spuštění se okno otevře tam.
"use strict";

const fs = require("node:fs");

const num = (v) => Number.isFinite(v);
const validRect = (r) => Boolean(r) && [r.x, r.y, r.width, r.height].every(num) && r.width > 0 && r.height > 0;

/** Načte uložený stav { x, y, width, height, display }; poškozený nebo chybějící soubor = null. */
function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return validRect(s) && validRect(s.display) ? s : null;
  } catch {
    return null;
  }
}

function saveState(file, state) {
  try {
    if (validRect(state) && validRect(state.display)) fs.writeFileSync(file, JSON.stringify(state), "utf8");
  } catch { /* poloha okna je jen pohodlí */ }
}

const contains = (area, x, y) => x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height;

/**
 * Kam okno umístit: na monitor (jeho pracovní plochu `workAreas`), na kterém bylo naposledy.
 * Monitor se hledá podle uložené pracovní plochy; když už není připojený, vrací null (okno se otevře na hlavním monitoru).
 * Velikost se zmenší, aby se na monitor vešla, a poloha leží vždy uvnitř něj.
 */
function pickBounds(state, workAreas) {
  if (!state || !validRect(state) || !validRect(state.display)) return null;
  const d = state.display;
  const area = workAreas.find((a) => a.x === d.x && a.y === d.y && a.width === d.width && a.height === d.height)
    || workAreas.find((a) => contains(a, d.x + d.width / 2, d.y + d.height / 2));
  if (!area) return null;
  const width = Math.min(state.width, area.width);
  const height = Math.min(state.height, area.height);
  const inside = contains(area, state.x + width / 2, state.y + height / 2);
  return {
    width, height,
    x: inside ? Math.min(Math.max(state.x, area.x), area.x + area.width - width) : Math.round(area.x + (area.width - width) / 2),
    y: inside ? Math.min(Math.max(state.y, area.y), area.y + area.height - height) : Math.round(area.y + (area.height - height) / 2),
  };
}

module.exports = { loadState, saveState, pickBounds };
