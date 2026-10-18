"""Párování názvů týmů mezi zdroji („Brighton & Hove Albion“ vs. „Brighton“)."""
from __future__ import annotations

import difflib
import re
import unicodedata

# Zkratky a předpony, které nenesou informaci o klubu.
_NOISE = {
    "fc", "cf", "sc", "ac", "as", "afc", "ssc", "us", "rc", "rcd", "fk", "sk", "cd", "ud",
    "sv", "vfb", "vfl", "tsg", "fsv", "calcio", "club", "de", "the", "ii",
}

# Ustálené odlišnosti, které se podobností řetězců nechytí.
_ALIASES = {
    "manchester utd": "manchester united",
    "man united": "manchester united",
    "man utd": "manchester united",
    "man city": "manchester city",
    "spurs": "tottenham hotspur",
    "tottenham": "tottenham hotspur",
    "wolves": "wolverhampton wanderers",
    "newcastle": "newcastle united",
    "internazionale": "inter",
    "inter milan": "inter",
    "atletico madrid": "atletico",
    "athletic club": "athletic bilbao",
    "borussia monchengladbach": "monchengladbach",
    "gladbach": "monchengladbach",
    "psg": "paris saint germain",
    "paris sg": "paris saint germain",
    "olympique marseille": "marseille",
    "olympique lyon": "lyon",
    "olympique lyonnais": "lyon",
    "sparta prague": "sparta praha",
    "slavia prague": "slavia praha",
}


def _strip_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def normalize(name: str) -> str:
    """Malá písmena, bez diakritiky a interpunkce, bez bezvýznamných zkratek (FC, CF…)."""
    s = _strip_accents(name).lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    tokens = [t for t in s.split() if t not in _NOISE]
    s = " ".join(tokens)
    return _ALIASES.get(s, s)


def team_similarity(a: str, b: str) -> float:
    """Podobnost dvou názvů týmů 0–1."""
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ta, tb = set(na.split()), set(nb.split())
    small, big = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    # „Brighton“ ⊂ „Brighton and Hove Albion“; krátké zbytky typu „al“ ale neberem.
    if small <= big and sum(len(t) for t in small) >= 4:
        return 0.92
    if _differ_only_by_distinct_word(na.split(), nb.split()):
        return 0.5                 # „Manchester City“ ≠ „Manchester United“, „Real Madrid“ ≠ „Real Sociedad“
    return difflib.SequenceMatcher(None, na, nb).ratio()


def _differ_only_by_distinct_word(a: list[str], b: list[str]) -> bool:
    """Dva víceslovné názvy sdílí první (nebo poslední) slovo, ale zbytek je jiný klub."""
    if len(a) < 2 or len(b) < 2:
        return False
    for head_a, head_b, rest_a, rest_b in ((a[0], b[0], a[1:], b[1:]), (a[-1], b[-1], a[:-1], b[:-1])):
        if head_a == head_b and difflib.SequenceMatcher(None, " ".join(rest_a), " ".join(rest_b)).ratio() < 0.6:
            return True
    return False


def same_match(home_a: str, away_a: str, home_b: str, away_b: str) -> float:
    """Skóre 0–1, že jde o týž zápas (domácí vs. domácí, hosté vs. hosté).

    Vrací 0, pokud některý z týmů nesedí aspoň z 60 %; jinak průměr obou podobností.
    Pořadí týmů se záměrně neprohazuje – zrcadlový zápas je jiný zápas.
    """
    h = team_similarity(home_a, home_b)
    a = team_similarity(away_a, away_b)
    if h < 0.6 or a < 0.6:
        return 0.0
    return (h + a) / 2
