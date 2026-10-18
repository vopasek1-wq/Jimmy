"""Čisté funkce: kurzy, trhy, vyhodnocení, názvy týmů, povinné filtry."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from tipster import config
from tipster.filters import HIGH, MID, apply_filters, passes_filters, probability_class
from tipster.markets import evaluate, forebet_probability, normalize_pick
from tipster.models import LOSS, VOID, WIN, Tip
from tipster.names import normalize, same_match, team_similarity
from tipster.odds import estimate_odds, fmt_odds, parse_odds


# --- kurzy -------------------------------------------------------------------------------------

@pytest.mark.parametrize("text, expected", [
    ("1.85", 1.85), ("1,85", 1.85), ("2", 2.0),
    ("-143", 1.70), ("-118", 1.85), ("-213", 1.47), ("+150", 2.5), ("150", 2.5), ("−147", 1.68),
    ("5/4", 2.25), ("1/2", 1.5),
    ("-", None), ("", None), (None, None), ("abc", None), ("1.00", None), ("0.5", None), ("-50", None),
])
def test_parse_odds(text, expected):
    assert parse_odds(text) == expected


def test_estimate_odds_is_cautious_and_validated():
    # férový kurz pro 70 % je 1,43; s marží 6 % ~1,34
    assert estimate_odds(70) == pytest.approx(1.34, abs=0.01)
    assert estimate_odds(0) is None and estimate_odds(100) is None and estimate_odds(-5) is None


def test_fmt_odds():
    assert fmt_odds(1.7) == "1.70" and fmt_odds(1.6, True) == "~1.60" and fmt_odds(None) == "–"


# --- trhy ----------------------------------------------------------------------------------------

H, A = "Nottingham Forest", "Arsenal"


@pytest.mark.parametrize("label, code", [
    ("Arsenal to Win", "2"), ("Nottingham Forest to Win", "1"), ("Draw", "X"),
    ("Both Teams to Score –  (Yes)", "BTTS"), ("Both Teams to Score – (No)", "NOBTTS"),
    ("Total goals Over (2,5)", "O2.5"), ("Total goals Under (3,5)", "U3.5"), ("Total goals Over (3)", "O3"),
    ("Total goals Over (2,25)", "O2.25"),
    ("Nottingham Forest Total goals Over (1,5)", "HO1.5"), ("Arsenal Total goals Under (0,5)", "AU0.5"),
    ("Arsenal Handicap (0)", "AH2:0"), ("Arsenal Handicap (+1,5)", "AH2:+1.5"),
    ("Nottingham Forest Handicap (-1)", "AH1:-1"),
    ("Arsenal will not lose", "X2"), ("Nottingham Forest or Draw", "1X"), ("Draw or Arsenal", "X2"),
    ("Nottingham Forest or Arsenal", "12"),
])
def test_normalize_pick_known_markets(label, code):
    assert normalize_pick(label, H, A).code == code


def test_normalize_pick_unknown_is_kept_not_dropped():
    m = normalize_pick("Total corners Over (9,5)", H, A)
    assert m.code.startswith("OTHER:") and "corners" in m.label_cs


def test_normalize_pick_czech_labels():
    assert normalize_pick("Total goals Over (2,5)", H, A).label_cs == "Over 2,5 gólu"
    assert normalize_pick("Arsenal to Win", H, A).label_cs == "2 – výhra Arsenal"
    assert "bez remízy" in normalize_pick("Arsenal Handicap (0)", H, A).label_cs


def test_normalize_pick_team_name_with_prefix_overlap():
    # „Real Madrid“ je prefix „Real Madrid Castilla“: musí vyhrát delší název
    assert normalize_pick("Real Madrid Castilla to Win", "Real Madrid", "Real Madrid Castilla").code == "2"


@pytest.mark.parametrize("code, hg, ag, expected", [
    ("1", 2, 1, WIN), ("1", 1, 1, LOSS), ("X", 1, 1, WIN), ("2", 0, 1, WIN),
    ("1X", 1, 1, WIN), ("1X", 0, 1, LOSS), ("X2", 1, 1, WIN), ("12", 1, 1, LOSS), ("12", 2, 1, WIN),
    ("BTTS", 1, 1, WIN), ("BTTS", 2, 0, LOSS), ("NOBTTS", 2, 0, WIN),
    ("O2.5", 2, 1, WIN), ("O2.5", 1, 1, LOSS), ("U2.5", 1, 1, WIN), ("U2.5", 2, 1, LOSS),
    ("O3", 2, 1, VOID), ("U3", 2, 1, VOID), ("O3", 3, 1, WIN),            # celočíselná linie → push
    ("HO1.5", 2, 0, WIN), ("HO1.5", 1, 3, LOSS), ("AU0.5", 3, 0, WIN), ("AO1.5", 0, 2, WIN),
    ("AH2:0", 1, 1, VOID), ("AH2:0", 0, 1, WIN), ("AH2:0", 1, 0, LOSS),
    ("AH2:+1.5", 0, 1, WIN), ("AH2:+1.5", 1, 0, WIN), ("AH2:+1.5", 2, 0, LOSS), ("AH1:-1", 2, 1, VOID), ("AH1:-1", 3, 1, WIN),
    ("O2.25", 3, 0, None), ("AH1:+0.75", 0, 1, None), ("OTHER:corners", 1, 1, None),   # neumíme → ručně
])
def test_evaluate(code, hg, ag, expected):
    assert evaluate(code, hg, ag) == expected


def test_forebet_probability():
    assert forebet_probability("1", 50, 30, 20) == 50
    assert forebet_probability("1X", 50, 30, 20) == 80
    assert forebet_probability("X2", 50, 30, 20) == 50
    assert forebet_probability("12", 50, 30, 20) == 70
    assert forebet_probability("BTTS", 50, 30, 20) is None


# --- názvy týmů ---------------------------------------------------------------------------------------

@pytest.mark.parametrize("a, b", [
    ("Brighton & Hove Albion", "Brighton"), ("Tottenham Hotspur", "Tottenham"), ("Coventry", "Coventry City"),
    ("Como 1907", "Como"), ("Udinese Calcio", "Udinese"), ("1. FC Köln", "FC Koln"), ("Manchester Utd", "Manchester United"),
    ("Inter", "Internazionale"), ("Racing", "Racing Santander"), ("Bayern Munich", "Bayern Munchen"),
])
def test_similar_names(a, b):
    assert team_similarity(a, b) >= 0.85


@pytest.mark.parametrize("a, b", [("Manchester City", "Manchester United"), ("Real Madrid", "Real Sociedad"), ("Arsenal", "Everton"),
                              ("Manchester United", "Newcastle United"), ("Real Madrid", "Atletico Madrid")])
def test_different_names(a, b):
    assert team_similarity(a, b) < 0.6


def test_same_match_is_orientation_sensitive():
    assert same_match("Arsenal", "Chelsea", "Arsenal FC", "Chelsea FC") > 0.9
    assert same_match("Arsenal", "Chelsea", "Chelsea", "Arsenal") == 0.0
    assert normalize("  Atlético  Madrid ") == "atletico"


# --- povinné filtry ----------------------------------------------------------------------------------------

def mk(prob=70.0, odds=1.60, league="EPL", estimated=False) -> Tip:
    return Tip(home="A", away="B", league_key=league, league="Liga", kickoff_utc=datetime(2026, 10, 18, 15, 30, tzinfo=timezone.utc),
               tip_code="1", tip_label="1", probability=prob, odds=odds, odds_estimated=estimated)


def test_probability_must_be_strictly_above_60():
    assert not passes_filters(mk(prob=60.0))
    assert passes_filters(mk(prob=60.1))
    assert not passes_filters(mk(prob=59.9))


def test_min_odds_is_inclusive():
    assert passes_filters(mk(odds=1.50))
    assert not passes_filters(mk(odds=1.49))


def test_league_whitelist_enforced():
    assert not passes_filters(mk(league="MLS"))
    assert not passes_filters(mk(league="NEEXISTUJE"))


def test_missing_odds_are_estimated_and_marked(monkeypatch):
    t = mk(prob=62.0, odds=None)           # 100/62*0.94 = 1.52 → projde jako odhad
    out = apply_filters([t])
    assert out == [t] and t.odds_estimated and t.odds >= config.MIN_ODDS
    high = mk(prob=85.0, odds=None)        # odhad 1.11 < 1.50 → vyřazen
    assert apply_filters([high]) == []


def test_apply_filters_mixed():
    tips = [mk(80, 1.7), mk(59, 2.5), mk(75, 1.2), mk(61, 1.5)]
    assert [(t.probability, t.odds) for t in apply_filters(tips)] == [(80, 1.7), (61, 1.5)]


def test_probability_class_bands():
    assert probability_class(75.0) == MID       # 60–75 % včetně 75 = žlutá
    assert probability_class(75.1) == HIGH
    assert probability_class(60.1) == MID
