"""Datové modely sdílené mezi scrapery, pipeline, databází a UI."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

# Stav zápasu
UPCOMING, LIVE, FINISHED = "upcoming", "live", "finished"

# Výsledek tipu
WIN, LOSS, VOID = "win", "loss", "void"
OUTCOME_LABELS = {WIN: "Výhra", LOSS: "Prohra", VOID: "Vráceno", None: "—"}

SOURCE_SCORES24 = "Scores24"
SOURCE_FOREBET = "Forebet"


@dataclass
class Tip:
    """Jeden tip na jeden zápas (po sloučení všech zdrojů)."""
    home: str
    away: str
    league_key: str
    league: str                      # český název soutěže
    kickoff_utc: datetime            # vždy aware UTC
    tip_code: str                    # kanonický kód trhu, viz markets.py (1, X, O2.5, BTTS…)
    tip_label: str                   # český popis tipu
    raw_label: str = ""              # původní text ze zdroje (pro ladění)
    probability: float = 0.0         # v procentech, 0–100
    odds: float | None = None        # desetinný kurz
    odds_estimated: bool = False     # True = odhad z pravděpodobnosti, ne kurz ze zdroje
    sources: tuple[str, ...] = ()
    prob_forebet: float | None = None
    status: str = UPCOMING
    home_score: int | None = None
    away_score: int | None = None
    url: str = ""                    # odkaz na zápas (Scores24)
    sofascore_url: str = ""
    sofascore_id: int | None = None
    # --- pole z databáze ---
    id: int | None = None
    outcome: str | None = None
    outcome_source: str | None = None

    @property
    def match_name(self) -> str:
        return f"{self.home} – {self.away}"

    @property
    def source_label(self) -> str:
        return " + ".join(self.sources)

    @property
    def key(self) -> str:
        """Identita tipu napříč opakovanými načteními (zápas + trh)."""
        from .names import normalize
        return "|".join((
            self.kickoff_utc.strftime("%Y-%m-%d"),
            normalize(self.home), normalize(self.away), self.tip_code,
        ))


@dataclass
class SourceStatus:
    """Výsledek načtení jednoho zdroje – zobrazí se uživateli ve stavovém řádku."""
    name: str
    state: str = "pending"           # ok | partial | failed | skipped | pending
    message: str = ""

    @property
    def ok(self) -> bool:
        return self.state in ("ok", "partial")


@dataclass
class ScrapeResult:
    tips: list[Tip] = field(default_factory=list)
    statuses: dict[str, SourceStatus] = field(default_factory=dict)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    offline: bool = False
    warnings: list[str] = field(default_factory=list)

    @property
    def success(self) -> bool:
        """Běh se ukládá jako nový „snímek“ jen tehdy, když prošel hlavní zdroj tipů."""
        st = self.statuses.get(SOURCE_SCORES24)
        return bool(st and st.ok)
