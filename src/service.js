// Služba aplikace: spojuje databázi, stahování a vyhodnocení výsledků a připravuje data pro okno.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("./config");
const { Database } = require("./database");
const { probabilityClass } = require("./filters");
const { Pipeline, updateResults, settleFinished } = require("./pipeline");
const { SofaScoreClient } = require("./scrapers/sofascore");
const { LiveClient } = require("./live");
const { MatchStats, chartsWithForebet } = require("./matchstats");
const { analyze, buildTicketsPrompt } = require("./analysis");
const { candidatesFrom, settleTicket, ticketStats, ticketGroups, dueKickoffs } = require("./tickets");
const { GoalsCache } = require("./goalscache");
const { tidy } = require("./housekeeping");
const { buildDiagnostics } = require("./diagnostics");
const { resultOk } = require("./models");
const { fmtStamp, localDate, todayLocal } = require("./timeutil");

/** Tip → prostý objekt pro okno (data jako řetězce, plus pomocná pole). */
function serializeTip(t) {
  const lg = config.leagueByKey(t.leagueKey);
  return {
    id: t.id, home: t.home, away: t.away, matchName: `${t.home} – ${t.away}`, leagueKey: t.leagueKey, league: t.league,
    leagueShort: (lg && lg.short) || t.league,
    kickoff: t.kickoff.toISOString(), day: localDate(t.kickoff), tipCode: t.tipCode, tipLabel: t.tipLabel,
    sofascoreId: t.sofascoreId ?? null, probability: t.probability, probSource: t.probSource || "Scores24", probClass: probabilityClass(t.probability), odds: t.odds ?? null,
    oddsEstimated: Boolean(t.oddsEstimated), sources: t.sources,
    status: t.status, homeScore: t.homeScore ?? null, awayScore: t.awayScore ?? null,
    url: t.url || "", forebetUrl: t.forebetUrl || "", sofascoreUrl: t.sofascoreUrl || "", outcome: t.outcome ?? null, outcomeSource: t.outcomeSource ?? null,
  };
}

class TipService {
  constructor({ dbFile, http, browser }) {
    this.db = new Database(dbFile);
    this.dataDir = path.dirname(dbFile);
    this.goalsCache = new GoalsCache(path.join(this.dataDir, "forebet-goals-v2.json"));
    this.statsCache = new Map(); // statistiky zápasů pro tikety (jen za běhu aplikace)
    tidy(this.dataDir);          // staré ladicí soubory pryč, složka `ladeni` má strop
    this.http = http;
    this.browser = browser;
    this.busy = false;
  }

  _payload({ tips, statuses, warnings, updatedAt, fromCache, offline = false, success = true }) {
    return {
      tips: tips.map(serializeTip), statuses, warnings, fromCache, offline, success,
      updatedAt: updatedAt ? updatedAt.toISOString() : null,
      updatedLabel: updatedAt ? fmtStamp(updatedAt) : null,
      today: todayLocal(),
    };
  }

  /** Hned po startu: poslední uložená data, než doběhne nové stahování. */
  loadCached() {
    settleFinished(this.db);
    const run = this.db.latestRun();
    if (!run) return this._payload({ tips: [], statuses: {}, warnings: [], updatedAt: null, fromCache: true });
    return this._payload({ tips: this.db.tipsOfLatestRun(), statuses: run.statuses, warnings: run.warnings.filter((w) => !/HTTP 404/.test(w)), updatedAt: run.finishedAt, fromCache: true });
  }

