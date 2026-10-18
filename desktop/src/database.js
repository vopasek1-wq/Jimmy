// Lokální SQLite databáze: dnešní tipy, historie a výsledky (vestavěný modul node:sqlite).
//
// Princip:
//  * každé úspěšné stažení = jeden „běh“ (tabulka runs);
//  * každý tip se ukládá jednou (unikátní `key` = den + týmy + typ tipu) a při dalším stažení se jen
//    aktualizuje – ručně zadaný výsledek se nikdy nepřepíše;
//  * tip má `last_run_id`: přehled „dnes“ ukazuje jen tipy z posledního úspěšného běhu, starší zůstávají
//    v historii. Díky tomu offline vidíme poslední známá data.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { tipKey } = require("./models");
const { addDays, localDate, todayLocal } = require("./timeutil");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    statuses    TEXT NOT NULL DEFAULT '{}',
    warnings    TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS tips (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    key             TEXT NOT NULL UNIQUE,
    tip_date        TEXT NOT NULL,
    kickoff_utc     TEXT NOT NULL,
    home            TEXT NOT NULL,
    away            TEXT NOT NULL,
    league_key      TEXT NOT NULL,
    league          TEXT NOT NULL,
    tip_code        TEXT NOT NULL,
    tip_label       TEXT NOT NULL,
    raw_label       TEXT NOT NULL DEFAULT '',
    probability     REAL NOT NULL,
    odds            REAL,
    odds_estimated  INTEGER NOT NULL DEFAULT 0,
    sources         TEXT NOT NULL,
    prob_forebet    REAL,
    prob_source     TEXT,
    status          TEXT NOT NULL DEFAULT 'upcoming',
    home_score      INTEGER,
    away_score      INTEGER,
    url             TEXT NOT NULL DEFAULT '',
    sofascore_url   TEXT NOT NULL DEFAULT '',
    sofascore_id    INTEGER,
    outcome         TEXT,
    outcome_source  TEXT,
    last_run_id     INTEGER,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tips_date ON tips(tip_date);
CREATE INDEX IF NOT EXISTS idx_tips_run ON tips(last_run_id);
`;

// outcome a outcome_source se při aktualizaci záměrně nemění
const UPSERT = `
INSERT INTO tips (key, tip_date, kickoff_utc, home, away, league_key, league, tip_code, tip_label, raw_label,
                  probability, odds, odds_estimated, sources, prob_forebet, prob_source, status, home_score, away_score,
                  url, sofascore_url, sofascore_id, last_run_id, created_at, updated_at)
VALUES (:key, :tip_date, :kickoff_utc, :home, :away, :league_key, :league, :tip_code, :tip_label, :raw_label,
        :probability, :odds, :odds_estimated, :sources, :prob_forebet, :prob_source, :status, :home_score, :away_score,
        :url, :sofascore_url, :sofascore_id, :run_id, :now, :now)
ON CONFLICT(key) DO UPDATE SET
    tip_date=excluded.tip_date, kickoff_utc=excluded.kickoff_utc, tip_label=excluded.tip_label,
    probability=excluded.probability, odds=excluded.odds, odds_estimated=excluded.odds_estimated,
    sources=excluded.sources, prob_forebet=excluded.prob_forebet, prob_source=excluded.prob_source, status=excluded.status,
    home_score=excluded.home_score, away_score=excluded.away_score, url=excluded.url,
    sofascore_url=excluded.sofascore_url, sofascore_id=excluded.sofascore_id,
    last_run_id=excluded.last_run_id, updated_at=excluded.updated_at
`;

function rowToTip(r) {
  return {
    id: Number(r.id), home: r.home, away: r.away, leagueKey: r.league_key, league: r.league,
    kickoff: new Date(r.kickoff_utc), tipCode: r.tip_code, tipLabel: r.tip_label, rawLabel: r.raw_label,
    probability: r.probability, odds: r.odds, oddsEstimated: Boolean(r.odds_estimated),
    sources: r.sources.split("|"), probForebet: r.prob_forebet, probSource: r.prob_source || "Scores24", status: r.status,
    homeScore: r.home_score, awayScore: r.away_score, url: r.url, sofascoreUrl: r.sofascore_url,
    sofascoreId: r.sofascore_id, outcome: r.outcome, outcomeSource: r.outcome_source,
  };
}

class Database {
  constructor(file) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    // databáze z dřívějších verzí nemá sloupec prob_source
    if (!this.db.prepare("PRAGMA table_info(tips)").all().some((c) => c.name === "prob_source")) {
      this.db.exec("ALTER TABLE tips ADD COLUMN prob_source TEXT");
    }
  }

  close() { this.db.close(); }

  // --- zápis ----------------------------------------------------------------------------------
  /** Uloží úspěšný běh a jeho tipy; vrací id běhu. */
  saveRun(result) {
    const stamp = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      const info = this.db.prepare("INSERT INTO runs (started_at, finished_at, statuses, warnings) VALUES (?,?,?,?)").run(
        (result.startedAt || new Date()).toISOString(), (result.finishedAt || new Date()).toISOString(),
        JSON.stringify(result.statuses), JSON.stringify(result.warnings));
      const runId = Number(info.lastInsertRowid);
      const upsert = this.db.prepare(UPSERT);
      for (const t of result.tips) {
        upsert.run({
          key: tipKey(t), tip_date: localDate(t.kickoff), kickoff_utc: t.kickoff.toISOString(), home: t.home, away: t.away,
          league_key: t.leagueKey, league: t.league, tip_code: t.tipCode, tip_label: t.tipLabel, raw_label: t.rawLabel || "",
          probability: t.probability, odds: t.odds ?? null, odds_estimated: t.oddsEstimated ? 1 : 0,
          sources: t.sources.join("|"), prob_forebet: t.probForebet ?? null, prob_source: t.probSource ?? null, status: t.status,
          home_score: t.homeScore ?? null, away_score: t.awayScore ?? null, url: t.url || "",
          sofascore_url: t.sofascoreUrl || "", sofascore_id: t.sofascoreId ?? null, run_id: runId, now: stamp,
        });
      }
      this.db.exec("COMMIT");
      return runId;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Aktualizuje stav a skóre rozehraných zápasů (bez nového běhu stahování). */
  updateLive(t) {
    this.db.prepare("UPDATE tips SET status=?, home_score=?, away_score=?, sofascore_url=?, sofascore_id=?, updated_at=? WHERE id=?")
      .run(t.status, t.homeScore ?? null, t.awayScore ?? null, t.sofascoreUrl || "", t.sofascoreId ?? null, new Date().toISOString(), t.id);
  }

  setOutcome(tipId, outcome, source = "manual") {
    this.db.prepare("UPDATE tips SET outcome=?, outcome_source=?, updated_at=? WHERE id=?")
      .run(outcome, outcome ? source : null, new Date().toISOString(), tipId);
  }

  // --- čtení ----------------------------------------------------------------------------------
  latestRun() {
    const r = this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").get();
    if (!r) return null;
    return {
      id: Number(r.id), startedAt: new Date(r.started_at), finishedAt: new Date(r.finished_at),
      statuses: JSON.parse(r.statuses), warnings: JSON.parse(r.warnings),
    };
  }

  /** Tipy, které viděl poslední úspěšný běh (podklad pro přehled a offline režim). */
  tipsOfLatestRun() {
    const run = this.latestRun();
    if (!run) return [];
    return this.db.prepare("SELECT * FROM tips WHERE last_run_id=? ORDER BY kickoff_utc").all(run.id).map(rowToTip);
  }

  /** Všechny uložené tipy (nejnovější první), volitelně jen za posledních `days` dní. */
  /** Tipy z rozsahu místních dnů „od–do“ (RRRR-MM-DD, kterýkoli konec může chybět). */
  historyRange(from = null, to = null) {
    const where = [];
    const args = [];
    if (from) { where.push("tip_date >= ?"); args.push(from); }
    if (to) { where.push("tip_date <= ?"); args.push(to); }
    const sql = `SELECT * FROM tips ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY kickoff_utc DESC`;
    return this.db.prepare(sql).all(...args).map(rowToTip);
  }

  history(days = null) {
    if (days === null || days === undefined) {
      return this.db.prepare("SELECT * FROM tips ORDER BY kickoff_utc DESC").all().map(rowToTip);
    }
    const from = addDays(todayLocal(), -days);
    return this.db.prepare("SELECT * FROM tips WHERE tip_date >= ? ORDER BY kickoff_utc DESC").all(from).map(rowToTip);
  }

  /** Tipy bez výsledku, jejichž zápas už musel skončit – kandidáti na automatické vyhodnocení. */
  pendingResults(kickedOffBefore) {
    return this.db.prepare("SELECT * FROM tips WHERE outcome IS NULL AND kickoff_utc <= ? ORDER BY kickoff_utc")
      .all(kickedOffBefore.toISOString()).map(rowToTip);
  }

  stats(days = null, tips = this.history(days)) {
    const s = { total: tips.length, evaluated: 0, wins: 0, losses: 0, voids: 0, avgOdds: null, profit: null, roiPct: null, hitRate: null };
    const decidedReal = [];
    for (const t of tips) {
      if (!t.outcome) continue;
      s.evaluated += 1;
      if (t.outcome === "win") s.wins += 1;
      else if (t.outcome === "loss") s.losses += 1;
      else if (t.outcome === "void") s.voids += 1;
      if ((t.outcome === "win" || t.outcome === "loss") && t.odds && !t.oddsEstimated) decidedReal.push(t);
    }
    const settled = s.wins + s.losses;
    s.hitRate = settled ? (100 * s.wins) / settled : null;
    const odds = tips.filter((t) => t.odds).map((t) => t.odds);
    s.avgOdds = odds.length ? odds.reduce((a, b) => a + b, 0) / odds.length : null;
    if (decidedReal.length) {
      // Vklad 1 na každý tip; počítají se jen tipy se skutečným (ne odhadnutým) kurzem.
      s.profit = decidedReal.reduce((sum, t) => sum + (t.outcome === "win" ? t.odds - 1 : -1), 0);
      s.roiPct = (100 * s.profit) / decidedReal.length;
    }
    return s;
  }
}

module.exports = { Database, rowToTip };
