"""Parsery Scores24 / Forebet / SofaScore na ukázkových datech ve struktuře živých webů."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from tests.html_builders import forebet_page, forebet_row, s24_block, s24_page, s24_row
from tipster.models import FINISHED, LIVE, UPCOMING
from tipster.scrapers import forebet, scores24, sofascore

NOW = datetime(2026, 10, 18, 13, 30, tzinfo=timezone.utc)


def page_with_epl(rows):
    return s24_page([s24_block("England", "Premier League", "england-premier-league", len(rows), rows)])


# --- Scores24 ------------------------------------------------------------------------------------------

def test_scores24_blocks_leagues_and_menu_links_ignored():
    html = s24_page([
        s24_block("England", "Premier League", "england-premier-league", 1, [s24_row("Arsenal", "Chelsea")]),
        s24_block("USA", "MLS", "usa-major-league-soccer", 8, [s24_row("A", "B", slug="a-b2")]),
        s24_block("Czech Republic", "1 Liga", "czech-republic-1-liga", 3),          # sbalený blok
    ])
    blocks = scores24.parse_page(html, NOW)
    assert [b.slug for b in blocks] == ["england-premier-league", "usa-major-league-soccer", "czech-republic-1-liga"]
    assert [b.league.key if b.league else None for b in blocks] == ["EPL", None, "CESKO"]
    assert [len(b.rows) for b in blocks] == [1, 1, 0]
    assert blocks[2].declared_count == 3 and not blocks[2].rows          # → scraper ví, že ho má rozbalit
    assert blocks[0].country == "England" and blocks[0].name == "Premier League"


def test_scores24_row_fields_and_percent_without_percent_sign():
    row = s24_row("Real Madrid", "Sevilla", time="19:00", status="today", pick="Both Teams to Score –  (Yes)",
                  percent="94", odds="1.85", pct_sign=False)
    r = scores24.parse_page(page_with_epl([row]), NOW)[0].rows[0]
    assert (r.home, r.away, r.time_str, r.status_token) == ("Real Madrid", "Sevilla", "19:00", "today")
    assert r.percent == 94.0 and r.odds == 1.85 and "Both Teams to Score" in r.pick_label
    assert r.url == "https://scores24.live/en/soccer/m-17-10-2026-a-b-prediction"


def test_scores24_row_without_percent_is_not_a_tip():
    r = scores24.parse_page(page_with_epl([s24_row("Spurs", "Coventry", percent=None, status="tomorrow")]), NOW)[0].rows[0]
    assert r.percent is None and r.odds == 1.71
    assert scores24.row_to_tip(r, NOW) is None


def test_scores24_american_odds_converted():
    r = scores24.parse_page(page_with_epl([s24_row("A", "B", odds="-143")]), NOW)[0].rows[0]
    assert r.odds == 1.70


def test_scores24_live_score_and_minute_is_not_a_date():
    r = scores24.parse_page(page_with_epl([s24_row("A", "B", time="13:00", status="21", score=("1", "0"))]), NOW)[0].rows[0]
    assert (r.home_score, r.away_score) == (1, 0)
    t = scores24.row_to_tip(r, NOW)
    assert t.status == LIVE and t.kickoff_utc == datetime(2026, 10, 18, 13, 0, tzinfo=timezone.utc)


def test_scores24_percent_above_100_is_capped():
    """Živě naměřeno: Scores24 ukázal u zápasu „101“ – jako procento by to byl nesmysl."""
    r = scores24.parse_page(page_with_epl([s24_row("A", "B", percent="101")]), NOW)[0].rows[0]
    assert r.percent == 100.0
    assert scores24.row_to_tip(r, NOW).probability == 100.0


@pytest.mark.parametrize("token, status", [("today", UPCOMING), ("tomorrow", UPCOMING), ("Ended", FINISHED),
                                           ("45", LIVE), ("90+3", LIVE), ("Halftime", LIVE), ("Postponed", None), ("???", None)])
def test_scores24_status_tokens(token, status):
    assert scores24.classify_status(token) == status


def test_scores24_kickoff_today_tomorrow_are_utc_dates():
    today = scores24.Row("/x", "A", "B", "15:30", "today")
    tomorrow = scores24.Row("/x", "A", "B", "19:00", "tomorrow")
    assert scores24.kickoff_of(today, NOW) == datetime(2026, 10, 18, 15, 30, tzinfo=timezone.utc)
    assert scores24.kickoff_of(tomorrow, NOW) == datetime(2026, 10, 19, 19, 0, tzinfo=timezone.utc)


def test_scores24_tip_conversion_for_tracked_league_only():
    mls = s24_block("USA", "MLS", "usa-major-league-soccer", 1, [s24_row("A", "B", pick="Total goals Over (2,5)")])
    epl = s24_block("England", "Premier League", "england-premier-league", 1, [s24_row("Arsenal", "Chelsea", pick="Arsenal to Win")])
    blocks = scores24.parse_page(s24_page([mls, epl]), NOW)
    rows = [r for b in blocks for r in b.rows]
    tips = [scores24.row_to_tip(r, NOW) for r in rows]
    assert tips[0] is None                                  # MLS není ve sledovaných ligách
    assert tips[1].tip_code == "1" and tips[1].league_key == "EPL" and tips[1].probability == 86.0


def test_scores24_parser_survives_unknown_markup():
    assert scores24.parse_page("<html><body><p>nic</p></body></html>", NOW) == []


# --- Forebet ------------------------------------------------------------------------------------------------

def test_forebet_parse_rows():
    html = forebet_page([forebet_row("Arsenal", "Chelsea", (62, 22, 16), "1"),
                         forebet_row("Everton", "Fulham", (30, 31, 39), "2", odds=None)])
    ms = forebet.parse_page(html)
    assert len(ms) == 2
    a = ms[0]
    assert (a.home, a.away, a.p1, a.px, a.p2, a.pick) == ("Arsenal", "Chelsea", 62.0, 22.0, 16.0, "1")
    assert a.kickoff == datetime(2026, 10, 18, 15, 30, tzinfo=timezone.utc)
    assert a.odds == {"1": 1.85, "X": 3.4, "2": 4.2} and a.pick_probability == 62.0
    assert a.league_key is None or a.league_key == "EPL"
    assert ms[1].odds == {}


def test_forebet_pick_falls_back_to_most_probable():
    ms = forebet.parse_page(forebet_page([forebet_row("A", "B", (20, 25, 55), "?")]))
    assert ms[0].pick == "2"


def test_forebet_skips_broken_rows_and_unknown_pages():
    ok = forebet_row("A", "B", (50, 30, 20), "1")
    broken = '<div class="rcnt"><span class="homeTeam">X</span></div>'
    assert len(forebet.parse_page(forebet_page([broken, ok]))) == 1
    assert forebet.parse_page("<html></html>") == []


def test_forebet_blocked_page_detected():
    from tipster.http import looks_blocked
    assert looks_blocked(403, "<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body>")
    assert looks_blocked(200, "<!DOCTYPE html><html><head><title>Just a moment...</title>")
    assert not looks_blocked(200, "<html><head><title>Football predictions</title></head></html>")


# --- SofaScore --------------------------------------------------------------------------------------------------

def sofa_event(id_, home, away, ts, stype="notstarted", hs=None, as_=None, normal=None):
    def score(cur, nt):
        return {} if cur is None else {"current": cur, **({"normaltime": nt} if nt is not None else {})}
    return {"id": id_, "slug": f"{home}-{away}".lower().replace(" ", "-"), "customId": "abc", "startTimestamp": ts,
            "status": {"type": stype, "description": "x"}, "homeTeam": {"name": home}, "awayTeam": {"name": away},
            "homeScore": score(hs, normal if normal is not None else hs), "awayScore": score(as_, normal if normal is not None else as_)}


TS = int(datetime(2026, 10, 18, 15, 30, tzinfo=timezone.utc).timestamp())


def test_sofascore_parse_events_statuses_and_normaltime():
    data = {"events": [
        sofa_event(1, "A", "B", TS),
        sofa_event(2, "C", "D", TS, "inprogress", 1, 0),
        sofa_event(3, "E", "F", TS, "finished", 3, 3),
        sofa_event(4, "G", "H", TS, "postponed"),
        {"broken": True},
    ]}
    evs = sofascore.parse_events(data)
    assert [e.status for e in evs] == [UPCOMING, LIVE, FINISHED, None]
    assert evs[3].cancelled and not evs[0].cancelled
    assert (evs[2].home_score, evs[2].away_score) == (3, 3)
    assert evs[0].url.endswith("/abc#id:1") and "/cs/football/match/" in evs[0].url


def test_sofascore_extra_time_uses_regular_time_score():
    ev = sofa_event(9, "A", "B", TS, "finished", 3, 2)
    ev["homeScore"].update(normaltime=1, current=3)
    ev["awayScore"].update(normaltime=1, current=2)
    e = sofascore.parse_events({"events": [ev]})[0]
    assert (e.home_score, e.away_score) == (1, 1)


class FakeHttp:
    def __init__(self, payload=None, error=None):
        self.payload, self.error, self.calls = payload, error, []

    def get_json(self, url, **kw):
        self.calls.append(url)
        if self.error:
            raise self.error
        return self.payload


def _tip(home="Nottingham Forest", away="Arsenal", ts=TS):
    from tipster.models import Tip
    return Tip(home=home, away=away, league_key="EPL", league="x", kickoff_utc=datetime.fromtimestamp(ts, timezone.utc),
               tip_code="2", tip_label="2", probability=80, odds=1.7)


def test_sofascore_enrich_sets_time_status_score_and_caches_requests():
    http = FakeHttp({"events": [sofa_event(7, "Nottingham Forest", "Arsenal", TS + 300, "inprogress", 0, 1),
                                sofa_event(8, "Other", "Team", TS)]})
    client = sofascore.SofaScoreClient(http)
    t1, t2 = _tip(), _tip("Nottingham Forest", "Arsenal")
    out = client.enrich([t1, t2])
    assert out == [t1, t2] and t1.status == LIVE and (t1.home_score, t1.away_score) == (0, 1)
    assert t1.kickoff_utc.timestamp() == TS + 300 and t1.sofascore_id == 7
    assert len(http.calls) == 1                               # stejná liga + den = jeden dotaz
    assert "unique-tournament/17/scheduled-events/2026-10-18" in http.calls[0]


def test_sofascore_enrich_drops_postponed_and_ignores_far_events():
    http = FakeHttp({"events": [sofa_event(1, "Nottingham Forest", "Arsenal", TS, "postponed"),
                                sofa_event(2, "Chelsea", "Everton", TS)]})
    kept = sofascore.SofaScoreClient(http).enrich([_tip(), _tip("Chelsea", "Everton", TS + 8 * 3600)])
    assert [t.home for t in kept] == ["Chelsea"]              # druhý zápas je o 8 h dál → nepřiřazen, ale zůstává
    assert kept[0].sofascore_id is None


def test_sofascore_failure_is_not_fatal():
    from tipster.http import SourceError
    client = sofascore.SofaScoreClient(FakeHttp(error=SourceError("HTTP 403")))
    t = _tip()
    assert client.enrich([t]) == [t] and client.requests_ok == 0 and client.errors == ["HTTP 403"]
