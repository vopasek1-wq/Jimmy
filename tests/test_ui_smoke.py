"""Smoke test GUI: okno se postaví, zobrazí tipy, řadí, filtruje a zvládne stahování ve vlákně.

Přeskočí se, když není dostupný displej (v CI spusťte přes `xvfb-run pytest`).
"""
from __future__ import annotations

import time
from datetime import timedelta

import pytest

tk = pytest.importorskip("tkinter")

from tipster.database import Database  # noqa: E402
from tipster.models import FINISHED, SOURCE_SCORES24, WIN, ScrapeResult, SourceStatus, Tip  # noqa: E402
from tipster.timeutil import now_utc  # noqa: E402


@pytest.fixture
def app(tmp_path, monkeypatch):
    from tipster import theme
    from tipster.ui import App
    monkeypatch.setattr(theme, "_SETTINGS", tmp_path / "settings.json")
    try:
        a = App(db=Database(tmp_path / "ui.sqlite3"), auto_refresh=False, pipeline_factory=lambda: FakePipeline())
    except tk.TclError as exc:
        pytest.skip(f"Není dostupný displej: {exc}")
    yield a
    a.destroy()


def tip(home, prob, odds, hours=2, **kw):
    return Tip(home=home, away="Soupeř", league_key="EPL", league="Anglie – Premier League",
               kickoff_utc=now_utc() + timedelta(hours=hours), tip_code="1", tip_label=f"1 – výhra {home}",
               probability=prob, odds=odds, sources=(SOURCE_SCORES24,), **kw)


class FakeBrowser:
    def close(self): pass


class FakePipeline:
    browser = FakeBrowser()
    result: ScrapeResult | None = None

    def run(self, progress=lambda m: None):
        progress("test")
        return FakePipeline.result


def pump(app, cond, timeout=8.0):
    end = time.time() + timeout
    while not cond() and time.time() < end:
        app.update()
        time.sleep(0.02)
    assert cond()


def test_refresh_populates_table_counts_and_saves(app):
    FakePipeline.result = ScrapeResult(
        tips=[tip("Arsenal", 82, 1.7), tip("Everton", 65, 1.6), tip("Lille", 90, 1.5, hours=-4, status=FINISHED, home_score=2, away_score=0)],
        started_at=now_utc(), finished_at=now_utc(), statuses={SOURCE_SCORES24: SourceStatus(SOURCE_SCORES24, "ok", "3")})
    app.refresh()
    pump(app, lambda: not app._busy)
    assert app.lbl_count.cget("text") == "3"
    assert {t.home for t in app.today_table.items} == {"Arsenal", "Everton", "Lille"}
    assert len(app.db.tips_of_latest_run()) == 3                         # uloženo do databáze

    # výchozí řazení: pravděpodobnost sestupně → první řádek je Lille (90 %)
    first_iid = app.today_table.tree.get_children()[0]
    assert "Lille" in app.today_table.tree.item(first_iid)["values"][1]
    # barvy: 82 % je zelená, 65 % žlutá
    tags = {t.home: app.today_table.tree.item(i)["tags"] for i, t in app.today_table._by_iid.items()}
    assert "high" in tags["Arsenal"] and "mid" in tags["Everton"] and "finished" in tags["Lille"]

    app.hide_started.set(True)
    app._apply_view()
    assert app.lbl_count.cget("text") == "2"


def test_sorting_toggles_direction(app):
    app.tips = [tip("A", 70, 1.9), tip("B", 90, 1.5), tip("C", 80, 1.7)]
    app._apply_view()
    t = app.today_table
    t.sort_by("odds")                                                       # číselné sloupce začínají sestupně
    assert [x.odds for x in (t._by_iid[i] for i in t.tree.get_children())] == [1.9, 1.7, 1.5]
    t.sort_by("odds")
    assert [x.odds for x in (t._by_iid[i] for i in t.tree.get_children())] == [1.5, 1.7, 1.9]
    t.sort_by("match")
    assert [x.home for x in (t._by_iid[i] for i in t.tree.get_children())] == ["A", "B", "C"]


def test_failed_refresh_keeps_cached_data_and_shows_warning(app):
    app.db.save_run(ScrapeResult(tips=[tip("Cached", 80, 1.7)], started_at=now_utc(), finished_at=now_utc(),
                                 statuses={SOURCE_SCORES24: SourceStatus(SOURCE_SCORES24, "ok", "")}))
    app._load_cached()
    FakePipeline.result = ScrapeResult(started_at=now_utc(), finished_at=now_utc(), offline=True,
                                       statuses={SOURCE_SCORES24: SourceStatus(SOURCE_SCORES24, "failed", "Nelze se připojit.")},
                                       warnings=["Scores24: Nelze se připojit."])
    app.refresh()
    pump(app, lambda: not app._busy)
    assert [t.home for t in app.today_table.items] == ["Cached"]
    assert "Bez připojení k internetu" in app.banner.cget("text") and "mezipaměti" in app.lbl_updated.cget("text")


def test_history_outcome_buttons(app):
    app.db.save_run(ScrapeResult(tips=[tip("Arsenal", 80, 2.0, hours=-5)], started_at=now_utc(), finished_at=now_utc(),
                                 statuses={SOURCE_SCORES24: SourceStatus(SOURCE_SCORES24, "ok", "")}))
    app._refresh_history()
    app.history_table.tree.selection_set(app.history_table.tree.get_children()[0])
    app._set_outcome(WIN)
    assert app.db.history()[0].outcome == WIN
    assert app.hstats["evaluated"].value == "1" and "výhry 1" in app.hstats["evaluated"].caption
    assert app.hstats["hit"].value == "100 %" and app.hstats["profit"].value == "+1,00"