  async refresh(progress = () => {}, { interactiveForebet = false } = {}) {
    if (this.busy) throw new Error("Stahování už běží.");
    this.busy = true;
    try {
      const result = await new Pipeline({
        http: this.http, browser: this.browser, debugDir: path.join(this.dataDir, "ladeni"), goalsCache: this.goalsCache,
      }).run({ progress, interactiveForebet });
      if (resultOk(result)) {
        this.db.saveRun(result);
        await updateResults(this.db, this.http, { progress }).catch(() => {}); // doplní skóre a výsledky skončených zápasů
        return this._payload({ // z databáze, aby tipy už skončených zápasů měly výsledek
          tips: this.db.tipsOfLatestRun(), statuses: result.statuses, warnings: result.warnings, updatedAt: result.finishedAt, fromCache: false,
        });
      }
      // Stahování selhalo: ponecháme poslední uložená data a řekneme proč.
      const run = this.db.latestRun();
      const tips = run ? this.db.tipsOfLatestRun() : [];
      const when = run ? ` z ${fmtStamp(run.finishedAt)}` : "";
      const head = result.offline ? "Bez připojení k internetu" : "Tipy se nepodařilo stáhnout";
      return this._payload({
        tips, statuses: result.statuses, offline: result.offline, success: false, fromCache: true,
        updatedAt: run ? run.finishedAt : null,
        warnings: [tips.length ? `${head} – zobrazuji poslední uložená data${when}.` : `${head} a v databázi zatím nejsou žádná uložená data.`, ...result.warnings],
      });
    } finally {
      this.busy = false;
      tidy(this.dataDir);
    }
  }

  /**
   * Rychlá aktualizace skóre právě hraných zápasů ze SofaScore (jeden dotaz na ligu a den).
   * Vrací pole tipů, nebo null, když nic nehraje.
   */
  async refreshLive(now = new Date()) {
    if (this.busy) return null;
    const all = this.db.tipsOfLatestRun();
    const HOUR = 3600e3;
    const active = all.filter((t) => t.status !== "finished" && t.kickoff - now < 10 * 60e3 && now - t.kickoff < 4 * HOUR);
    if (!active.length) return null;
    this.busy = true;
    try {
      const sofa = new SofaScoreClient(this.http);
      await sofa.enrich(active, () => {});
      if (!sofa.requestsOk) return null;
      for (const t of active) this.db.updateLive(t);
      settleFinished(this.db);
      return this.db.tipsOfLatestRun().map(serializeTip);
    } finally {
      this.busy = false;
    }
  }

  liveMatches() { return new LiveClient(this.http).list(); }

  liveDetail(id) { return new LiveClient(this.http).detail(id); }

  /** Statistika úspěšnosti všech vyhodnocených tipů (kalibrace pravděpodobnosti, trhy, soutěže). */
  analysis() {
    settleFinished(this.db);
    return analyze(this.db.history(null).map(serializeTip));
  }

  /** Zadání pro AI: slovní rozbor vyhodnocených tiketů (ze záložky Tikety). */
  aiPrompt() {
    const settled = this._settledTickets();
    if (!settled.some((t) => t.status === "win" || t.status === "loss" || t.status === "void")) {
      throw new Error("Zatím nejsou vyhodnocené žádné tikety. Vytvoř je v záložce Tikety a po zápasech je nech vyhodnotit tlačítkem „Vyhodnotit automaticky“.");
    }
    return buildTicketsPrompt(settled);
  }

  /** Tipy z přehledu pro tikety (z posledního stažení; jen ty, které ještě nezačaly) a statistika dosavadní úspěšnosti. */
  ticketInput({ day }) {
    const tips = this.db.tipsOfLatestRun().map(serializeTip);
    return { candidates: candidatesFrom(tips, { day }), calibration: this.analysis(), ticketResults: ticketGroups(this._settledTickets()) };
  }

  /**
   * Statistiky zápasů (forma, H2H, góly, zranění) ze SofaScore pro tikety; ladicí soubor jde do složky `ladeni`.
   * Zápasy, které ještě nemají přiřazený zápas na SofaScore, si aplikace nejdřív najde sama (a uloží si to).
   */
  async collectTicketStats(candidates, progress = () => {}) {
    await this.linkSofaScore(candidates, progress);
    return new MatchStats(this.http, { debugDir: path.join(this.dataDir, "ladeni"), cache: this.statsCache }).collect(candidates, progress);
  }

