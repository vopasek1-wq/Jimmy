"""Scores24 – hlavní zdroj tipů (tip, procenta shody, kurz).

Jak stránka vypadá (ověřeno na živém HTML):

* `/en/predictions/soccer` je vykreslená na serveru. Zápasy jsou v blocích podle lig;
  každý blok má hlavičku s odkazem `/en/soccer/l-<slug>` a počtem zápasů „( 5 )“.
* Prvních pár lig je rozbalených (zápasy rovnou v HTML), ostatní jsou sbalené –
  jejich zápasy se načtou až po kliknutí na hlavičku (proto Selenium).
* Řádek zápasu je odkaz `.../soccer/m-…-prediction`. Číslo vedle času je buď
  „today“/„tomorrow“, „Ended“, nebo MINUTA právě hraného zápasu (ne datum!).
  Datum ve slugu odkazu (m-17-10-2026-…) je datum vzniku tipu, ne zápasu.
* Časy v HTML jsou v UTC. Kurzy jsou desetinné (cookie userOddFormat=EU), jinak
  americké (-143) – převod řeší odds.parse_odds.
* Názvy CSS tříd jsou hashované (sc-z1hstd-14…) a mění se, proto se parser opírá
  o strukturu (odkazy, pořadí textů), ne o třídy.
"""
from __future__ import annotations

import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .. import config
from ..browser import BrowserSession, BrowserUnavailable
from ..http import BlockedError, HttpClient, SourceError
from ..markets import normalize_pick
from ..models import FINISHED, LIVE, SOURCE_SCORES24, UPCOMING, Tip
from ..odds import parse_odds
from ..timeutil import UTC
from .soup import make_soup

log = logging.getLogger(__name__)

_ROW_HREF = re.compile(r"/soccer/m-[^/]+-prediction/?$")
_LEAGUE_HREF = re.compile(r"/soccer/l-([^/?#]+)/?$")
_COUNT = re.compile(r"\(\s*(\d+)\s*\)")
_TIME = re.compile(r"^\d{1,2}:\d{2}$")
_INT = re.compile(r"^\d{1,3}$")

_SKIP_STATUS = {"postponed", "cancelled", "canceled", "suspended", "abandoned", "walkover", "interrupted"}
_FINISHED_STATUS = {"ended", "ft", "finished", "aet", "pen", "after pen."}
_LIVE_STATUS = {"ht", "halftime", "half time", "live", "1h", "2h", "et", "break", "pause", "penalties"}


@dataclass
class Row:
    """Jeden řádek zápasu z hlavní stránky (ještě před filtry)."""
    href: str
    home: str
    away: str
    time_str: str                     # „15:30“ (UTC)
    status_token: str                 # today / tomorrow / Ended / minuta…
    pick_label: str = ""
    percent: float | None = None
    odds: float | None = None
    home_score: int | None = None
    away_score: int | None = None
    league_key: str | None = None     # None = nesledovaná soutěž
    league_text: str = ""

    @property
    def url(self) -> str:
        return config.SCORES24_BASE + self.href


@dataclass
class LeagueBlock:
    country: str
    name: str
    slug: str
    declared_count: int
    rows: list[Row] = field(default_factory=list)

    @property
    def league(self):
        return config.find_league(self.country, self.name, self.slug)


# --- parsování HTML ---------------------------------------------------------------------

def _header_of(a) -> tuple[str, str, str, int] | None:
    """Pokud je odkaz `a` hlavičkou ligového bloku, vrátí (země, liga, slug, počet zápasů).

    Hlavička je malý prvek „Země Liga ( N )“. Odkazy na ligy v menu počet nemají, a protože
    kontrolujeme jen krátký text nejbližšího okolí (ne celé stránky), nelze je zaměnit.
    """
    m = _LEAGUE_HREF.search(a.get("href", ""))
    if not m:
        return None
    for ancestor in (a.parent, a.parent.parent if a.parent is not None else None):
        if ancestor is None:
            continue
        text = ancestor.get_text(" ", strip=True)
        counts = _COUNT.findall(text)
        if len(text) <= 120 and len(counts) == 1:
            name = a.get_text(" ", strip=True)
            strings = list(ancestor.stripped_strings)
            country = strings[0] if strings and strings[0] != name else ""
            return country, name, m.group(1), int(counts[0])
    return None


def parse_page(html: str, now: datetime) -> list[LeagueBlock]:
    """Rozparsuje hlavní stránku na ligové bloky se zápasy."""
    soup = make_soup(html)
    blocks: dict[str, LeagueBlock] = {}
    order: list[str] = []

    for a in soup.find_all("a", href=_LEAGUE_HREF):
        info = _header_of(a)
        if info and info[2] not in blocks:
            blocks[info[2]] = LeagueBlock(*info)
            order.append(info[2])

    for a in soup.find_all("a", href=_ROW_HREF):
        block_slug = _block_slug_of_row(a, blocks)
        if block_slug is None:
            continue
        row = _parse_row(a, now)
        if row is not None:
            league = blocks[block_slug].league
            row.league_key = league.key if league else None
            row.league_text = f"{blocks[block_slug].country} {blocks[block_slug].name}".strip()
            blocks[block_slug].rows.append(row)
    return [blocks[s] for s in order]


