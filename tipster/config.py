"""Centrální konfigurace aplikace.

Vše, co by chtěl uživatel ladit (prahy filtrů, seznam lig, adresy zdrojů,
časování požadavků), je na jednom místě. Prahy filtrů ze zadání jsou
konstanty – UI je záměrně nemění.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

APP_TITLE = "Fotbalové tipy"

# --- Cesty ----------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("TIPSTER_DATA_DIR", BASE_DIR / "data"))
DB_PATH = DATA_DIR / "tipy.sqlite3"
LOG_PATH = DATA_DIR / "tipster.log"

# --- Povinné filtry (ze zadání) --------------------------------------------
MIN_PROBABILITY = 60.0   # tip musí mít pravděpodobnost STRIKTNĚ větší než 60 %
MIN_ODDS = 1.50          # a kurz alespoň 1,50
HIGH_PROBABILITY = 75.0  # nad touto hranicí je řádek zelený, jinak žlutý

# Když zdroj kurz neuvádí, odhadneme ho z pravděpodobnosti: férový kurz = 100 / p,
# sázkovka z něj ubere marži. Odhad je v UI vždy označen vlnovkou (~).
ESTIMATED_MARGIN = 0.06

# --- Čas ---------------------------------------------------------------------
DISPLAY_TZ = "Europe/Prague"
# Scores24 vrací v HTML (SSR) časy v UTC bez ohledu na cookie s časovým pásmem.
# Ověřeno proti reálným rozpisům (Bundesliga 13:30 = 15:30 SELČ).
SCORES24_TZ = "UTC"
# Forebet ukazuje čas v GMT; při párování zápasů tolerujeme posun kvůli nejistotě.
FOREBET_TZ = "UTC"

# --- Zdroje ------------------------------------------------------------------
SCORES24_BASE = "https://scores24.live"
SCORES24_URL = SCORES24_BASE + "/en/predictions/soccer"
FOREBET_URL = "https://www.forebet.com/en/football-predictions"
SOFASCORE_API = "https://www.sofascore.com/api/v1"
SOFASCORE_WEB = "https://www.sofascore.com"
TIPSPORT_URL = "https://www.tipsport.cz/kurzy/fotbal"

# Obyčejné preferenční cookie webu Scores24 (stejné, jaké si nastaví uživatel
# v nastavení): desetinné kurzy místo amerických a pražské časové pásmo.
SCORES24_COOKIES = {"userOddFormat": "EU", "userTimezone": "Europe/Prague"}

# --- HTTP --------------------------------------------------------------------
REQUEST_TIMEOUT = (8, 25)          # (spojení, čtení) v sekundách
REQUEST_DELAY = (0.8, 1.6)         # pauza mezi požadavky na stejný server
REQUEST_RETRIES = 2
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# --- Selenium ----------------------------------------------------------------
# Pokud Cloudflare blokuje headless prohlížeč, nastavte proměnnou prostředí
# TIPSTER_VISIBLE_BROWSER=1 – prohlížeč se pak zobrazí a často projde kontrolou.
SELENIUM_HEADLESS = os.environ.get("TIPSTER_VISIBLE_BROWSER", "") not in ("1", "true", "yes")
SELENIUM_CHROME_BINARY = os.environ.get("TIPSTER_CHROME_BINARY", "")
SELENIUM_EXTRA_ARGS = os.environ.get("TIPSTER_CHROME_ARGS", "").split()
FOREBET_BROWSER_WAIT = 15          # kolik sekund čekat na vyřešení kontroly Cloudflare


# --- Ligy ---------------------------------------------------------------------
@dataclass(frozen=True)
class League:
    """Soutěž, kterou aplikace sleduje.

    Rozpoznání probíhá podle slugu odkazu na Scores24 (nejstabilnější),
    případně podle dvojice (země, název ligy) z hlavičky bloku.
    """
    key: str
    name_cs: str
    sofascore_id: int | None
    slug_re: str = ""                    # regex nad slugem za "l-" (např. "england-premier-league")
    country_re: str = ""                 # regex nad názvem země z hlavičky
    name_re: str = ""                    # regex nad názvem ligy z hlavičky
    forebet_tags: tuple[str, ...] = ()   # zkratky ligy na Forebetu (odhad, viz forebet.py)
    enabled: bool = True

    def matches(self, country: str, name: str, slug: str) -> bool:
        if self.slug_re and re.search(self.slug_re, slug, re.I):
            return True
        if self.name_re and re.search(self.name_re, name.strip(), re.I):
            return bool(re.search(self.country_re, country.strip(), re.I)) if self.country_re else True
        return False


_EUROPE = r"^(Europe|International|UEFA|World)?$"

# Výchozí sada: pětka velkých lig, evropské poháry UEFA a pár dalších prvních lig.
# Ligu vypnete nastavením enabled=False, novou přidáte jako další řádek.
LEAGUES: tuple[League, ...] = (
    League("EPL", "Anglie – Premier League", 17,
           slug_re=r"^england-premier-league$", country_re=r"^England$", name_re=r"^Premier League$",
           forebet_tags=("Eng1",)),
    League("LALIGA", "Španělsko – La Liga", 8,
           slug_re=r"^spain-laliga$", country_re=r"^Spain$", name_re=r"^La ?Liga$",
           forebet_tags=("Spa1",)),
    League("SERIEA", "Itálie – Serie A", 23,
           slug_re=r"^italy-serie-a$", country_re=r"^Italy$", name_re=r"^Serie A$",
           forebet_tags=("Ita1",)),
    League("BUNDESLIGA", "Německo – Bundesliga", 35,
           slug_re=r"^germany-bundesliga$", country_re=r"^Germany$", name_re=r"^Bundesliga$",
           forebet_tags=("Ger1",)),
    League("LIGUE1", "Francie – Ligue 1", 34,
           slug_re=r"^france-ligue-1-?$", country_re=r"^France$", name_re=r"^Ligue 1$",
           forebet_tags=("Fra1",)),
    League("UCL", "Liga mistrů UEFA", 7,
           slug_re=r"uefa-champions-league", country_re=_EUROPE, name_re=r"^(UEFA )?Champions League$",
           forebet_tags=("UCL", "CL")),
    League("UEL", "Evropská liga UEFA", 679,
           slug_re=r"uefa-europa-league", country_re=_EUROPE, name_re=r"^(UEFA )?Europa League$",
           forebet_tags=("UEL", "EL")),
    League("UECL", "Konferenční liga UEFA", 17015,
           slug_re=r"uefa-(europa-)?conference-league", country_re=_EUROPE,
           name_re=r"^(UEFA )?(Europa )?Conference League$", forebet_tags=("UECL", "UEC", "ECL")),
    League("EREDIVISIE", "Nizozemsko – Eredivisie", 37,
           slug_re=r"^netherlands-eredivisie$", country_re=r"^Netherlands$", name_re=r"^Eredivisie$",
           forebet_tags=("Ned1",)),
    League("PORTUGAL", "Portugalsko – Liga Portugal", 238,
           slug_re=r"^portugal-primeira-liga$", country_re=r"^Portugal$",
           name_re=r"^(Liga Portugal|Primeira Liga)$", forebet_tags=("Por1",)),
    League("BELGIE", "Belgie – Pro League", 38,
           slug_re=r"^belgium-(pro-league|jupiler-pro-league|first-division-a)$", country_re=r"^Belgium$",
           name_re=r"^(Pro League|Jupiler Pro League|First Division A)$", forebet_tags=("Bel1",)),
    League("TURECKO", "Turecko – Süper Lig", 52,
           slug_re=r"^turkey-super-lig$", country_re=r"^Turkey$", name_re=r"^Super Lig$",
           forebet_tags=("Tur1",)),
    League("SKOTSKO", "Skotsko – Premiership", 36,
           slug_re=r"^scotland-premiership$", country_re=r"^Scotland$", name_re=r"^Premiership$",
           forebet_tags=("Sco1",)),
    League("CESKO", "Česko – 1. liga", 172,
           slug_re=r"^czech-republic-1-liga$", country_re=r"^Czech", name_re=r"^1\.? ?Liga$",
           forebet_tags=("Cze1",)),
)


def find_league(country: str, name: str, slug: str) -> League | None:
    """Vrátí sledovanou (zapnutou) ligu, která odpovídá hlavičce bloku, jinak None."""
    for league in LEAGUES:
        if league.enabled and league.matches(country, name, slug):
            return league
    return None


def league_by_key(key: str) -> League | None:
    return next((lg for lg in LEAGUES if lg.key == key), None)