  /** Doplní `sofascoreId` kandidátům, kteří ho nemají (hledá se podle soutěže, týmů a času); nalezené ID se uloží i do databáze. */
  async linkSofaScore(candidates, progress = () => {}) {
    const missing = candidates.filter((c) => !c.sofascoreId);
    if (!missing.length) return 0;
    progress(`Hledám na SofaScore ${missing.length} ${missing.length === 1 ? "zápas" : "zápasů"}, které ještě nemají přiřazená data…`);
    const copies = missing.map((c) => ({ ...c, kickoff: new Date(c.kickoff) }));
    try {
      await new SofaScoreClient(this.http).enrich(copies);
    } catch {
      return 0;                                                  // bez SofaScore se tikety dělat nedají, ale hlášku dá až stahování statistik
    }
    let found = 0;
    copies.forEach((copy, i) => {
      if (!copy.sofascoreId) return;
      missing[i].sofascoreId = copy.sofascoreId;
      missing[i].sofascoreUrl = copy.sofascoreUrl;
      found += 1;
      try { this.db.updateLive({ id: missing[i].id, status: copy.status, homeScore: copy.homeScore ?? null, awayScore: copy.awayScore ?? null, sofascoreUrl: copy.sofascoreUrl, sofascoreId: copy.sofascoreId }); } catch { /* uložení je jen bonus */ }
    });
    return found;
  }

  /** Forma, H2H a absence pro detail tipu (SofaScore; mezipaměť sdílí s tikety). */
  async matchDetail(sofascoreId, forebetUrl = "") {
    const id = Number(sofascoreId);
    if (!Number.isFinite(id) || id <= 0) throw new Error("Zápas nemá přiřazený zápas na SofaScore.");
    const r = await new MatchStats(this.http, { cache: this.statsCache, delayMs: [150, 400] }).detail(id);
    const goals = forebetUrl ? this.goalsCache.get(String(forebetUrl)) : null; // koláče z Forebetu, když je jeho stránka zápasu v mezipaměti
    return { ...r, charts: chartsWithForebet(r.charts, goals && goals.recent) };
  }

  /** Uloží tikety od AI (pro pozdější vyhodnocení). */
  saveTickets(tickets) {
    for (const t of tickets) if (t.legs.every((l) => Number.isFinite(l.tipId))) this.db.saveTicket(t);
  }

  /** Zápasy z čekajících tiketů, které začnou do 15 minut (pro upozornění); `notified` si drží volající. */
  dueKickoffs(notified, now = new Date()) {
    const tickets = this.db.listTickets(30);
    return dueKickoffs(tickets, this.db.outcomesByIds(tickets.flatMap((t) => t.legs.map((l) => l.tipId))), now, notified);
  }

  /** Uložené tikety s výsledky podle výsledků jejich tipů a souhrn (tikety × všechny tipy). */
  ticketHistory(limit = 60) {
    const settled = this._settledTickets();
    return { tickets: settled.slice(0, limit), stats: ticketStats(settled) };
  }

  /** Všechny uložené tikety s výsledky podle výsledků jejich tipů (nejnovější první). */
  _settledTickets() {
    settleFinished(this.db);
    const all = this.db.listTickets();
    const ids = all.flatMap((t) => t.legs.map((l) => l.tipId));
    const outcomes = this.db.outcomesByIds(ids);
    const scores = this.db.scoresByIds(ids);
    return all.map((t) => {
      const settled = settleTicket(t, outcomes);
      return { ...settled, legs: settled.legs.map((l) => ({ ...l, score: scores.get(l.tipId) || "" })) };   // výsledek zápasu u každého tipu
    });
  }

  /** Diagnostika pro vývojáře (text); uloží se i do `ladeni/diagnostika.txt`. */
  diagnosticsText(info) {
    const dir = path.join(this.dataDir, "ladeni");
    const text = buildDiagnostics({ ...info, run: this.db.latestRun(), tips: this.db.tipsOfLatestRun(), dir });
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "diagnostika.txt"), text, "utf8");
    } catch {
      /* soubor je jen záloha, text se vrací vždy */
    }
    return text;
  }

  /** Kde je ladicí soubor se statistikami pro tikety (pro hlášky o chybách). */
  ticketDiagnosticsFile() { return path.join(this.dataDir, "ladeni", "tikety-statistiky.txt"); }

  history(period = null) {
    settleFinished(this.db);
    const range = period && typeof period === "object";
    const tips = range ? this.db.historyRange(period.from || null, period.to || null) : this.db.history(period);
    return { tips: tips.map(serializeTip), stats: this.db.stats(null, tips) };
  }

  async evaluate(progress = () => {}) {
    if (this.busy) throw new Error("Stahování už běží.");
    this.busy = true;
    try {
      return await updateResults(this.db, this.http, { progress });
    } finally {
      this.busy = false;
    }
  }

  close() { this.db.close(); }
}

module.exports = { TipService };
