// Čas: uvnitř vše jako Date (UTC), zobrazení v pražském čase.
"use strict";

const { DISPLAY_TZ } = require("./config");

const CZ_DAYS = ["ne", "po", "út", "st", "čt", "pá", "so"]; // podle Date.getDay()

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TZ, year: "numeric", month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
});

/** Rozložení okamžiku na pražské datum a čas. */
function localParts(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, weekday };
}

const pad = (n) => String(n).padStart(2, "0");

/** Pražský místní čas (rok, měsíc, den, hodina, minuta) → okamžik (Date, UTC); správně i kolem přechodu na letní/zimní čas. */
function localToUtc(year, month, day, hour, minute) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let t = wanted;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(t));
    t -= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - wanted;
  }
  return new Date(t);
}

/** Datum zápasu v pražském čase jako „YYYY-MM-DD“ – podle něj se řadí tipy do „dnes“ a „zítra“. */
function localDate(date) {
  const p = localParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function todayLocal(now = new Date()) {
  return localDate(now);
}

/** Přičte k datu „YYYY-MM-DD“ počet dní (kalendářně, bez posunu kvůli letnímu času). */
function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Např. „ne 18.10. 17:30“. */
function fmtKickoff(date) {
  const p = localParts(date);
  return `${CZ_DAYS[p.weekday]} ${p.day}.${p.month}. ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Časová značka poslední aktualizace, např. „18.10.2026 14:03“. */
function fmtStamp(date) {
  const p = localParts(date);
  return `${p.day}.${p.month}.${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}

function fmtHourMinute(date) {
  const p = localParts(date);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** UTC datum + čas z řádku (HH:MM) → Date. */
function utcDateTime(isoDate, hh, mm) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm));
}

const utcDateOf = (date) => date.toISOString().slice(0, 10);

module.exports = { localParts, localDate, todayLocal, addDays, fmtKickoff, fmtStamp, fmtHourMinute, utcDateTime, utcDateOf, localToUtc };
