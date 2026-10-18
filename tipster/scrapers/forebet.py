"""Forebet – statistické pravděpodobnosti výsledku 1 / X / 2.

!!! UPOZORNĚNÍ: tento modul nebyl ověřen na živém webu !!!
Forebet je chráněn Cloudflare a při vývoji ho nepustil ani skutečný prohlížeč
z datacentrové IP. Parser proto vychází ze známé struktury stránky
(div.rcnt, .homeTeam/.awayTeam, .fprc, .forepr, .haodd, time[datetime]) a je
otestován jen na ručně sestavené ukázce (tests/fixtures/forebet_sample.html).
Kdyby Forebet značky změnil, aplikace to nahlásí („změnila se struktura“)
a ostatní zdroje poběží dál. Parser má záložní cesty, aby přežil drobné změny.

Postup načtení:
  1. obyčejné HTTP (rychlé; Cloudflare ho většinou zastaví),
  2. Selenium s Chrome/Edge – počká na dokončení kontroly „Just a moment…“.
     Když ani to neprojde, zkuste TIPSTER_VISIBLE_BROWSER=1 (viditelné okno prohlížeče).
"""
from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime

from .. import config
from ..browser import BrowserSession
from ..http import BlockedError, HttpClient, SourceError, looks_blocked
from ..odds import parse_odds
from ..timeutil import UTC
from .soup import make_soup

log = logging.getLogger(__name__)


@dataclass
class FbMatch:
    home: str
    away: str
    kickoff: datetime | None
    p1: float
    px: float
    p2: float
    pick: str                                    # „1“, „X“ nebo „2“ – tip Forebetu
    odds: dict[str, float | None] = field(default_factory=dict)   # kurzy na 1 / X / 2, pokud jsou
    league_key: str | None = None
    league_text: str = ""

    @property
    def pick_probability(self) -> float:
        return {"1": self.p1, "X": self.px, "2": self.p2}[self.pick]


# --- parsování ------------------------------------------------------------------------------

def parse_page(html: str) -> list[FbMatch]:
    soup = make_soup(html)
    rows = soup.select("div.rcnt")
    if not rows:
        # záloha: řádek = nejbližší předek bloku s pravděpodobnostmi
        rows = [fp.parent for fp in soup.select(".fprc") if fp.parent is not None]
    matches: list[FbMatch] = []
    for row in rows:
        try:
            m = _parse_row(row)
        except Exception as exc:  # jeden vadný řádek nesmí shodit celý zdroj
            log.debug("Přeskakuji řádek Forebetu: %s", exc)
            continue
        if m is not None:
            matches.append(m)
    return matches


def _text(el) -> str:
    return " ".join(el.get_text(" ", strip=True).split()) if el is not None else ""


def _parse_row(row) -> FbMatch | None:
    home, away = _team_names(row)
    probs = [_to_int(_text(s)) for s in row.select(".fprc span")]
    probs = [p for p in probs if p is not None]
    if not home or not away or len(probs) != 3:
        return None
    p1, px, p2 = (float(p) for p in probs)

    pick = _text(row.select_one(".forepr")).upper()
    if pick not in ("1", "X", "2"):
        pick = ("1", "X", "2")[max(range(3), key=lambda i: (p1, px, p2)[i])]

    odds_vals = [parse_odds(_text(s)) for s in row.select(".haodd span")]
    odds = dict(zip(("1", "X", "2"), odds_vals)) if len(odds_vals) == 3 else {}

    league_text = _league_text(row)
    return FbMatch(home=home, away=away, kickoff=_kickoff(row), p1=p1, px=px, p2=p2,
                   pick=pick, odds=odds, league_key=_league_key(league_text), league_text=league_text)


def _team_names(row) -> tuple[str, str]:
    home, away = _text(row.select_one(".homeTeam")), _text(row.select_one(".awayTeam"))
    if home and away:
        return home, away
    # záloha: odkaz na zápas má v textu/atributu „Domácí - Hosté“
    for el in (row.select_one("a.tnmscn"), row.select_one("meta[itemprop=name]")):
        raw = (el.get("content") or el.get("title") or _text(el)) if el is not None else ""
        parts = re.split(r"\s+(?:-|–|vs\.?)\s+", raw.strip(), maxsplit=1)
        if len(parts) == 2:
            return parts[0].strip(), parts[1].strip()
    return "", ""


def _to_int(text: str) -> int | None:
    m = re.search(r"\d{1,3}", text)
    return int(m.group()) if m else None


def _kickoff(row) -> datetime | None:
    t = row.select_one("time[datetime]")
    raw = t.get("datetime", "") if t is not None else ""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M"):
        try:
            return datetime.strptime(raw.strip(), fmt).replace(tzinfo=UTC)
        except ValueError:
            continue
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2})", _text(row.select_one(".date_bah")))
    if m:
        d, mo, y, hh, mm = (int(x) for x in m.groups())
        return datetime(y, mo, d, hh, mm, tzinfo=UTC)
    return None


def _league_text(row) -> str:
    """Zkratka/název ligy z nejbližší hlavičky nad řádkem (nejistá část – Forebet značky mění)."""
    for sib in row.previous_siblings:
        if getattr(sib, "select_one", None) is None:
            continue
        tag = sib.select_one(".shortTag")
        if tag is not None:
            return _text(tag)
        if sib.select_one(".rcnt"):      # narazili jsme na předchozí zápas bez hlavičky
            continue
    return ""


def _league_key(league_text: str) -> str | None:
    if not league_text:
        return None
    for lg in config.LEAGUES:
        if lg.enabled and league_text.strip() in lg.forebet_tags:
            return lg.key
    return None


# --- scraper -----------------------------------------------------------------------------------

class ForebetScraper:
    def __init__(self, http: HttpClient, browser: BrowserSession):
        self.http = http
        self.browser = browser

    def fetch(self, progress: Callable[[str], None] = lambda m: None) -> list[FbMatch]:
        progress("Forebet: stahuji pravděpodobnosti…")
        matches: list[FbMatch] = []
        try:
            matches = parse_page(self.http.get_text(config.FOREBET_URL))
        except BlockedError:
            log.info("Forebet: HTTP zablokováno, zkouším prohlížeč")
        if matches:
            return matches

        progress("Forebet: zkouším prohlížeč (ochrana Cloudflare)…")
        html = self.browser.load(config.FOREBET_URL, ready=_page_ready, wait_s=config.FOREBET_BROWSER_WAIT)
        if looks_blocked(200, html):
            raise BlockedError(
                "Forebet: Cloudflare kontrola neprošla. Zkuste nastavit TIPSTER_VISIBLE_BROWSER=1 "
                "(viditelné okno prohlížeče). Tipy ze Scores24 se zobrazují i bez Forebetu.")
        matches = parse_page(html)
        if not matches:
            raise SourceError("Forebet: na stránce nejsou rozpoznatelné zápasy (změnila se struktura webu?).")
        return matches


def _page_ready(html: str) -> bool:
    return not looks_blocked(200, html) and ("rcnt" in html or "fprc" in html)
