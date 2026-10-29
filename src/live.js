// Živé zápasy ze SofaScore: seznam právě hraných zápasů a podrobnosti jednoho zápasu
// (momentum, střely, branky a karty, statistiky). Veřejný JSON webu SofaScore, stejně jako v sofascore.js.
"use strict";

const config = require("./config");
const { SourceError } = require("./http");

const API_HEADERS = { Accept: "application/json", Referer: `${config.SOFASCORE_WEB}/` };
const TRACKED = new Set(config.LEAGUES.filter((l) => l.enabled && l.sofascoreId).map((l) => l.sofascoreId));

const LEAGUE_BY_ID = new Map(config.LEAGUES.filter((l) => l.sofascoreId).map((l) => [l.sofascoreId, l]));
let regionNames = null;
try { regionNames = new Intl.DisplayNames(["cs"], { type: "region" }); } catch { /* bez českých názvů zemí */ }
const UK = { EN: "Anglie", SC: "Skotsko", WA: "Wales", NI: "Severní Irsko" };

/** České jméno soutěže: u sledovaných z configu, jinak „Země – soutěž“ (název soutěže SofaScore česky nedává). */
function titleOf(e, tracked, ut) {
  const lg = tracked && LEAGUE_BY_ID.get(ut.id);
  if (lg) return lg.nameCs;
  const cat = (e.tournament && e.tournament.category) || {};
  const code = String(cat.alpha2 || (cat.country && cat.country.alpha2) || "").toUpperCase();
  let country = UK[code] || "";
  try { if (!country && code && regionNames) country = regionNames.of(code); } catch { /* neplatný kód */ }
  country = country && country !== code ? country : cat.name || "";
  const name = (e.tournament && e.tournament.name) || "";
  return country && country !== name ? `${country} – ${name}` : name;
}

const PERIODS = [
  [/^(?:1st half|first half)$/i, "1. poločas"], [/^(?:2nd half|second half)$/i, "2. poločas"], [/extra time/i, "Prodloužení"],
  [/penalt/i, "Penalty"], [/^started$/i, "Začal"], [/^break|pause/i, "Přestávka"], [/^interrupted$/i, "Přerušeno"],
];

/** Text minuty podle hodin periody: „34'“, „45+2'“, „Poločas“. */
function minuteText(e, nowSec) {
  const desc = (e.status && e.status.description) || "";
  if (/half\s*time|^ht$/i.test(desc)) return "Poločas";
  const t = e.time || {};
  if (!t.currentPeriodStartTimestamp) return (PERIODS.find(([re]) => re.test(desc)) || [null, desc])[1];
  const initial = t.initial || 0;
  const max = t.max || 0;
  const elapsed = initial + Math.max(0, nowSec - t.currentPeriodStartTimestamp);
  const minute = Math.floor(elapsed / 60) + 1;
  if (max && elapsed >= max) return `${max / 60}+${minute - max / 60}'`;
  return `${minute}'`;
}

function parseLive(data, nowSec = Math.floor(Date.now() / 1000)) {
  const out = [];
  for (const e of (data && data.events) || []) {
    try {
      if (!e.status || e.status.type !== "inprogress") continue;
      const ut = (e.tournament && e.tournament.uniqueTournament) || {};
      out.push({
        id: Number(e.id), home: e.homeTeam.name, away: e.awayTeam.name,
        homeScore: (e.homeScore && e.homeScore.current) ?? 0, awayScore: (e.awayScore && e.awayScore.current) ?? 0,
        minute: minuteText(e, nowSec), title: titleOf(e, TRACKED.has(ut.id), ut),
        tournamentId: ut.id ?? null, tracked: TRACKED.has(ut.id), leagueKey: (LEAGUE_BY_ID.get(ut.id) || {}).key || null,
        url: `${config.SOFASCORE_WEB}/cs/football/match/${e.slug}/${e.customId}#id:${e.id}`,
      });
    } catch {
      /* nečitelná událost přeskočíme */
    }
  }
  // sledované soutěže první, pak podle soutěže
  return out.sort((a, b) => Number(b.tracked) - Number(a.tracked) || a.title.localeCompare(b.title, "cs"));
}

