"""Lokální SQLite databáze: dnešní tipy, historie a výsledky.

Princip:
* každé úspěšné stažení = jeden „běh“ (tabulka runs);
* každý tip se ukládá jednou (unikátní `key` = den + týmy + typ tipu) a při dalším
  stažení se jen aktualizuje – ručně zadaný výsledek se nikdy nepřepíše;
* tip má `last_run_id`: přehled „dnes“ ukazuje jen tipy z posledního úspěšného běhu,
  starší zůstávají v historii. Díky tomu offline vidíme poslední známá data.
* každé volání si otevře vlastní spojení, takže databázi lze bezpečně použít z více vláken.
"""
from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from . import config
from .models import LOSS, VOID, WIN, ScrapeResult, SourceStatus, Tip
from .timeutil import local_date, now_utc, parse_iso_utc, today_local

SCHEMA = """
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
"""


@dataclass
class RunInfo:
    id: int
    started_at: datetime
    finished_at: datetime
    statuses: dict[str, SourceStatus]
    warnings: list[str]


@dataclass
class Stats:
    total: int = 0
    evaluated: int = 0
    wins: int = 0
    losses: int = 0
    voids: int = 0
    avg_odds: float | None = None
    profit: float | None = None       # v jednotkách vkladu (při vkladu 1 na každý tip)
    roi_pct: float | None = None

    @property
    def hit_rate(self) -> float | None:
        settled = self.wins + self.losses
        return 100.0 * self.wins / settled if settled else None


class Database:
    def __init__(self, path: Path | str = config.DB_PATH):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=15)
        conn.row_factory = sqlite3.Row
        try:
            with conn:                       # commit / rollback
                yield conn
        finally:
            conn.close()

    # --- zápis ---------------------------------------------------------------------------
    def save_run(self, result: ScrapeResult) -> int:
        """Uloží úspěšný běh a jeho tipy; vrací id běhu."""
        stamp = now_utc().isoformat()
        with self._connect() as conn:
            cur = conn.execute(
                "INSERT INTO runs (started_at, finished_at, statuses, warnings) VALUES (?,?,?,?)",
                ((result.started_at or now_utc()).isoformat(),
                 (result.finished_at or now_utc()).isoformat(),
                 json.dumps({k: [v.state, v.message] for k, v in result.statuses.items()}, ensure_ascii=False),
                 json.dumps(result.warnings, ensure_ascii=False)))
            run_id = cur.lastrowid
            for t in result.tips:
                conn.execute(_UPSERT, {
                    "key": t.key, "tip_date": local_date(t.kickoff_utc).isoformat(),
                    "kickoff_utc": t.kickoff_utc.isoformat(),
                    "home": t.home, "away": t.away, "league_key": t.league_key, "league": t.league,
                    "tip_code": t.tip_code, "tip_label": t.tip_label, "raw_label": t.raw_label,
                    "probability": t.probability, "odds": t.odds, "odds_estimated": int(t.odds_estimated),
                    "sources": "|".join(t.sources), "prob_forebet": t.prob_forebet,
                    "status": t.status, "home_score": t.home_score, "away_score": t.away_score,
                    "url": t.url, "sofascore_url": t.sofascore_url, "sofascore_id": t.sofascore_id,
                    "run_id": run_id, "now": stamp,
                })
        return run_id

    def set_outcome(self, tip_id: int, outcome: str | None, source: str | None = "manual") -> None:
        with self._connect() as conn:
            conn.execute("UPDATE tips SET outcome=?, outcome_source=?, updated_at=? WHERE id=?",
                         (outcome, source if outcome else None, now_utc().isoformat(), tip_id))

    # --- čtení ---------------------------------------------------------------------------
    def latest_run(self) -> RunInfo | None:
        with self._connect() as conn:
            r = conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
        if r is None:
            return None
        statuses = {name: SourceStatus(name, state, msg)
                    for name, (state, msg) in json.loads(r["statuses"]).items()}
        return RunInfo(r["id"], parse_iso_utc(r["started_at"]), parse_iso_utc(r["finished_at"]),
                       statuses, json.loads(r["warnings"]))

    def tips_of_latest_run(self) -> list[Tip]:
        """Tipy, které viděl poslední úspěšný běh (podklad pro přehled a offline režim)."""
        run = self.latest_run()
        if run is None:
            return []
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM tips WHERE last_run_id=? ORDER BY kickoff_utc", (run.id,)).fetchall()
        return [_row_to_tip(r) for r in rows]

    def history(self, days: int | None = None) -> list[Tip]:
        """Všechny uložené tipy (nejnovější první), volitelně jen za posledních `days` dní."""
        sql, args = "SELECT * FROM tips", []
        if days is not None:
            sql += " WHERE tip_date >= ?"
            args.append((today_local() - timedelta(days=days)).isoformat())
        with self._connect() as conn:
            rows = conn.execute(sql + " ORDER BY kickoff_utc DESC", args).fetchall()
        return [_row_to_tip(r) for r in rows]

    def pending_results(self, kicked_off_before: datetime) -> list[Tip]:
        """Tipy bez výsledku, jejichž zápas už musel skončit – kandidáti na automatické vyhodnocení."""
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM tips WHERE outcome IS NULL AND kickoff_utc <= ? "
                                "ORDER BY kickoff_utc", (kicked_off_before.isoformat(),)).fetchall()
        return [_row_to_tip(r) for r in rows]

    def stats(self, days: int | None = None) -> Stats:
        tips = self.history(days)
        s = Stats(total=len(tips))
        decided_real: list[Tip] = []
        for t in tips:
            if t.outcome is None:
                continue
            s.evaluated += 1
            if t.outcome == WIN:
                s.wins += 1
            elif t.outcome == LOSS:
                s.losses += 1
            elif t.outcome == VOID:
                s.voids += 1
            if t.outcome in (WIN, LOSS) and t.odds and not t.odds_estimated:
                decided_real.append(t)
        odds = [t.odds for t in tips if t.odds]
        s.avg_odds = sum(odds) / len(odds) if odds else None
        if decided_real:
            # Vklad 1 na každý tip; počítáme jen tipy se skutečným (ne odhadnutým) kurzem.
            s.profit = sum((t.odds - 1) if t.outcome == WIN else -1.0 for t in decided_real)
            s.roi_pct = 100.0 * s.profit / len(decided_real)
        return s


