"""Povinné filtry tipů (ze zadání).

Tip se zobrazí, jen když platí všechno z toho:
  1. soutěž je ve sledovaném seznamu (config.LEAGUES),
  2. pravděpodobnost je STRIKTNĚ vyšší než 60 %,
  3. kurz je alespoň 1,50 (ze zdroje, nebo – když chybí – odhadnutý z pravděpodobnosti).
"""
from __future__ import annotations

from collections.abc import Iterable

from . import config
from .models import Tip
from .odds import estimate_odds

HIGH, MID = "high", "mid"


def ensure_odds(tip: Tip) -> Tip:
    """Doplní odhad kurzu, pokud zdroj žádný neuvedl (a označí ho jako odhad)."""
    if tip.odds is None:
        est = estimate_odds(tip.probability)
        if est is not None:
            tip.odds, tip.odds_estimated = est, True
    return tip


def passes_filters(tip: Tip) -> bool:
    league = config.league_by_key(tip.league_key)
    if league is None or not league.enabled:
        return False
    if tip.probability is None or not tip.probability > config.MIN_PROBABILITY:
        return False
    return tip.odds is not None and tip.odds >= config.MIN_ODDS


def apply_filters(tips: Iterable[Tip]) -> list[Tip]:
    """Zpracuje kurzy a nechá jen tipy, které splní všechny povinné podmínky."""
    return [t for t in (ensure_odds(t) for t in tips) if passes_filters(t)]


def probability_class(probability: float) -> str:
    """Zelená nad 75 %, žlutá v pásmu 60–75 % (včetně 75)."""
    return HIGH if probability > config.HIGH_PROBABILITY else MID
