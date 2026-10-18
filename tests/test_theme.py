"""Motiv: kompletnost palet, čitelnost hlavního textu, ukládání volby a přepnutí za běhu."""
from __future__ import annotations

import dataclasses
import json
import re
import time
from datetime import timedelta

import pytest

from tipster import theme
from tipster.theme import DARK, LIGHT, Palette


def _luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def contrast(a: str, b: str) -> float:
    hi, lo = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


@pytest.mark.parametrize("pal", [LIGHT, DARK], ids=lambda p: p.name)
def test_palette_tokens_are_valid_hex(pal: Palette):
    for field in dataclasses.fields(pal):
        value = getattr(pal, field.name)
        if field.name != "name":
            assert re.fullmatch(r"#[0-9A-Fa-f]{6}", value), f"{field.name}={value}"


@pytest.mark.parametrize("pal", [LIGHT, DARK], ids=lambda p: p.name)
@pytest.mark.parametrize("fg, bg", [
    ("ink", "surface"), ("ink", "ground"), ("ink", "pos_soft"), ("ink", "warn_soft"), ("ink", "neg_soft"),
    ("ink", "sunk"), ("ink_soft", "surface"), ("ink_soft", "ground"), ("ink_soft", "sunk"),
    ("on_accent", "accent"), ("on_accent", "pos"), ("on_accent", "warn"), ("on_accent", "signal"),
    ("pos", "pos_soft"), ("warn", "warn_soft"), ("neg", "neg_soft"), ("accent", "ground"), ("ink", "draw"),
])
def test_text_pairs_meet_wcag_aa(pal: Palette, fg: str, bg: str):
    assert contrast(getattr(pal, fg), getattr(pal, bg)) >= 4.5


def test_palettes_match_value_bet_calculator_tokens():
    """Klíčové tokeny jsou převzaté beze změny z CSS „Value Bet Kalkulačky“."""
    assert (LIGHT.ground, LIGHT.surface, LIGHT.ink, LIGHT.accent, LIGHT.signal) == ("#F3F5F3", "#FFFFFF", "#141B1E", "#0E4C55", "#A8621A")
    assert (DARK.ground, DARK.surface, DARK.ink, DARK.accent, DARK.signal) == ("#111618", "#181F21", "#E7EDEB", "#6FBDC4", "#DFA35F")


def test_pick_family_uses_first_available_and_falls_back():
    assert theme.pick_family(("Segoe UI", "Arial", "DejaVu Sans"), {"Arial", "DejaVu Sans"}) == "Arial"
    assert theme.pick_family(("Segoe UI", "Arial"), {"Courier"}) == "Arial"        # nic nenalezeno → poslední (generické)


def test_theme_choice_roundtrip_and_bad_file(tmp_path, monkeypatch):
    monkeypatch.setattr(theme, "_SETTINGS", tmp_path / "sub" / "settings.json")
    assert theme.load_theme_choice() == "auto"                                   # soubor ještě není
    theme.save_theme_choice("dark")
    assert theme.load_theme_choice() == "dark"
    theme._SETTINGS.write_text("{ rozbitý json", encoding="utf-8")
    assert theme.load_theme_choice() == "auto"
    theme._SETTINGS.write_text(json.dumps({"theme": "fialový"}), encoding="utf-8")
    assert theme.load_theme_choice() == "auto"                                   # neznámá hodnota se ignoruje


def test_resolve_palette(monkeypatch):
    assert theme.resolve_palette("light") is LIGHT and theme.resolve_palette("dark") is DARK
    monkeypatch.setattr(theme, "system_prefers_dark", lambda: True)
    assert theme.resolve_palette("auto") is DARK
    monkeypatch.setattr(theme, "system_prefers_dark", lambda: False)
    assert theme.resolve_palette("auto") is LIGHT


# --- přepnutí motivu za běhu (GUI) -----------------------------------------------------------------

tk = pytest.importorskip("tkinter")


