"""Typy tipů: převod textů ze Scores24 na kanonické kódy, české popisky a vyhodnocení.

Kanonické kódy (řetězce, aby šly snadno do databáze):

    1  X  2          výsledek zápasu (domácí / remíza / hosté)
    1X  X2  12       dvojitá šance
    O2.5  U3         celkový počet gólů – více / méně než linie
    BTTS  NOBTTS     oba týmy skórují – ano / ne
    HO1.5  AU0.5     góly jednoho týmu (H = domácí, A = hosté; O = over, U = under)
    AH1:+1.5  AH2:0  handicap týmu 1/2 (linie 0 = sázka bez remízy)
    OTHER:<text>     trh, který neumíme interpretovat (zobrazí se původní text)
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .models import LOSS, VOID, WIN


@dataclass(frozen=True)
class Market:
    code: str
    label_cs: str


def _line(text: str) -> float | None:
    """„2,5“ → 2.5 (Scores24 píše desetinnou čárku)."""
    try:
        return float(text.replace(",", ".").replace("+", ""))
    except ValueError:
        return None


def _num_cs(x: float) -> str:
    """2.5 → „2,5“, 3.0 → „3“."""
    return f"{x:g}".replace(".", ",")


def _signed(x: float) -> str:
    return "0" if x == 0 else f"{x:+g}"


# --- normalizace textu ze Scores24 ----------------------------------------------

_BTTS = re.compile(r"both teams to score\s*[–-]?\s*\(?\s*(yes|no)\s*\)?", re.I)
_TOTAL = re.compile(r"^total goals\s+(over|under)\s*\(\s*([\d.,]+)\s*\)$", re.I)
_HANDICAP = re.compile(r"^handicap\s*\(\s*([+-]?[\d.,]+)\s*\)$", re.I)


def normalize_pick(label: str, home: str, away: str) -> Market:
    """Přeloží anglický popis tipu ze Scores24 na (kód, český popisek).

    Příklady vstupů: „Arsenal to Win“, „Both Teams to Score – (Yes)“,
    „Total goals Over (2,5)“, „Brighton Total goals Under (1,5)“, „Como 1907 Handicap (+1,5)“.
    Neznámý trh nezahazujeme – vrátí se jako OTHER s původním textem.
    """
    text = re.sub(r"\s+", " ", label).strip()
    other = Market(f"OTHER:{text}", text)
    if not text:
        return other

    if (m := _BTTS.fullmatch(text)):
        return (Market("BTTS", "Oba týmy dají gól – ano") if m.group(1).lower() == "yes"
                else Market("NOBTTS", "Oba týmy dají gól – ne"))

    if (m := _TOTAL.match(text)):
        return _total_market(m.group(1), m.group(2), None, home, away) or other

    if re.fullmatch(r"draw", text, re.I):
        return Market("X", "X – remíza")

    # „Cagliari will not lose“
    if (m := re.fullmatch(r"(.+?)\s+(?:will not lose|not to lose)", text, re.I)):
        side = _side_of(m.group(1), home, away)
        if side:
            return _double_chance(side, home, away)

    # „Draw or Arsenal“
    if (m := re.fullmatch(r"draw or (.+)", text, re.I)):
        side = _side_of(m.group(1), home, away)
        if side:
            return _double_chance(side, home, away)

    # „Arsenal or Draw“ / „Arsenal to Win or Draw“ / „Arsenal or Tottenham“
    if (m := re.fullmatch(r"(.+?)\s+(?:to win\s+)?or\s+(.+)", text, re.I)):
        left, right = _side_of(m.group(1), home, away), m.group(2).strip()
        if left and right.lower() == "draw":
            return _double_chance(left, home, away)
        if left and _side_of(right, home, away) and left != _side_of(right, home, away):
            return Market("12", "12 – nebude remíza")

    # Všechno ostatní začíná názvem týmu: „<tým> to Win“, „<tým> Total goals…“, „<tým> Handicap…“
    side, rest = _split_team(text, home, away)
    if side and rest:
        if re.fullmatch(r"to win", rest, re.I):
            team = home if side == "1" else away
            return Market(side, f"{side} – výhra {team}")
        if (m := _TOTAL.match(rest)):
            return _total_market(m.group(1), m.group(2), side, home, away) or other
        if (m := _HANDICAP.match(rest)):
            h = _line(m.group(1))
            if h is not None:
                team = home if side == "1" else away
                if h == 0:
                    return Market(f"AH{side}:0", f"{team}: bez remízy")
                return Market(f"AH{side}:{_signed(h)}", f"{team}: handicap {_signed(h).replace('.', ',')}")
    return other


def _split_team(text: str, home: str, away: str) -> tuple[str | None, str]:
    """Odtrhne od textu název domácích/hostů; vrátí ('1'|'2', zbytek)."""
    for name, side in sorted(((home, "1"), (away, "2")), key=lambda p: -len(p[0])):
        if name and text.lower().startswith(name.lower()):
            return side, text[len(name):].strip()
    return None, text


def _side_of(name: str, home: str, away: str) -> str | None:
    name = name.strip().lower()
    if name == home.strip().lower():
        return "1"
    if name == away.strip().lower():
        return "2"
    return None


def _double_chance(side: str, home: str, away: str) -> Market:
    if side == "1":
        return Market("1X", f"1X – {home} neprohraje")
    return Market("X2", f"X2 – {away} neprohraje")


def _total_market(direction: str, line_text: str, side: str | None, home: str, away: str) -> Market | None:
    line = _line(line_text)
    if line is None:
        return None
    over = direction.lower() == "over"
    word = "over" if over else "under"
    if side is None:
        return Market(f"{'O' if over else 'U'}{line:g}", f"{word.capitalize()} {_num_cs(line)} gólu")
    prefix = ("H" if side == "1" else "A") + ("O" if over else "U")
    team = home if side == "1" else away
    return Market(f"{prefix}{line:g}", f"{team}: {word} {_num_cs(line)} gólu")


def result_market(code: str, home: str, away: str) -> Market:
    """Popisek pro trhy 1 / X / 2 (používá ho Forebet, který dává jen výsledek zápasu)."""
    if code == "1":
        return Market("1", f"1 – výhra {home}")
    if code == "2":
        return Market("2", f"2 – výhra {away}")
    return Market("X", "X – remíza")


# --- pravděpodobnost z Forebetu -------------------------------------------------

def forebet_probability(code: str, p1: float, px: float, p2: float) -> float | None:
    """Pravděpodobnost trhu z rozdělení 1/X/2; pro ostatní trhy None (Forebet je zde nedává)."""
    return {"1": p1, "X": px, "2": p2, "1X": p1 + px, "X2": px + p2, "12": p1 + p2}.get(code)


# --- vyhodnocení tipu podle výsledku ----------------------------------------------

_TOTAL_CODE = re.compile(r"^([HA]?)([OU])(\d+(?:\.\d+)?)$")
_AH_CODE = re.compile(r"^AH([12]):([+-]?\d+(?:\.\d+)?)$")


def evaluate(code: str, home_goals: int, away_goals: int) -> str | None:
    """Vrátí WIN / LOSS / VOID, nebo None, když trh neumíme automaticky vyhodnotit.

    Čtvrtinové linie (2,25; +0,75) se vyhodnocují půl na půl, takže je raději
    nechávám ručně (None). Pro poháry se počítá výsledek po 90 minutách – ten dodá volající.
    """
    hg, ag = home_goals, away_goals
    simple = {
        "1": hg > ag, "X": hg == ag, "2": hg < ag,
        "1X": hg >= ag, "X2": hg <= ag, "12": hg != ag,
        "BTTS": hg > 0 and ag > 0, "NOBTTS": not (hg > 0 and ag > 0),
    }
    if code in simple:
        return WIN if simple[code] else LOSS

    if (m := _TOTAL_CODE.match(code)):
        who, direction, line = m.group(1), m.group(2), float(m.group(3))
        goals = {"": hg + ag, "H": hg, "A": ag}[who]
        return _vs_line(goals - line, over=direction == "O", line=line)

    if (m := _AH_CODE.match(code)):
        h = float(m.group(2))
        mine, theirs = (hg, ag) if m.group(1) == "1" else (ag, hg)
        if (h * 2) % 1:          # čtvrtinový handicap
            return None
        diff = mine + h - theirs
        return WIN if diff > 0 else VOID if diff == 0 else LOSS
    return None


def _vs_line(diff: float, over: bool, line: float) -> str | None:
    if (line * 2) % 1:           # čtvrtinová linie
        return None
    if diff == 0:
        return VOID              # celočíselná linie, přesně na ní → vrácená sázka
    return WIN if (diff > 0) == over else LOSS