def _block_slug_of_row(a, blocks: dict[str, LeagueBlock]) -> str | None:
    """Najde ligový blok řádku: nejbližší předek, který obsahuje hlavičku ligy."""
    node = a.parent
    for _ in range(8):
        if node is None:
            return None
        for link in node.find_all("a", href=_LEAGUE_HREF):
            m = _LEAGUE_HREF.search(link["href"])
            if m and m.group(1) in blocks:
                return m.group(1)
        node = node.parent
    return None


def _parse_row(a, now: datetime) -> Row | None:
    main = a.find("div", recursive=False)
    if main is None:
        return None
    tokens = [" ".join(s.split()) for s in main.stripped_strings]
    if not tokens:
        return None

    # --- čas a stav (první dva texty řádku) ---
    ti = next((i for i, t in enumerate(tokens) if _TIME.match(t)), None)
    if ti is None:
        return None
    time_str = tokens[ti]
    status_token = tokens[ti + 1] if ti + 1 < len(tokens) else ""

    # --- týmy: spolehlivě z alt textu log, jinak z dalších dvou textů ---
    alts = []
    for img in main.find_all("img"):
        alt = (img.get("alt") or "").strip()
        if alt and alt not in alts:
            alts.append(alt)
    if len(alts) >= 2:
        home, away = alts[0], alts[1]
        after_teams = _tokens_after_teams(tokens, ti + 2, home, away)
    elif len(tokens) >= ti + 4:
        home, away = tokens[ti + 2], tokens[ti + 3]
        after_teams = tokens[ti + 4:]
    else:
        return None

    row = Row(href=a["href"], home=home, away=away, time_str=time_str, status_token=status_token)
    _parse_right_part(row, after_teams)
    return row


def _tokens_after_teams(tokens: list[str], start: int, home: str, away: str) -> list[str]:
    """Zbytek řádku za názvy týmů (názvy v textu přeskočíme)."""
    rest = tokens[start:]
    while rest and rest[0] in (home, away):
        rest = rest[1:]
    return rest


def _parse_right_part(row: Row, toks: list[str]) -> None:
    """Pravá část řádku: [procenta] [%] tip, skóre domácích, skóre hostů, kurz.

    Procenta mohou chybět (tip bez shody – takový řádek pak nesplní filtr)
    a znak „%“ se někdy vykresluje jen přes CSS, proto se bere číslo ve struktuře.
    """
    toks = [t for t in toks if t != "%"]
    if not toks:
        return
    odds = parse_odds(toks[-1])
    if odds is not None:
        row.odds, toks = odds, toks[:-1]
    # skóre: dva texty (číslice nebo „-“) těsně před kurzem
    if len(toks) >= 2 and all(re.fullmatch(r"\d{1,2}|-", t) for t in toks[-2:]):
        s1, s2 = toks[-2:]
        row.home_score = int(s1) if s1.isdigit() else None
        row.away_score = int(s2) if s2.isdigit() else None
        toks = toks[:-2]
    # procenta: číslo před popisem tipu
    if toks and _INT.match(toks[0]) and len(toks) >= 2:
        # Scores24 občas ukáže víc než 100 (naměřeno: 101) – je to míra shody, ne pravděpodobnost.
        # Jako procento nad 100 by to bylo nesmysl, proto se omezí na 100.
        row.percent = min(float(toks[0]), 100.0)
        toks = toks[1:]
    row.pick_label = toks[0] if toks else ""


# --- stav a čas zápasu ----------------------------------------------------------------------

def classify_status(token: str) -> str | None:
    """today/tomorrow → UPCOMING, minuta → LIVE, Ended → FINISHED; None = řádek ignorovat."""
    t = token.strip().lower()
    if t in _SKIP_STATUS:
        return None
    if t in ("today", "tomorrow"):
        return UPCOMING
    if t in _FINISHED_STATUS:
        return FINISHED
    if t in _LIVE_STATUS or re.fullmatch(r"\d{1,3}(\+\d+)?'?", t):
        return LIVE
    return None


def kickoff_of(row: Row, now: datetime) -> datetime | None:
    """Začátek zápasu v UTC.

    Z řádku známe jen čas (UTC) a slovo today/tomorrow – datum tedy odvodíme od
    dnešního UTC data. U probíhajících/odehraných zápasů je to „dnes“. Přesný čas
    později upřesní SofaScore (startTimestamp).
    """
    status = classify_status(row.status_token)
    if status is None:
        return None
    hh, mm = (int(x) for x in row.time_str.split(":"))
    day = now.astimezone(UTC).date()
    if row.status_token.strip().lower() == "tomorrow":
        day += timedelta(days=1)
    return datetime(day.year, day.month, day.day, hh, mm, tzinfo=UTC)


