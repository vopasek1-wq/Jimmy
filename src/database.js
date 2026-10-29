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
const { normalizePick } = require("./markets");
const { isWomens } = require("./filters");
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
    forebet_url     TEXT,
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
CREATE TABLE IF NOT EXISTS tickets (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at        TEXT NOT NULL,
    day               TEXT NOT NULL,
    name              TEXT NOT NULL,
    verdict           TEXT NOT NULL DEFAULT '',
    summary           TEXT NOT NULL DEFAULT '',
    total_odds        REAL NOT NULL,
    joint_probability REAL NOT NULL,
    legs              TEXT NOT NULL,
    signature         TEXT NOT NULL,
    UNIQUE(day, signature)
);
CREATE INDEX IF NOT EXISTS idx_tips_date ON tips(tip_date);
CREATE INDEX IF NOT EXISTS idx_tips_run ON tips(last_run_id);
`;

// outcome a outcome_source se při aktualizaci záměrně nemění
const UPSERT = `
INSERT INTO tips (key, tip_date, kickoff_utc, home, away, league_key, league, tip_code, tip_label, raw_label,
                  probability, odds, odds_estimated, sources, prob_forebet, prob_source, forebet_url, status, home_score, away_score,
                  url, sofascore_url, sofascore_id, last_run_id, created_at, updated_at)
VALUES (:key, :tip_date, :kickoff_utc, :home, :away, :league_key, :league, :tip_code, :tip_label, :raw_label,
        :probability, :odds, :odds_estimated, :sources, :prob_forebet, :prob_source, :forebet_url, :status, :home_score, :away_score,
        :url, :sofascore_url, :sofascore_id, :run_id, :now, :now)
ON CONFLICT(key) DO UPDATE SET
    tip_date=excluded.tip_date, kickoff_utc=excluded.kickoff_utc, tip_label=excluded.tip_label,
    probability=excluded.probability, odds=excluded.odds, odds_estimated=excluded.odds_estimated,
    sources=excluded.sources, prob_forebet=excluded.prob_forebet, prob_source=excluded.prob_source, forebet_url=excluded.forebet_url, status=excluded.status,
    home_score=excluded.home_score, away_score=excluded.away_score, url=excluded.url,
    sofascore_url=excluded.sofascore_url, sofascore_id=excluded.sofascore_id,
    last_run_id=excluded.last_run_id, updated_at=excluded.updated_at
