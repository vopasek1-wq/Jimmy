"""Řízení celého stahování: zdroje → sloučení → povinné filtry → obohacení → výsledek.

    Scores24  (tipy + procenta + kurzy)  ┐
    Forebet   (pravděpodobnosti 1/X/2)   ├→ combine() → apply_filters() → SofaScore (čas, stav, skóre)
    SofaScore (detaily zápasů)           ┘

Každý zdroj může selhat samostatně – chyba se zapíše do SourceStatus a ostatní
zdroje pokračují. Běh se považuje za úspěšný, jen když prošel Scores24 (hlavní zdroj tipů).
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timedelta

from . import config
from .browser import BrowserSession, BrowserUnavailable
from .database import Database
from .filters import apply_filters
from .http import HttpClient, NetworkError, SourceError
from .markets import evaluate, forebet_probability, result_market
from .models import (FINISHED, SOURCE_FOREBET, SOURCE_SCORES24, UPCOMING, ScrapeResult,
                     SourceStatus, Tip)
from .names import same_match
from .scrapers.forebet import FbMatch, ForebetScraper
from .scrapers.scores24 import Row, Scores24Result, Scores24Scraper, classify_status, kickoff_of
from .scrapers.sofascore import SofaScoreClient
from .timeutil import local_date, now_utc, today_local

log = logging.getLogger(__name__)

SOURCE_SOFASCORE = "SofaScore"
FOREBET_TOLERANCE = timedelta(hours=3)     # Forebet může mít jiné pásmo/zaokrouhlení času
Progress = Callable[[str], None]


# --- sloučení zdrojů ----------------------------------------------------------------------------

def _find_forebet(home: str, away: str, league_key: str | None, kickoff: datetime,
                  matches: list[FbMatch]) -> FbMatch | None:
    best, best_score = None, 0.0
    for m in matches:
        if m.kickoff is not None and abs(m.kickoff - kickoff) > FOREBET_TOLERANCE:
            continue
        if league_key and m.league_key and m.league_key != league_key:
            continue
        score = same_match(home, away, m.home, m.away)
        if score > best_score:
            best, best_score = m, score
    return best


def _find_row(m: FbMatch, rows: list[Row], now: datetime) -> Row | None:
    """Zápas z Forebetu → řádek Scores24 (z něj víme ligu, přesné názvy a čas)."""
    best, best_score = None, 0.0
    for r in rows:
        ko = kickoff_of(r, now)
        if ko is None or (m.kickoff is not None and abs(m.kickoff - ko) > FOREBET_TOLERANCE):
            continue
        score = same_match(r.home, r.away, m.home, m.away)
        if score > best_score:
            best, best_score = r, score
    return best


def combine(s24: Scores24Result | None, forebet: list[FbMatch] | None, now: datetime) -> list[Tip]:
    """Spojí tipy ze Scores24 s pravděpodobnostmi z Forebetu a přidá vlastní tipy Forebetu."""
    tips = list(s24.tips) if s24 else []
    rows = s24.rows if s24 else []
    if not forebet:
        return tips

    used: set[int] = set()                       # zápasy Forebetu, které už některý tip vyřešil
    for t in tips:
        m = _find_forebet(t.home, t.away, t.league_key, t.kickoff_utc, forebet)
        if m is None:
            continue
        t.prob_forebet = forebet_probability(t.tip_code, m.p1, m.px, m.p2)
        if m.pick == t.tip_code:                 # oba zdroje doporučují totéž
            t.sources = (SOURCE_SCORES24, SOURCE_FOREBET)
            used.add(id(m))

    # Vlastní tipy Forebetu: nejpravděpodobnější výsledek, který překročí práh.
    have = {(t.home, t.away, t.tip_code) for t in tips}
    for m in forebet:
        if id(m) in used or m.pick_probability <= config.MIN_PROBABILITY:
            continue
        row = _find_row(m, rows, now)
        league_key = row.league_key if row else m.league_key
        league = config.league_by_key(league_key) if league_key else None
        kickoff = (kickoff_of(row, now) if row else None) or m.kickoff
        if league is None or kickoff is None:
            continue                              # neznáme ligu/čas – nevíme, zda je zápas sledovaný
        home, away = (row.home, row.away) if row else (m.home, m.away)
        if (home, away, m.pick) in have:
            continue
        market = result_market(m.pick, home, away)
        tips.append(Tip(
            home=home, away=away, league_key=league.key, league=league.name_cs, kickoff_utc=kickoff,
            tip_code=market.code, tip_label=market.label_cs, raw_label="Forebet",
            probability=m.pick_probability, odds=m.odds.get(m.pick),
            sources=(SOURCE_FOREBET,), prob_forebet=m.pick_probability,
            status=(classify_status(row.status_token) if row else None) or UPCOMING,
            url=row.url if row else "",
        ))
    return tips


# --- celý běh -----------------------------------------------------------------------------------------

class Pipeline:
    def __init__(self, http: HttpClient | None = None, browser: BrowserSession | None = None):
        self.http = http or HttpClient()
        self.browser = browser or BrowserSession()

    def run(self, progress: Progress = lambda m: None) -> ScrapeResult:
        now = now_utc()
        result = ScrapeResult(started_at=now)
        st = result.statuses
        for name in (SOURCE_SCORES24, SOURCE_FOREBET, SOURCE_SOFASCORE):
            st[name] = SourceStatus(name)
        s24: Scores24Result | None = None
        forebet: list[FbMatch] | None = None

        try:
            # 1) Scores24 – hlavní zdroj
            try:
                s24 = Scores24Scraper(self.http, self.browser).fetch(now, progress)
                st[SOURCE_SCORES24].state = "partial" if s24.warnings else "ok"
                st[SOURCE_SCORES24].message = (" ".join(s24.warnings) if s24.warnings
                                               else f"{len(s24.tips)} tipů s procenty")
            except NetworkError as exc:
                st[SOURCE_SCORES24].state, st[SOURCE_SCORES24].message = "failed", str(exc)
                result.offline = exc.offline
            except (SourceError, BrowserUnavailable) as exc:
                st[SOURCE_SCORES24].state, st[SOURCE_SCORES24].message = "failed", str(exc)
            except Exception as exc:  # nečekaná chyba parseru – nechceme shodit aplikaci
                log.exception("Scores24: neočekávaná chyba")
                st[SOURCE_SCORES24].state, st[SOURCE_SCORES24].message = "failed", f"Neočekávaná chyba: {exc}"

            if not result.success:
                for name in (SOURCE_FOREBET, SOURCE_SOFASCORE):
                    st[name].state = "skipped"
                    st[name].message = "Přeskočeno – hlavní zdroj tipů není dostupný."
                return self._finish(result)

            # 2) Forebet – pravděpodobnosti (volitelný zdroj)
            try:
                forebet = ForebetScraper(self.http, self.browser).fetch(progress)
                st[SOURCE_FOREBET].state = "ok"
                st[SOURCE_FOREBET].message = f"{len(forebet)} zápasů"
            except (SourceError, BrowserUnavailable) as exc:
                st[SOURCE_FOREBET].state, st[SOURCE_FOREBET].message = "failed", str(exc)
            except Exception as exc:
                log.exception("Forebet: neočekávaná chyba")
                st[SOURCE_FOREBET].state, st[SOURCE_FOREBET].message = "failed", f"Neočekávaná chyba: {exc}"

            # 3) sloučení + povinné filtry
            tips = apply_filters(combine(s24, forebet, now))

            # 4) SofaScore – přesný čas, stav, skóre
            sofa = SofaScoreClient(self.http)
            try:
                tips = sofa.enrich(tips, progress)
                if sofa.requests_ok == 0 and sofa.errors:
                    st[SOURCE_SOFASCORE].state, st[SOURCE_SOFASCORE].message = "failed", sofa.errors[0]
                else:
                    st[SOURCE_SOFASCORE].state = "partial" if sofa.errors else "ok"
                    st[SOURCE_SOFASCORE].message = sofa.errors[0] if sofa.errors else f"{sofa.requests_ok} dotazů"
            except Exception as exc:
                log.exception("SofaScore: neočekávaná chyba")
                st[SOURCE_SOFASCORE].state, st[SOURCE_SOFASCORE].message = "failed", f"Neočekávaná chyba: {exc}"

            result.tips = sorted(tips, key=lambda t: (t.kickoff_utc, -t.probability))
            return self._finish(result)
        finally:
            self.browser.close()

    @staticmethod
    def _finish(result: ScrapeResult) -> ScrapeResult:
        result.finished_at = now_utc()
        # Do bannerů ve UI jdou jen zdroje, které selhaly nebo se načetly částečně.
        result.warnings = [s.message if s.message.startswith(f"{s.name}:") else f"{s.name}: {s.message}"
                           for s in result.statuses.values() if s.state in ("failed", "partial") and s.message]
        return result


# --- automatické vyhodnocení výsledků ------------------------------------------------------------------

def update_results(db: Database, http: HttpClient | None = None, progress: Progress = lambda m: None,
                   max_age_days: int = 14) -> tuple[int, str]:
    """Doplní výsledky skončených zápasů podle SofaScore. Vrací (počet vyhodnocených, zpráva).

    Vyhodnocují se jen tipy bez výsledku, jejichž zápas začal před více než 3 hodinami
    a nejsou starší než `max_age_days`. Ručně zadané výsledky se nikdy nepřepisují
    (ty už výsledek mají). Neznámé trhy a čtvrtinové linie se nechávají ručně.
    """
    cutoff = today_local() - timedelta(days=max_age_days)
    pending = [t for t in db.pending_results(now_utc() - timedelta(hours=3))
               if local_date(t.kickoff_utc) >= cutoff]
    if not pending:
        return 0, "Žádné tipy nečekají na vyhodnocení."

    progress("SofaScore: zjišťuji výsledky zápasů…")
    client = SofaScoreClient(http or HttpClient())
    done = skipped = 0
    for t in pending:
        league = config.league_by_key(t.league_key)
        if league is None or not league.sofascore_id:
            skipped += 1
            continue
        ev = client.find(league.sofascore_id, t.home, t.away, t.kickoff_utc)
        if ev is None or ev.status != FINISHED or ev.home_score is None or ev.away_score is None:
            skipped += 1
            continue
        outcome = evaluate(t.tip_code, ev.home_score, ev.away_score)
        if outcome is None:
            skipped += 1
            continue
        db.set_outcome(t.id, outcome, "auto")
        done += 1

    msg = f"Vyhodnoceno {done} tipů"
    if skipped:
        msg += f", {skipped} zůstává bez výsledku (zápas neskončil, nenalezen nebo trh nelze vyhodnotit automaticky)"
    if client.errors and not client.requests_ok:
        msg = "SofaScore je nedostupný: " + client.errors[0]
    return done, msg + "."
