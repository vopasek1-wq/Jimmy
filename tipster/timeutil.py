"""Práce s časem: vše interně v UTC, zobrazení v pražském čase."""
from __future__ import annotations

from datetime import date, datetime, timezone

from . import config

try:
    from zoneinfo import ZoneInfo
    LOCAL_TZ = ZoneInfo(config.DISPLAY_TZ)
except Exception as exc:  # ZoneInfoNotFoundError – typicky ve Windows bez balíčku tzdata
    raise RuntimeError(
        "Chybí databáze časových pásem. Nainstalujte ji příkazem: pip install tzdata"
    ) from exc

UTC = timezone.utc

_CZ_DAYS = ("po", "út", "st", "čt", "pá", "so", "ne")


def now_utc() -> datetime:
    return datetime.now(UTC)


def to_local(dt: datetime) -> datetime:
    return dt.astimezone(LOCAL_TZ)


def local_date(dt: datetime) -> date:
    """Datum zápasu v pražském čase – podle něj se řadí tipy do „dnes“ a „zítra“."""
    return to_local(dt).date()


def today_local() -> date:
    return local_date(now_utc())


def fmt_kickoff(dt: datetime) -> str:
    """Např. „ne 18.10. 17:30“."""
    loc = to_local(dt)
    return f"{_CZ_DAYS[loc.weekday()]} {loc.day}.{loc.month}. {loc:%H:%M}"


def fmt_stamp(dt: datetime) -> str:
    """Časová značka poslední aktualizace, např. „18.10.2026 14:03“."""
    loc = to_local(dt)
    return f"{loc.day}.{loc.month}.{loc.year} {loc:%H:%M}"


def parse_iso_utc(text: str) -> datetime:
    """Načte ISO řetězec uložený v databázi; bez časové zóny považuje za UTC."""
    dt = datetime.fromisoformat(text)
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