`;

/** Starší záznamy mají uložený anglický popisek – znovu se odvodí z původního textu (kód trhu se nemění). */
function labelOf(r) {
  if (!r.raw_label || r.raw_label === "Forebet") return r.tip_label;
  const m = normalizePick(r.raw_label, r.home, r.away);
  return m.code === r.tip_code || r.tip_code.startsWith("OTHER:") ? m.labelCs : r.tip_label; // starý neznámý trh: jen nový český popisek
}

function rowToTip(r) {
  return {
    id: Number(r.id), home: r.home, away: r.away, leagueKey: r.league_key, league: r.league,
    kickoff: new Date(r.kickoff_utc), tipCode: r.tip_code, tipLabel: labelOf(r), rawLabel: r.raw_label,
    probability: r.probability, odds: r.odds, oddsEstimated: Boolean(r.odds_estimated),
    sources: r.sources.split("|"), probForebet: r.prob_forebet, probSource: r.prob_source || "Scores24", forebetUrl: r.forebet_url || "", status: r.status,
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
    const columns = this.db.prepare("PRAGMA table_info(tips)").all().map((c) => c.name);
    if (!columns.includes("prob_source")) this.db.exec("ALTER TABLE tips ADD COLUMN prob_source TEXT");
    if (!columns.includes("forebet_url")) this.db.exec("ALTER TABLE tips ADD COLUMN forebet_url TEXT");
    this._upgradeUnknownMarkets();
    this._dropWomens();
  }

  /**
   * Starší verze neuměla některé trhy (např. „X will not score“) a uložila je jako OTHER:<text>. Nový kód trhu se
   * odvodí z původního textu; když takový tip už existuje, je starý jen duplicita a smaže se.
   */
  _upgradeUnknownMarkets() {
    const rows = this.db.prepare("SELECT * FROM tips WHERE tip_code LIKE 'OTHER:%' AND raw_label <> '' AND raw_label <> 'Forebet'").all();
    for (const r of rows) {
      const m = normalizePick(r.raw_label, r.home, r.away);
      if (m.code.startsWith("OTHER:")) continue;
      const tip = rowToTip(r);
      const key = tipKey({ ...tip, tipCode: m.code });
      if (this.db.prepare("SELECT 1 FROM tips WHERE key=?").get(key)) {
        this.db.prepare("DELETE FROM tips WHERE id=?").run(r.id);
      } else {
        this.db.prepare("UPDATE tips SET key=?, tip_code=?, tip_label=? WHERE id=?").run(key, m.code, m.labelCs, r.id);
      }
    }
  }

  /** Ženské zápasy se už nesledují – dřív uložené tipy se z databáze (i z historie) odstraní. */
  _dropWomens() {
    const rows = this.db.prepare("SELECT id, home, away FROM tips").all();
    const del = this.db.prepare("DELETE FROM tips WHERE id=?");
    for (const r of rows) if (isWomens({ home: r.home, away: r.away })) del.run(r.id);
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
          sources: t.sources.join("|"), prob_forebet: t.probForebet ?? null, prob_source: t.probSource ?? null, forebet_url: t.forebetUrl || null, status: t.status,
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

  /** Uloží tiket od AI (stejná sada tipů ve stejný den se neuloží podruhé); vrací true, když šlo o nový. */
  saveTicket(t) {
    const day = localDate(new Date(t.legs[0].kickoff));
    const signature = t.legs.map((l) => l.tipId).sort((a, b) => a - b).join(",");
    const info = this.db.prepare(`INSERT OR IGNORE INTO tickets (created_at, day, name, verdict, summary, total_odds, joint_probability, legs, signature)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(new Date().toISOString(), day, t.name, t.verdict || "", t.summary || "", t.totalOdds, t.jointProbability, JSON.stringify(t.legs), signature);
    return Number(info.changes) > 0;
  }

  /** Uložené tikety (nejnovější první); `limit` null = všechny. */
  listTickets(limit = null) {
    const rows = this.db.prepare(`SELECT * FROM tickets ORDER BY id DESC${limit ? " LIMIT ?" : ""}`).all(...(limit ? [limit] : []));
    return rows.map((r) => ({ id: Number(r.id), createdAt: r.created_at, day: r.day, name: r.name, verdict: r.verdict, summary: r.summary,
      totalOdds: r.total_odds, jointProbability: r.joint_probability, legs: JSON.parse(r.legs) }));
  }

  /** Výsledky tipů podle id: Map id → win/loss/void (tip bez výsledku v mapě není). */
  outcomesByIds(ids) {
    const out = new Map();
    const stmt = this.db.prepare("SELECT outcome FROM tips WHERE id=?");
    for (const id of new Set(ids)) { const r = stmt.get(id); if (r && r.outcome) out.set(id, r.outcome); }
    return out;
  }

  /** Skóre tipů podle id: Map id → "2:1" (jen tipy, u kterých je skóre známé). */
  scoresByIds(ids) {
    const out = new Map();
    const stmt = this.db.prepare("SELECT home_score, away_score FROM tips WHERE id=?");
    for (const id of new Set(ids)) { const r = stmt.get(id); if (r && r.home_score !== null && r.away_score !== null) out.set(id, `${r.home_score}:${r.away_score}`); }
    return out;
  }

  /** Typ tipu podle id: Map id → { tipCode, leagueKey } (pro rozbor tiketů po skupinách). */
  tipInfoByIds(ids) {
    const out = new Map();
    const stmt = this.db.prepare("SELECT tip_code, league_key FROM tips WHERE id=?");
    for (const id of new Set(ids)) { const r = stmt.get(id); if (r) out.set(id, { tipCode: r.tip_code, leagueKey: r.league_key }); }
    return out;
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

  /** Tipy, jejichž zápas už skončil, ale nemají uložené skóre (zápas doběhl mezi dvěma stahováními). */
  needScores(kickedOffBefore) {
    return this.db.prepare("SELECT * FROM tips WHERE home_score IS NULL AND kickoff_utc <= ? ORDER BY kickoff_utc")
      .all(kickedOffBefore.toISOString()).map(rowToTip);
  }

  /** Skončené zápasy se známým skóre, které ještě nemají výsledek tipu (vyhodnotí se bez dotazu na web). */
  finishedUnsettled() {
    return this.db.prepare("SELECT * FROM tips WHERE status='finished' AND outcome IS NULL AND home_score IS NOT NULL AND away_score IS NOT NULL")
      .all().map(rowToTip);
  }

  setScore(tipId, homeScore, awayScore) {
    this.db.prepare("UPDATE tips SET home_score=?, away_score=?, status='finished', updated_at=? WHERE id=?")
      .run(homeScore, awayScore, new Date().toISOString(), tipId);
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
