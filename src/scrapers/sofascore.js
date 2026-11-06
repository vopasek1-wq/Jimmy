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
const { sameMatch, teamSimilarity } = require("../names");
const { utcDateOf } = require("../timeutil");

const API_HEADERS = { Accept: "application/json", Referer: `${config.SOFASCORE_WEB}/` };
const MATCH_TOLERANCE_MS = 3 * 3600 * 1000;
const WIDE_TOLERANCE_MS = 90 * 60 * 1000;   // záloha přes všechny zápasy dne: přísnější čas i shoda jmen
const WIDE_MIN_SCORE = 0.8;
const FAST_DELAY_MS = [300, 700]; // drobné dotazy na týž server; stahují se po třech najednou
const CONCURRENCY = 3;

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
        this.cache.set(key, parseEvents(await this.http.getJson(url, { headers: API_HEADERS, delayMs: FAST_DELAY_MS })));
        this.requestsOk += 1;
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        if (err.status !== 404) this.errors.push(err.message); // 404 = soutěž ten den nehraje, není to chyba
        this.cache.set(key, []);
      }
    }
    return this.cache.get(key);
  }

  /** Zápas podle jeho SofaScore ID (tipy ho mají uložené po prvním spárování); null, když se ho nepodaří načíst. */
  async byId(id) {
    const key = `id|${id}`;
    if (!this.cache.has(key)) {
      try {
        const data = await this.http.getJson(`${config.SOFASCORE_API}/event/${id}`, { headers: API_HEADERS, delayMs: FAST_DELAY_MS });
        this.cache.set(key, parseEvents({ events: data && data.event ? [data.event] : [] })[0] || null);
        this.requestsOk += 1;
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        if (err.status !== 404) this.errors.push(err.message);
        this.cache.set(key, null);
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

  /**
   * Záloha: zápas se hledá mezi všemi fotbalovými zápasy dne, když se v „své“ soutěži nenašel (jiné ID soutěže, kvalifikace, …).
   * Bere se jen při velmi dobré shodě obou jmen a času (±90 min). Chyba tohoto dotazu se nehlásí, záloha je nepovinná.
   */
  async findAnywhere(home, away, kickoff) {
    const day = utcDateOf(kickoff);
    const key = `all|${day}`;
    if (!this.cache.has(key)) {
      try {
        this.cache.set(key, parseEvents(await this.http.getJson(`${config.SOFASCORE_API}/sport/football/scheduled-events/${day}`, { headers: API_HEADERS, delayMs: FAST_DELAY_MS })));
        this.requestsOk += 1;
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        this.wideError = err.message;      // jen pro ladění (describeMiss), jako chyba zdroje se nehlásí
        this.cache.set(key, []);
      }
    }
    let best = null;
    let bestScore = 0;
    for (const ev of this.cache.get(key)) {
      if (Math.abs(ev.start - kickoff) > WIDE_TOLERANCE_MS) continue;
      const score = sameMatch(home, away, ev.home, ev.away);
      if (score >= WIDE_MIN_SCORE && score > bestScore) { best = ev; bestScore = score; }
    }
    return best;
  }

  /**
   * Pro ladění: proč se zápas nenašel. Kolik zápasů měl seznam soutěže a seznam všech zápasů dne a který z nich (±12 h) se jménům
   * nejvíc podobal i při nedostatečné shodě. Čte jen z už stažených seznamů.
   */
  describeMiss(tournamentId, home, away, kickoff) {
    const day = utcDateOf(kickoff);
    const stamp = (d) => d.toISOString().slice(0, 16).replace("T", " ");
    const nearest = (list) => {
      let best = null;
      let bestScore = -1;
      for (const ev of list) {
        if (Math.abs(ev.start - kickoff) > 12 * 3600 * 1000) continue;
        const score = (teamSimilarity(home, ev.home) + teamSimilarity(away, ev.away)) / 2;
        if (score > bestScore) { best = ev; bestScore = score; }
      }
      return best ? `${best.home} – ${best.away} (podobnost ${bestScore.toFixed(2)}, ${stamp(best.start)} UTC)` : "nic v ±12 h";
    };
    const part = (label, list) => `${label}: ${list ? `${list.length} zápasů, nejbližší ${nearest(list)}` : "nestaženo"}`;
    return `${part("soutěž", this.cache.get(`${tournamentId}|${day}`))}; ${part("všechny zápasy dne", this.cache.get(`all|${day}`))}${this.wideError ? ` [chyba seznamu dne: ${this.wideError}]` : ""}`;
  }

  /** Doplní tipům přesný čas, stav, skóre a odkaz; zrušené/odložené zápasy vyřadí. */
  async enrich(tips, progress = () => {}) {
    const groups = new Set();
    for (const t of tips) {
      const lg = config.leagueByKey(t.leagueKey);
      if (lg && lg.sofascoreId) groups.add(`${lg.sofascoreId}|${utcDateOf(t.kickoff)}`);
    }
    progress(`SofaScore: načítám detaily zápasů (${groups.size} dotazů)…`);
    const queue = [...groups];
    const worker = async () => {
      while (queue.length) {
        const [id, day] = queue.shift().split("|");
        await this.events(Number(id), day);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker)); // další `find` už čte z mezipaměti

    const kept = [];
    for (const t of tips) {
      const lg = config.leagueByKey(t.leagueKey);
      let ev = lg && lg.sofascoreId ? await this.find(lg.sofascoreId, t.home, t.away, t.kickoff) : null;
      if (!ev) ev = await this.findAnywhere(t.home, t.away, t.kickoff);
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

module.exports = { SofaScoreClient, parseEvents };