@pytest.fixture
def app(tmp_path, monkeypatch):
    from tipster.database import Database
    from tipster.ui import App
    monkeypatch.setattr(theme, "_SETTINGS", tmp_path / "settings.json")
    try:
        a = App(db=Database(tmp_path / "t.sqlite3"), auto_refresh=False)
    except tk.TclError as exc:
        pytest.skip(f"Není dostupný displej: {exc}")
    yield a
    a.destroy()


def _tip(home, prob, hours=2):
    from tipster.models import SOURCE_SCORES24, Tip
    from tipster.timeutil import now_utc
    return Tip(home=home, away="Soupeř", league_key="EPL", league="Anglie – Premier League",
               kickoff_utc=now_utc() + timedelta(hours=hours), tip_code="1", tip_label="1 – výhra",
               probability=prob, odds=1.7, sources=(SOURCE_SCORES24,))


def test_toggle_theme_rebuilds_ui_and_keeps_state(app):
    app.tips = [_tip("A", 80), _tip("B", 65), _tip("C", 70, hours=30)]
    app.hide_started.set(True)
    app.day_var.set("Dnes a zítra")
    app._apply_view()
    before = [t.home for t in app.today_table.items]
    app._show_view("history")

    first = app.pal.name
    app._toggle_theme()
    assert app.pal.name != first
    assert theme.load_theme_choice() == app.pal.name                             # volba se uložila
    assert app.view == "history"                                                 # zůstal stejný pohled
    assert app.hide_started.get() is True and app.day_var.get() == "Dnes a zítra"
    assert [t.home for t in app.today_table.items] == before                     # data a filtry přežily překreslení
    assert app.stats["count"].value == str(len(before))
    # nová tabulka už používá barvy nového motivu
    tag_bg = str(app.today_table.tree.tag_configure("high", "background"))
    assert tag_bg.lower() == app.pal.pos_soft.lower()

    app._toggle_theme()
    assert app.pal.name == first


def test_detail_card_follows_selection_and_clears(app):
    app.tips = [_tip("Arsenal", 82), _tip("Everton", 65)]
    app._apply_view()
    tree = app.today_table.tree
    assert "Vyberte tip" in app.detail.head.cget("text")
    iid = next(i for i, t in app.today_table._by_iid.items() if t.home == "Arsenal")
    tree.selection_set(iid)
    app.update()
    assert "výhra" in app.detail.head.cget("text") and "VYSOKÁ" in app.detail.state.cget("text")
    iid = next(i for i, t in app.today_table._by_iid.items() if t.home == "Everton")
    tree.selection_set(iid)
    app.update()
    assert "STŘEDNÍ" in app.detail.state.cget("text")
    app.tips = []
    app._apply_view()                                                            # vybraný tip zmizel
    assert "Vyberte tip" in app.detail.head.cget("text")


def test_stat_strip_values(app):
    app.tips = [_tip("A", 80), _tip("B", 90), _tip("C", 65)]
    app._apply_view()
    assert app.stats["count"].value == "3" and app.stats["high"].value == "2"       # nad 75 %: A a B
    assert app.stats["odds"].value == "1,70"                                      # desetinná čárka jako v kalkulačce
    assert app.stats["next"].value != "–"
    app.tips = []
    app._apply_view()
    assert app.stats["count"].value == "0" and app.stats["odds"].value == "–" and app.stats["next"].value == "–"


def test_compact_mode_hides_lead_in_low_window(app):
    app.geometry("1200x720+0+0")
    app.update()
    assert app._compact is True and not app.lead.winfo_ismapped()
    app.geometry("1200x900+0+0")
    app.update()
    assert app._compact is False and app.lead.winfo_ismapped()


def test_compact_mode_survives_theme_switch(app):
    app.geometry("1200x720+0+0")
    app.update()
    app._toggle_theme()
    app.update()
    assert not app.lead.winfo_ismapped()
