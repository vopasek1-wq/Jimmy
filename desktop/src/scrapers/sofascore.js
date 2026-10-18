// SofaScore – podrobnosti zápasu: přesný začátek, stav, skóre a odkaz.
//
// Používá se veřejný JSON, který si načítá samotný web SofaScore:
//   /api/v1/unique-tournament/<id>/scheduled-events/<YYYY-MM-DD>
// Jeden dotaz vrátí zápasy jedné soutěže za (zhruba) jeden den. Parametr data není čisté UTC datum
// (okno se překrývá s předchozím/následujícím dnem), proto se zápasy vždy přiřazují podle názvů týmů
// a startTimestamp, ne podle data. Oficiální API to není – kdyby SofaScore endpoint změnil, aplikace
// dál funguje a jen ukáže, že tento zdroj je nedostupný.
"use strict";

const config = require("../config");
const { SourceError } = require("../http");
const { UPCOMING, LIVE, FINISHED } = require("../models");
const { sameMatch } = require("../names");
const { utcDateOf } = require("../timeutil");

const API_HEADERS = { Accept: "application/json", Referer: `${config.SOFASCORE_WEB}/` };
const MATCH_TOLERANCE_MS = 3 * 3600 * 1000;

function eventUrl(ev) {
  return `${config.SOFASCORE_WEB}/cs/football/match/${ev.slug}/${ev.customId}#id:${ev.id}`;
}

function parseEvents(data) {
  const out = [];
  for (const e of (data && data.events) || []) {
    try {
      const stype = (e.status && e.status.type) || "";
      const hs = e.homeScore || {};
      const as = e.awayScore || {};
      const pick = (s) => (s.normaltime !== undefined ? s.normaltime : s.current); // sázky se vyhodnocují po 90 min
      const ev = {
        id: Number(e.id), slug: e.slug || "", customId: e.customId || "",
        start: new Date(Number(e.startTimestamp) * 1000),
        status: { notstarted: UPCOMING, inprogress: LIVE, finished: FINISHED }[stype] || null,
        cancelled: ["postponed", "canceled", "cancelled"].includes(stype),
        home: e.homeTeam.name, away: e.awayTeam.name,
        homeScore: pick(hs) ?? null, awayScore: pick(as) ?? null,
        minuteText: (e.status && e.status.description) || "",
      };
      if (!Number.isFinite(ev.id) || Number.isNaN(ev.start.getTime())) continue;
      ev.url = eventUrl(ev);
      out.push(ev);
    } catch {
      /* nečitelná událost přeskočíme */
    }
  }
  return out;
}

class SofaScoreClient {
  constructor(http) {
    this.http = http;
    this.cache = new Map();
    this.errors = [];
    this.requestsOk = 0;
  }

  async events(tournamentId, day) {
    const key = `${tournamentId}|${day}`;
    if (!this.cache.has(key)) {
      const url = `${config.SOFASCORE_API}/unique-tournament/${tournamentId}/scheduled-events/${day}`;
      try {
        this.cache.set(key, parseEvents(await this.http.getJson(url, { headers: API_HEADERS })));
        this.requestsOk += 1;
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        this.errors.push(err.message);
        this.cache.set(key, []);
      }
    }
    return this.cache.get(key);
  }

  /** Najde zápas podle týmů a času (±3 h od očekávaného začátku). */
  async find(tournamentId, home, away, kickoff) {
    let best = null;
    let bestScore = 0;
    for (const ev of await this.events(tournamentId, utcDateOf(kickoff))) {
      if (Math.abs(ev.start - kickoff) > MATCH_TOLERANCE_MS) continue;
      const score = sameMatch(home, away, ev.home, ev.away);
      if (score > bestScore) { best = ev; bestScore = score; }
    }
    return best;
  }

  /** Doplní tipům přesný čas, stav, skóre a odkaz; zrušené/odložené zápasy vyřadí. */
  async enrich(tips, progress = () => {}) {
    const groups = new Set();
    for (const t of tips) {
      const lg = config.leagueByKey(t.leagueKey);
      if (lg && lg.sofascoreId) groups.add(`${lg.sofascoreId}|${utcDateOf(t.kickoff)}`);
    }
    progress(`SofaScore: načítám detaily zápasů (${groups.size} dotazů)…`);

    const kept = [];
    for (const t of tips) {
      const lg = config.leagueByKey(t.leagueKey);
      const ev = lg && lg.sofascoreId ? await this.find(lg.sofascoreId, t.home, t.away, t.kickoff) : null;
      if (ev) {
        if (ev.cancelled) continue;
        t.kickoff = ev.start;
        t.sofascoreId = ev.id;
        t.sofascoreUrl = ev.url;
        if (ev.status) t.status = ev.status;
        if (ev.status === LIVE || ev.status === FINISHED) {
          t.homeScore = ev.homeScore;
          t.awayScore = ev.awayScore;
        }
      }
      kept.push(t);
    }
    return kept;
  }
}

module.exports = { SofaScoreClient, parseEvents, MATCH_TOLERANCE_MS };