function parseGraph(data) {
  return ((data && data.graphPoints) || []).map((p) => ({ m: p.minute, v: p.value })).filter((p) => Number.isFinite(p.m) && Number.isFinite(p.v));
}

/** Střely: x = vzdálenost od branky, na kterou se střílí (0–100), y = šířka hřiště (0–100). */
function parseShots(data) {
  return ((data && data.shotmap) || []).filter((s) => s.playerCoordinates).map((s) => ({
    home: Boolean(s.isHome), x: s.playerCoordinates.x, y: s.playerCoordinates.y, type: s.shotType || "miss",
    xg: s.xg ?? null, minute: s.time ?? null, player: (s.player && (s.player.shortName || s.player.name)) || "",
  }));
}

function parseIncidents(data) {
  const out = [];
  for (const i of (data && data.incidents) || []) {
    const base = { minute: i.time, home: Boolean(i.isHome) };
    if (i.incidentType === "goal") {
      out.push({ ...base, kind: "goal", own: i.incidentClass === "ownGoal", penalty: i.incidentClass === "penalty",
        player: (i.player && (i.player.shortName || i.player.name)) || i.playerName || "", homeScore: i.homeScore ?? null, awayScore: i.awayScore ?? null });
    } else if (i.incidentType === "card") {
      out.push({ ...base, kind: i.incidentClass === "yellow" ? "yellow" : "red", player: (i.player && (i.player.shortName || i.player.name)) || i.playerName || "" });
    }
  }
  return out.sort((a, b) => a.minute - b.minute);
}

const STAT_KEYS = [
  ["ballPossession", "Držení míče", true], ["expectedGoals", "Očekávané góly (xG)"], ["totalShotsOnGoal", "Střely celkem"],
  ["shotsOnGoal", "Střely na bránu"], ["cornerKicks", "Rohy"], ["fouls", "Fauly"], ["yellowCards", "Žluté karty"], ["redCards", "Červené karty"],
];

function parseStats(data) {
  const all = ((data && data.statistics) || []).find((s) => s.period === "ALL") || ((data && data.statistics) || [])[0];
  if (!all) return [];
  const items = new Map();
  for (const g of all.groups || []) for (const it of g.statisticsItems || []) items.set(it.key, it);
  return STAT_KEYS.filter(([key]) => items.has(key)).map(([key, label]) => {
    const it = items.get(key);
    return { label, home: it.home, away: it.away, homeValue: it.homeValue ?? null, awayValue: it.awayValue ?? null };
  });
}

class LiveClient {
  constructor(http) {
    this.http = http;
  }

  async list(now = new Date()) {
    const data = await this.http.getJson(`${config.SOFASCORE_API}/sport/football/events/live`, { headers: API_HEADERS });
    return parseLive(data, Math.floor(now.getTime() / 1000));
  }

  /** Podrobnosti zápasu; chybějící část (např. střely u nižší soutěže) nic neshodí. */
  async detail(id) {
    const base = `${config.SOFASCORE_API}/event/${Number(id)}`;
    const get = async (name) => {
      try {
        return await this.http.getJson(`${base}/${name}`, { headers: API_HEADERS });
      } catch (err) {
        if (err instanceof SourceError) return null;
        throw err;
      }
    };
    const [graph, shots, incidents, stats] = await Promise.all(["graph", "shotmap", "incidents", "statistics"].map(get));
    if (!graph && !shots && !incidents && !stats) throw new SourceError("SofaScore: podrobnosti zápasu se nepodařilo načíst.");
    return { graph: parseGraph(graph), shots: parseShots(shots), incidents: parseIncidents(incidents), stats: parseStats(stats) };
  }
}

module.exports = { LiveClient, parseLive, parseGraph, parseShots, parseIncidents, parseStats, minuteText };