def row_to_tip(row: Row, now: datetime) -> Tip | None:
    """Převede řádek na Tip; None, pokud nejde o použitelný tip."""
    if row.league_key is None or row.percent is None or not row.pick_label:
        return None
    kickoff = kickoff_of(row, now)
    if kickoff is None:
        return None
    league = config.league_by_key(row.league_key)
    market = normalize_pick(row.pick_label, row.home, row.away)
    return Tip(
        home=row.home, away=row.away,
        league_key=league.key, league=league.name_cs,
        kickoff_utc=kickoff,
        tip_code=market.code, tip_label=market.label_cs, raw_label=row.pick_label,
        probability=row.percent, odds=row.odds,
        sources=(SOURCE_SCORES24,),
        status=classify_status(row.status_token) or UPCOMING,
        home_score=row.home_score, away_score=row.away_score,
        url=row.url,
    )


# --- scraper ------------------------------------------------------------------------------------

@dataclass
class Scores24Result:
    tips: list[Tip]
    rows: list[Row]                   # všechny řádky sledovaných lig (i bez tipu) – pro párování s Forebetem
    warnings: list[str]


class Scores24Scraper:
    def __init__(self, http: HttpClient, browser: BrowserSession):
        self.http = http
        self.browser = browser

    def fetch(self, now: datetime, progress: Callable[[str], None] = lambda m: None) -> Scores24Result:
        progress("Scores24: stahuji tipy…")
        html = self.http.get_text(config.SCORES24_URL, cookies=config.SCORES24_COOKIES)
        blocks = parse_page(html, now)
        if not blocks:
            raise SourceError("Scores24: na stránce se nepodařilo najít žádné ligy (změnila se struktura webu?).")

        warnings: list[str] = []
        collapsed = [b for b in blocks if b.league and b.declared_count > 0 and not b.rows]
        if collapsed:
            names = ", ".join(b.league.name_cs for b in collapsed)
            progress("Scores24: rozbaluji sbalené ligy…")
            try:
                expanded_html = self._expand(collapsed)
                blocks = self._merge(blocks, parse_page(expanded_html, now))
            except (BrowserUnavailable, BlockedError, SourceError) as exc:
                warnings.append(f"Scores24: sbalené ligy ({names}) nejsou načtené – {exc}")
            still = [b for b in blocks if b.league and b.declared_count > 0 and not b.rows]
            if still and not warnings:
                warnings.append("Scores24: nepodařilo se rozbalit ligy: " + ", ".join(b.league.name_cs for b in still))

        rows = [r for b in blocks if b.league for r in b.rows]
        tips = [t for r in rows if (t := row_to_tip(r, now)) is not None]
        log.info("Scores24: %d řádků ve sledovaných ligách, %d s použitelným tipem", len(rows), len(tips))
        return Scores24Result(tips=tips, rows=rows, warnings=warnings)

    # Rozbalení sbalených lig: v prohlížeči klikneme na jejich hlavičky a vezmeme výsledné HTML.
    def _expand(self, collapsed: list[LeagueBlock]) -> str:
        html = self.browser.load(config.SCORES24_URL, ready=lambda h: "/soccer/l-" in h, wait_s=15)
        drv = self.browser.driver
        self._wait_page_complete(drv)
        for block in collapsed:
            if not self._expand_one(drv, block.slug):
                log.warning("Rozbalení ligy %s se nepodařilo ani na opakovaný pokus", block.slug)
        return drv.page_source or html

    @staticmethod
    def _wait_page_complete(drv, timeout: float = 10.0) -> None:
        """Počká na dokončení načtení; klik dřív než se stránka „oživí“ (React) se ztratí."""
        end = time.monotonic() + timeout
        while time.monotonic() < end and drv.execute_script("return document.readyState") != "complete":
            time.sleep(0.3)
        time.sleep(1.5)

    @staticmethod
    def _expand_one(drv, slug: str, attempts: int = 3) -> bool:
        """Klikne na hlavičku ligy a čeká, až se pod ní objeví zápasy. Element se hledá při každém
        pokusu znovu – React ho po načtení může nahradit (StaleElementReferenceException)."""
        from selenium.webdriver.common.by import By

        for attempt in range(attempts):
            try:
                link = drv.find_element(By.XPATH, f"//a[contains(@href,'/soccer/l-{slug}')]")
                header = link.find_element(By.XPATH, "./ancestor::div[2]")
                block = link.find_element(By.XPATH, "./ancestor::div[3]")
                drv.execute_script("arguments[0].scrollIntoView({block:'center'});", header)
                drv.execute_script("arguments[0].click();", header)
                for _ in range(10):                          # až 5 s na načtení zápasů
                    if block.find_elements(By.XPATH, ".//a[contains(@href,'-prediction')]"):
                        return True
                    time.sleep(0.5)
            except Exception as exc:                         # Selenium hází řadu různých výjimek
                log.info("Rozbalení %s, pokus %d: %s", slug, attempt + 1, str(exc).splitlines()[0][:120])
                time.sleep(1.0)
        return False

    @staticmethod
    def _merge(base: list[LeagueBlock], expanded: list[LeagueBlock]) -> list[LeagueBlock]:
        by_slug = {b.slug: b for b in expanded}
        for b in base:
            if not b.rows and b.slug in by_slug:
                b.rows = by_slug[b.slug].rows
        return base
