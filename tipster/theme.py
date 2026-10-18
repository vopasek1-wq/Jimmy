"""Vzhled aplikace – stejný design systém jako „Value Bet Kalkulačka“.

Barevné tokeny (světlý i tmavý režim), pořadí písem a hranaté rohy jsou převzaté
z CSS kalkulačky (--ground, --surface, --ink, --accent, --signal, --pos, --neg, --warn,
display = Palatino, body = Segoe UI, mono = Cascadia Mono / Consolas).
Volba motivu se pamatuje v data/settings.json; výchozí je „podle systému“.
"""
from __future__ import annotations

import json
import logging
import sys
from dataclasses import dataclass

from . import config

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Palette:
    name: str
    ground: str
    surface: str
    sunk: str
    ink: str
    ink_soft: str
    ink_faint: str
    rule: str
    rule_strong: str
    accent: str
    accent_soft: str
    on_accent: str
    signal: str
    pos: str
    pos_soft: str
    neg: str
    neg_soft: str
    warn: str
    warn_soft: str
    draw: str          # neutrální segment (u kalkulačky „remíza“)


LIGHT = Palette(
    name="light", ground="#F3F5F3", surface="#FFFFFF", sunk="#E9EDEA",
    ink="#141B1E", ink_soft="#4A565A", ink_faint="#6F7B7E",
    rule="#CFD8D3", rule_strong="#A9B6B0",
    accent="#0E4C55", accent_soft="#DCE9EA", on_accent="#FFFFFF", signal="#A8621A",
    pos="#1C6B45", pos_soft="#DDEBE2", neg="#A33322", neg_soft="#F2E0DC",
    warn="#8A5A00", warn_soft="#F5EBD3", draw="#CCD3D0",
)

DARK = Palette(
    name="dark", ground="#111618", surface="#181F21", sunk="#1F2729",
    ink="#E7EDEB", ink_soft="#A9B6B4", ink_faint="#85918F",
    rule="#2C3739", rule_strong="#435052",
    accent="#6FBDC4", accent_soft="#1B3033", on_accent="#181F21", signal="#DFA35F",
    pos="#5FBE8D", pos_soft="#172E24", neg="#E28273", neg_soft="#2E1C19",
    warn="#E0B356", warn_soft="#2E2616", draw="#3E494A",
)

PALETTES = {"light": LIGHT, "dark": DARK}

# Pořadí písem jako v CSS kalkulačky; vybere se první, které je v systému k dispozici.
DISPLAY_FONTS = ("Palatino Linotype", "Palatino", "Book Antiqua", "Iowan Old Style", "Georgia", "DejaVu Serif")
BODY_FONTS = ("Segoe UI", "Roboto", "Helvetica Neue", "Arial", "Inter", "DejaVu Sans")
MONO_FONTS = ("Cascadia Mono", "Consolas", "SF Mono", "Roboto Mono", "Menlo", "DejaVu Sans Mono")


def pick_family(candidates: tuple[str, ...], available: set[str]) -> str:
    lowered = {a.lower(): a for a in available}
    for name in candidates:
        if name.lower() in lowered:
            return lowered[name.lower()]
    return candidates[-1]


# --- volba motivu ---------------------------------------------------------------------------

_SETTINGS = config.DATA_DIR / "settings.json"


def load_theme_choice() -> str:
    """„auto“ (podle systému), „light“ nebo „dark“."""
    try:
        value = json.loads(_SETTINGS.read_text(encoding="utf-8")).get("theme", "auto")
    except (OSError, ValueError):
        return "auto"
    return value if value in ("auto", "light", "dark") else "auto"


def save_theme_choice(choice: str) -> None:
    try:
        _SETTINGS.parent.mkdir(parents=True, exist_ok=True)
        try:
            data = json.loads(_SETTINGS.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        data["theme"] = choice
        _SETTINGS.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as exc:
        log.warning("Nepodařilo se uložit nastavení motivu: %s", exc)


def system_prefers_dark() -> bool:
    """Windows: tmavý režim aplikací z nastavení Personalizace. Jinde světlý."""
    if sys.platform != "win32":
        return False
    try:
        import winreg
        key = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as k:
            return winreg.QueryValueEx(k, "AppsUseLightTheme")[0] == 0
    except OSError:
        return False


def resolve_palette(choice: str) -> Palette:
    if choice == "auto":
        return DARK if system_prefers_dark() else LIGHT
    return PALETTES.get(choice, LIGHT)
