"""Převody kurzů: americké / zlomkové / desetinné → desetinné, odhad kurzu."""
from __future__ import annotations

import re

from . import config

_AMERICAN = re.compile(r"^[+-]\d{3,5}$")
_FRACTION = re.compile(r"^(\d+(?:\.\d+)?)/(\d+(?:\.\d+)?)$")
_DECIMAL = re.compile(r"^\d{1,3}(?:[.,]\d{1,3})?$")


def american_to_decimal(value: float) -> float:
    """−143 → 1,70;  +150 → 2,50."""
    if value < 0:
        return 1.0 + 100.0 / abs(value)
    return 1.0 + value / 100.0


def parse_odds(text: str | None) -> float | None:
    """Rozpozná kurz v libovolném běžném formátu a vrátí desetinný kurz (2 desetinná místa).

    Scores24 podle geolokace IP ukazuje buď desetinné kurzy (1.85), nebo americké (-118).
    Vracíme None, pokud text kurz neobsahuje nebo vychází nesmyslně (≤ 1,00).
    """
    if not text:
        return None
    s = text.strip().replace("−", "-").replace(" ", "").replace("\xa0", "")
    if not s or s in {"-", "–", "—"}:
        return None

    value: float | None = None
    if _AMERICAN.match(s):
        n = float(s)
        if abs(n) >= 100:
            value = american_to_decimal(n)
    elif (m := _FRACTION.match(s)) is not None:
        den = float(m.group(2))
        if den > 0:
            value = 1.0 + float(m.group(1)) / den
    elif _DECIMAL.match(s):
        n = float(s.replace(",", "."))
        # Holé celé číslo ≥ 100 bez znaménka je americký kurz (+150); jinak desetinný.
        value = american_to_decimal(n) if n >= 100 else n

    if value is None or value <= 1.0:
        return None
    return round(value, 2)


def estimate_odds(probability: float, margin: float = config.ESTIMATED_MARGIN) -> float | None:
    """Odhad kurzu z pravděpodobnosti (v procentech), když zdroj kurz neuvádí.

    Férový kurz je 100 / p; sázkovka ho zmenší o marži, takže odhad je spíš opatrný.
    """
    if not probability or probability <= 0 or probability >= 100:
        return None
    return round(100.0 / probability * (1.0 - margin), 2)


def fmt_odds(odds: float | None, estimated: bool = False) -> str:
    if odds is None:
        return "–"
    return f"~{odds:.2f}" if estimated else f"{odds:.2f}"
