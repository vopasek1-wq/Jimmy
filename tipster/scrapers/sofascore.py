"""SofaScore – podrobnosti zápasu: přesný začátek, stav, skóre a odkaz.

Používá se veřejný JSON, který si načítá samotný web SofaScore:
    /api/v1/unique-tournament/<id>/scheduled-events/<YYYY-MM-DD>
Jeden dotaz vrátí zápasy jedné soutěže za (zhruba) jeden den. Parametr data není
čisté UTC datum (okno se překrývá s předchozím/následujícím dnem), proto se
zápasy vždy přiřazují podle názvů týmů a startTimestamp, ne podle data.
Oficiální API to není – kdyby SofaScore endpoint změnil, aplikace dál funguje
a jen ukáže, že tento zdroj je nedostupný.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from .. import config
from ..http import HttpClient, SourceError
from ..models import FINISHED, LIVE, UPCOMING, Tip
from ..names import same_match
from ..timeutil import UTC

log = logging.getLogger(__name__)

_API_HEADERS = {"Accept": "application/json", "Referer": config.SOFASCORE_WEB + "/"}
MATCH_TOLERANCE = timedelta(hours=3)


@dataclass
class SofaEvent:
    id: int
    slug: str
    custom_id: str
    start: datetime
    status: str | None             # UPCOMING / LIVE / FINISHED; None = odložený / zrušený
    cancelled: bool
    home: str
    away: str
    home_score: int | None
    away_score: int | None         # skóre po 90 minutách (u pohárů bez prodloužení)
    minute_text: str = ""

    @property
    def url(self) -> str:
        return f"{config.SOFASCORE_WEB}/cs/football/match/{self.slug}/{self.custom_id}#id:{self.id}"


def parse_events(data: dict) -> list[SofaEvent]:
    out: list[SofaEvent] = []
    for e in data.get("events", []):
        try:
            stype = (e.get("status") or {}).get("type", "")
            cancelled = stype in ("postponed", "canceled", "cancelled")
            status = {"notstarted": UPCOMING, "inprogress": LIVE, "finished": FINISHED}.get(stype)
            hs, as_ = e.get("homeScore") or {}, e.get("awayScore") or {}
            # normaltime = výsledek po 90 min (sázky se vyhodnocují bez prodloužení)
            home_score = hs.get("normaltime", hs.get("current"))
            away_score = as_.get("normaltime", as_.get("current"))
            out.append(SofaEvent(
                id=int(e["id"]), slug=e.get("slug", ""), custom_id=e.get("customId", ""),
                start=datetime.fromtimestamp(int(e["startTimestamp"]), UTC),
                status=status, cancelled=cancelled,
                home=e["homeTeam"]["name"], away=e["awayTeam"]["name"],
                home_score=home_score, away_score=away_score,
                minute_text=(e.get("status") or {}).get("description", ""),
            ))
        except (KeyError, TypeError, ValueError) as exc:
            log.debug("Přeskakuji nečitelnou událost SofaScore: %s", exc)
    return out


class SofaScoreClient:
    def __init__(self, http: HttpClient):
        self.http = http
        self._cache: dict[tuple[int, date], list[SofaEvent]] = {}
        self.errors: list[str] = []
        self.requests_ok = 0

    def events(self, tournament_id: int, day: date) -> list[SofaEvent]:
        key = (tournament_id, day)
        if key not in self._cache:
            url = f"{config.SOFASCORE_API}/unique-tournament/{tournament_id}/scheduled-events/{day.isoformat()}"
            try:
                self._cache[key] = parse_events(self.http.get_json(url, headers=_API_HEADERS))
                self.requests_ok += 1
            except SourceError as exc:
                self.errors.append(str(exc))
                self._cache[key] = []
        return self._cache[key]

    def find(self, tournament_id: int, home: str, away: str, kickoff: datetime) -> SofaEvent | None:
        """Najde zápas podle týmů a času (±3 h od očekávaného začátku)."""
        best, best_score = None, 0.0
        for ev in self.events(tournament_id, kickoff.astimezone(UTC).date()):
            if abs(ev.start - kickoff) > MATCH_TOLERANCE:
                continue
            score = same_match(home, away, ev.home, ev.away)
            if score > best_score:
                best, best_score = ev, score
        return best

    def enrich(self, tips: list[Tip], progress: Callable[[str], None] = lambda m: None) -> list[Tip]:
        """Doplní tipům přesný čas, stav, skóre a odkaz; zrušené/odložené zápasy vyřadí."""
        groups: dict[tuple[int, date], int] = defaultdict(int)
        for t in tips:
            lg = config.league_by_key(t.league_key)
            if lg and lg.sofascore_id:
                groups[(lg.sofascore_id, t.kickoff_utc.date())] += 1
        progress(f"SofaScore: načítám detaily zápasů ({len(groups)} dotazů)…")

        kept: list[Tip] = []
        for t in tips:
            lg = config.league_by_key(t.league_key)
            ev = self.find(lg.sofascore_id, t.home, t.away, t.kickoff_utc) if lg and lg.sofascore_id else None
            if ev is not None:
                if ev.cancelled:
                    log.info("Vyřazuji odložený/zrušený zápas %s", t.match_name)
                    continue
                t.kickoff_utc = ev.start
                t.sofascore_id, t.sofascore_url = ev.id, ev.url
                if ev.status:
                    t.status = ev.status
                if ev.status in (LIVE, FINISHED):
                    t.home_score, t.away_score = ev.home_score, ev.away_score
            kept.append(t)
        return kept
