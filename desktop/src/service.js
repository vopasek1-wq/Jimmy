// Služba aplikace: spojuje databázi, stahování a vyhodnocení výsledků a připravuje data pro okno.
"use strict";

const path = require("node:path");
const config = require("./config");
const { Database } = require("./database");
const { probabilityClass } = require("./filters");
const { Pipeline, updateResults, settleFinished } = require("./pipeline");
const { SofaScoreClient } = require("./scrapers/sofascore");
const { LiveClient } = require("./live");
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
    oddsEstimated: Boolean(t.oddsEstimated), sources: t.sources, probForebet: t.probForebet ?? null,
    status: t.status, homeScore: t.homeScore ?? null, awayScore: t.awayScore ?? null,
    url: t.url || "", forebetUrl: t.forebetUrl || "", sofascoreUrl: t.sofascoreUrl || "", outcome: t.outcome ?? null, outcomeSource: t.outcomeSource ?? null,
  };
}

class TipService {
  constructor({ dbFile, http, browser }) {
    this.db = new Database(dbFile);
    this.dataDir = path.dirname(dbFile);
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
      const result = await new Pipeline({ http: this.http, browser: this.browser, debugDir: path.join(this.dataDir, "ladeni") }).run({ progress, interactiveForebet });
      if (resultOk(result)) {
        this.db.saveRun(result);
        await updateResults(this.db, this.http, { progress }).catch(() => {}); // doplní skóre a výsledky skončených zápasů
        return this._payload({
          tips: result.tips, statuses: result.statuses, warnings: result.warnings, updatedAt: result.finishedAt, fromCache: false,
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
    }
  }

  /** `period` = počet dní, null (vše), nebo { from, to } z kalendáře. */
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

  history(period = null) {
    settleFinished(this.db);
    const range = period && typeof period === "object";
    const tips = range ? this.db.historyRange(period.from || null, period.to || null) : this.db.history(period);
    return { tips: tips.map(serializeTip), stats: this.db.stats(null, tips) };
  }

  setOutcome(id, outcome) {
    if (![null, "win", "loss", "void"].includes(outcome)) throw new Error("Neplatný výsledek.");
    this.db.setOutcome(Number(id), outcome, "manual");
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

module.exports = { TipService, serializeTip };
