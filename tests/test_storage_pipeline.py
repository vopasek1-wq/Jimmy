"""Databáze, sloučení zdrojů, celý běh pipeline (se zástupnými scrapery) a vyhodnocení výsledků."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from tests.test_scrapers import FakeHttp, sofa_event
from tipster import pipeline as pl
from tipster.database import Database
from tipster.http import NetworkError, SourceError
from tipster.models import (LOSS, SOURCE_FOREBET, SOURCE_SCORES24, VOID, WIN, ScrapeResult, SourceStatus, Tip)
from tipster.scrapers.forebet import FbMatch
from tipster.scrapers.scores24 import Row, Scores24Result
from tipster.timeutil import now_utc

KO = datetime(2026, 10, 18, 15, 30, tzinfo=timezone.utc)


def mk(home="Nottingham Forest", away="Arsenal", code="2", prob=80.0, odds=1.7, ko=KO, league="EPL", **kw) -> Tip:
    return Tip(home=home, away=away, league_key=league, league="Anglie – Premier League", kickoff_utc=ko, tip_code=code,
               tip_label=f"tip {code}", probability=prob, odds=odds, sources=(SOURCE_SCORES24,), **kw)


def ok_result(tips) -> ScrapeResult:
    return ScrapeResult(tips=tips, started_at=now_utc(), finished_at=now_utc(),
                        statuses={SOURCE_SCORES24: SourceStatus(SOURCE_SCORES24, "ok", "")})


# --- databáze --------------------------------------------------------------------------------------------

@pytest.fixture
def db(tmp_path):
    return Database(tmp_path / "t.sqlite3")


def test_db_roundtrip_and_latest_run_view(db):
    assert db.latest_run() is None and db.tips_of_latest_run() == []
    db.save_run(ok_result([mk(), mk("A", "B", "1", 70, 1.6)]))
    got = db.tips_of_latest_run()
    assert {t.home for t in got} == {"Nottingham Forest", "A"}
    t = next(x for x in got if x.home == "Nottingham Forest")
    assert t.kickoff_utc == KO and t.sources == (SOURCE_SCORES24,) and t.id is not None
    assert db.latest_run().statuses[SOURCE_SCORES24].state == "ok"


def test_db_upsert_updates_but_keeps_manual_outcome(db):
    db.save_run(ok_result([mk(prob=80, odds=1.7)]))
    tid = db.history()[0].id
    db.set_outcome(tid, WIN, "manual")
    db.save_run(ok_result([mk(prob=77, odds=1.65)]))              # totéž znovu s jinými čísly
    hist = db.history()
    assert len(hist) == 1 and hist[0].probability == 77 and hist[0].odds == 1.65
    assert hist[0].outcome == WIN and hist[0].outcome_source == "manual"


def test_db_latest_run_hides_tips_not_seen_again_but_history_keeps_them(db):
    db.save_run(ok_result([mk(), mk("A", "B", "1")]))
    db.save_run(ok_result([mk()]))                                  # druhý tip už zdroj nevrací
    assert len(db.tips_of_latest_run()) == 1 and len(db.history()) == 2


def test_db_set_and_clear_outcome(db):
    db.save_run(ok_result([mk()]))
    tid = db.history()[0].id
    db.set_outcome(tid, LOSS, "manual")
    assert db.history()[0].outcome == LOSS
    db.set_outcome(tid, None)
    h = db.history()[0]
    assert h.outcome is None and h.outcome_source is None


def test_db_stats(db):
    tips = [mk("A", "1", odds=2.0), mk("A", "2", odds=1.5), mk("A", "3", odds=1.8), mk("A", "4", odds=1.6)]
    tips[3].odds_estimated = True
    db.save_run(ok_result(tips))
    by = {t.away: t.id for t in db.history()}
    db.set_outcome(by["1"], WIN); db.set_outcome(by["2"], LOSS); db.set_outcome(by["3"], VOID); db.set_outcome(by["4"], WIN)
    s = db.stats()
    assert (s.total, s.evaluated, s.wins, s.losses, s.voids) == (4, 4, 2, 1, 1)
    assert s.hit_rate == pytest.approx(200 / 3)
    assert s.profit == pytest.approx(1.0 - 1.0)       # +1.0 (kurz 2.0) a −1 (prohra); odhadnutý kurz a push se nepočítají
    assert s.roi_pct == pytest.approx(0.0)


def test_db_pending_results_only_old_unsettled(db):
    old, fresh = mk("Old", "X", ko=now_utc() - timedelta(hours=6)), mk("Fresh", "Y", ko=now_utc() + timedelta(hours=1))
    db.save_run(ok_result([old, fresh]))
    assert [t.home for t in db.pending_results(now_utc() - timedelta(hours=3))] == ["Old"]


# --- sloučení Scores24 + Forebet --------------------------------------------------------------------------------

def fb(home="Nottingham Forest", away="Arsenal", p=(10, 20, 70), pick="2", ko=KO, odds=None, league=None) -> FbMatch:
    return FbMatch(home, away, ko, *map(float, p), pick, odds or {}, league_key=league)


def test_combine_adds_forebet_probability_and_agreement():
    s24 = Scores24Result(tips=[mk(code="2")], rows=[], warnings=[])
    t = pl.combine(s24, [fb(p=(10, 20, 70), pick="2")], KO)[0]
    assert t.prob_forebet == 70 and t.sources == (SOURCE_SCORES24, SOURCE_FOREBET)


def test_combine_forebet_disagreement_keeps_single_source_but_shows_probability():
    s24 = Scores24Result(tips=[mk(code="BTTS")], rows=[], warnings=[])
    t = pl.combine(s24, [fb(p=(10, 20, 70), pick="2")], KO)[0]
    assert t.prob_forebet is None and t.sources == (SOURCE_SCORES24,)          # BTTS Forebet nedává
    s24 = Scores24Result(tips=[mk(code="1X")], rows=[], warnings=[])
    t = pl.combine(s24, [fb(p=(10, 20, 70), pick="2")], KO)[0]
    assert t.prob_forebet == 30 and t.sources == (SOURCE_SCORES24,)            # 1X = 10+20


def test_combine_creates_forebet_only_tip_when_league_known_from_scores24_row():
    row = Row("/en/soccer/m-x-prediction", "Nottingham Forest", "Arsenal FC", "15:30", "today", league_key="EPL")
    s24 = Scores24Result(tips=[], rows=[row], warnings=[])
    tips = pl.combine(s24, [fb(away="Arsenal", p=(10, 20, 70), pick="2", odds={"2": 1.65})], datetime(2026, 10, 18, 12, tzinfo=timezone.utc))
    assert len(tips) == 1
    t = tips[0]
    assert t.sources == (SOURCE_FOREBET,) and t.probability == 70 and t.odds == 1.65
    assert t.away == "Arsenal FC" and t.league_key == "EPL" and t.tip_code == "2"      # názvy ze Scores24


def test_combine_drops_forebet_tip_with_unknown_league_or_low_probability():
    assert pl.combine(Scores24Result([], [], []), [fb(p=(10, 20, 70), pick="2")], KO) == []          # liga neznámá
    assert pl.combine(Scores24Result([], [], []), [fb(p=(30, 30, 40), pick="2", league="EPL")], KO) == []  # 40 % < práh
    exactly = pl.combine(Scores24Result([], [], []), [fb(p=(20, 20, 60), pick="2", league="EPL")], KO)
    assert exactly == []                                                      # přesně 60 % neprojde (striktně >)


def test_combine_forebet_league_mismatch_is_not_merged():
    s24 = Scores24Result(tips=[mk(code="2", league="EPL")], rows=[], warnings=[])
    t = pl.combine(s24, [fb(league="LALIGA")], KO)[0]
    assert t.prob_forebet is None


# --- celý běh se zástupnými scrapery -----------------------------------------------------------------------------------

class StubScores24:
    behaviour = None
    def __init__(self, *a): pass
    def fetch(self, now, progress=lambda m: None):
        if isinstance(self.behaviour, Exception):
            raise self.behaviour
        return self.behaviour


class StubForebet:
    behaviour = None
    def __init__(self, *a): pass
    def fetch(self, progress=lambda m: None):
        if isinstance(self.behaviour, Exception):
            raise self.behaviour
        return self.behaviour


class StubBrowser:
    closed = 0
    def close(self): StubBrowser.closed += 1


@pytest.fixture
def stubbed(monkeypatch):
    monkeypatch.setattr(pl, "Scores24Scraper", StubScores24)
    monkeypatch.setattr(pl, "ForebetScraper", StubForebet)
    http = FakeHttp({"events": [sofa_event(7, "Nottingham Forest", "Arsenal", int(KO.timestamp()), "notstarted")]})
    monkeypatch.setattr(pl, "SofaScoreClient", lambda h: __import__("tipster.scrapers.sofascore", fromlist=["x"]).SofaScoreClient(http))
    StubBrowser.closed = 0
    return pl.Pipeline(http=http, browser=StubBrowser())


def test_pipeline_happy_path_filters_and_enriches(stubbed):
    StubScores24.behaviour = Scores24Result(
        tips=[mk(prob=80, odds=1.7), mk("Low", "Prob", prob=55, odds=1.9), mk("Low", "Odds", prob=85, odds=1.3)], rows=[], warnings=[])
    StubForebet.behaviour = [fb(p=(10, 20, 70), pick="2")]
    r = stubbed.run()
    assert r.success and [t.home for t in r.tips] == ["Nottingham Forest"]          # filtry odstranily dva tipy
    t = r.tips[0]
    assert t.sofascore_id == 7 and t.prob_forebet == 70 and t.sources == (SOURCE_SCORES24, SOURCE_FOREBET)
    assert [s.state for s in r.statuses.values()] == ["ok", "ok", "ok"] and r.warnings == []
    assert StubBrowser.closed == 1                                                    # prohlížeč se vždy zavře


def test_pipeline_forebet_failure_is_not_fatal(stubbed):
    StubScores24.behaviour = Scores24Result(tips=[mk()], rows=[], warnings=[])
    StubForebet.behaviour = SourceError("Forebet: Cloudflare kontrola neprošla.")
    r = stubbed.run()
    assert r.success and len(r.tips) == 1
    assert r.statuses["Forebet"].state == "failed" and any("Cloudflare" in w for w in r.warnings)


def test_pipeline_scores24_partial_warning_is_reported(stubbed):
    StubScores24.behaviour = Scores24Result(tips=[mk()], rows=[], warnings=["Scores24: sbalené ligy (Česko) nejsou načtené."])
    StubForebet.behaviour = []
    r = stubbed.run()
    assert r.success and r.statuses[SOURCE_SCORES24].state == "partial" and any("sbalené" in w for w in r.warnings)


def test_pipeline_offline_skips_other_sources(stubbed):
    StubScores24.behaviour = NetworkError("Nelze se připojit k scores24.live.", offline=True)
    r = stubbed.run()
    assert not r.success and r.offline and r.tips == []
    assert r.statuses["Forebet"].state == "skipped" and r.statuses["SofaScore"].state == "skipped"
    assert StubBrowser.closed == 1


def test_pipeline_unexpected_exception_does_not_crash(stubbed):
    StubScores24.behaviour = ValueError("rozbitý parser")
    r = stubbed.run()
    assert not r.success and "rozbitý parser" in r.statuses[SOURCE_SCORES24].message


def test_pipeline_sofascore_down_still_returns_tips(stubbed, monkeypatch):
    from tipster.scrapers import sofascore
    StubScores24.behaviour = Scores24Result(tips=[mk()], rows=[], warnings=[])
    StubForebet.behaviour = []
    monkeypatch.setattr(pl, "SofaScoreClient", lambda h: sofascore.SofaScoreClient(FakeHttp(error=SourceError("HTTP 403"))))
    r = stubbed.run()
    assert r.success and len(r.tips) == 1 and r.statuses["SofaScore"].state == "failed"


# --- automatické vyhodnocení --------------------------------------------------------------------------------------------------

def test_update_results_settles_only_finished_known_markets(db):
    ko = now_utc() - timedelta(hours=5)
    ts = int(ko.timestamp())
    tips = [mk("Nottingham Forest", "Arsenal", "2", ko=ko), mk("Chelsea", "Everton", "BTTS", ko=ko),
            mk("Fulham", "Hull City", "O2.5", ko=ko), mk("Leeds", "Villa", "OTHER:corners", ko=ko), mk("Brentford", "Spurs", "1", ko=ko)]
    db.save_run(ok_result(tips))
    http = FakeHttp({"events": [
        sofa_event(1, "Nottingham Forest", "Arsenal", ts, "finished", 0, 2),
        sofa_event(2, "Chelsea", "Everton", ts, "finished", 1, 0),
        sofa_event(3, "Fulham", "Hull City", ts, "inprogress", 1, 1),          # ještě se hraje
        sofa_event(4, "Leeds", "Villa", ts, "finished", 1, 1),
    ]})
    done, msg = pl.update_results(db, http=http)
    by = {t.home: t for t in db.history()}
    assert done == 2
    assert by["Nottingham Forest"].outcome == WIN and by["Nottingham Forest"].outcome_source == "auto"
    assert by["Chelsea"].outcome == LOSS                                       # BTTS při 1:0 prohrává
    assert by["Fulham"].outcome is None and by["Leeds"].outcome is None and by["Brentford"].outcome is None
    assert "Vyhodnoceno 2" in msg


def test_update_results_never_overwrites_manual_outcome(db):
    ko = now_utc() - timedelta(hours=5)
    db.save_run(ok_result([mk("Nottingham Forest", "Arsenal", "2", ko=ko)]))
    db.set_outcome(db.history()[0].id, LOSS, "manual")
    http = FakeHttp({"events": [sofa_event(1, "Nottingham Forest", "Arsenal", int(ko.timestamp()), "finished", 0, 2)]})
    done, _ = pl.update_results(db, http=http)
    assert done == 0 and db.history()[0].outcome == LOSS


def test_update_results_reports_unavailable_sofascore(db):
    ko = now_utc() - timedelta(hours=5)
    db.save_run(ok_result([mk(ko=ko)]))
    done, msg = pl.update_results(db, http=FakeHttp(error=SourceError("HTTP 403")))
    assert done == 0 and "nedostupný" in msg