_UPSERT = """
INSERT INTO tips (key, tip_date, kickoff_utc, home, away, league_key, league, tip_code, tip_label, raw_label,
                  probability, odds, odds_estimated, sources, prob_forebet, status, home_score, away_score,
                  url, sofascore_url, sofascore_id, last_run_id, created_at, updated_at)
VALUES (:key, :tip_date, :kickoff_utc, :home, :away, :league_key, :league, :tip_code, :tip_label, :raw_label,
        :probability, :odds, :odds_estimated, :sources, :prob_forebet, :status, :home_score, :away_score,
        :url, :sofascore_url, :sofascore_id, :run_id, :now, :now)
ON CONFLICT(key) DO UPDATE SET
    tip_date=excluded.tip_date, kickoff_utc=excluded.kickoff_utc, tip_label=excluded.tip_label,
    probability=excluded.probability, odds=excluded.odds, odds_estimated=excluded.odds_estimated,
    sources=excluded.sources, prob_forebet=excluded.prob_forebet, status=excluded.status,
    home_score=excluded.home_score, away_score=excluded.away_score, url=excluded.url,
    sofascore_url=excluded.sofascore_url, sofascore_id=excluded.sofascore_id,
    last_run_id=excluded.last_run_id, updated_at=excluded.updated_at
"""   # outcome a outcome_source se při aktualizaci záměrně nemění


def _row_to_tip(r: sqlite3.Row) -> Tip:
    return Tip(
        id=r["id"], home=r["home"], away=r["away"], league_key=r["league_key"], league=r["league"],
        kickoff_utc=parse_iso_utc(r["kickoff_utc"]), tip_code=r["tip_code"], tip_label=r["tip_label"],
        raw_label=r["raw_label"], probability=r["probability"], odds=r["odds"],
        odds_estimated=bool(r["odds_estimated"]), sources=tuple(r["sources"].split("|")),
        prob_forebet=r["prob_forebet"], status=r["status"], home_score=r["home_score"],
        away_score=r["away_score"], url=r["url"], sofascore_url=r["sofascore_url"],
        sofascore_id=r["sofascore_id"], outcome=r["outcome"], outcome_source=r["outcome_source"],
    )
