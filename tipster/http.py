"""HTTP klient: slušné hlavičky, pauzy mezi požadavky, opakování a rozpoznání blokace.

Chyby mají česká uživatelská hlášení – zobrazují se přímo ve stavovém řádku aplikace.
"""
from __future__ import annotations

import logging
import random
import re
import time
from urllib.parse import urlparse

import requests

from . import config

log = logging.getLogger(__name__)


class SourceError(Exception):
    """Zdroj se nepodařilo načíst; text výjimky je určen uživateli."""


class NetworkError(SourceError):
    """Není spojení / server neodpovídá. `offline=True` značí, že nejspíš chybí internet."""

    def __init__(self, message: str, offline: bool = False):
        super().__init__(message)
        self.offline = offline


class BlockedError(SourceError):
    """Server nás pustil jen ke kontrole robota (Cloudflare, CAPTCHA, 403/429)."""


_BLOCK_TITLE = re.compile(r"<title>\s*(just a moment|attention required|access denied|are you a robot)", re.I)
_BLOCK_BODY = ("cf-browser-verification", "cf-chl-", "challenges.cloudflare.com/turnstile")


def looks_blocked(status: int, text: str) -> bool:
    """True, pokud odpověď není skutečný obsah, ale stránka kontroly robota."""
    head = text[:4000]
    if _BLOCK_TITLE.search(head):
        return True
    if status in (403, 429, 503):
        low = text[:20000].lower()
        return any(marker in low for marker in _BLOCK_BODY) or status in (403, 429)
    return False


class HttpClient:
    def __init__(self, delay: tuple[float, float] = config.REQUEST_DELAY):
        self.delay = delay
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": config.USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
            "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
        })
        self._last_request: dict[str, float] = {}

    def _wait_turn(self, host: str) -> None:
        """Mezi dvěma požadavky na stejný server počká náhodnou dobu – nezatěžujeme ho."""
        last = self._last_request.get(host)
        if last is not None:
            wanted = random.uniform(*self.delay)
            remaining = wanted - (time.monotonic() - last)
            if remaining > 0:
                time.sleep(remaining)
        self._last_request[host] = time.monotonic()

    def get(self, url: str, *, params: dict | None = None, headers: dict | None = None,
            cookies: dict | None = None) -> requests.Response:
        host = urlparse(url).netloc
        last_exc: Exception | None = None
        for attempt in range(config.REQUEST_RETRIES + 1):
            self._wait_turn(host)
            try:
                resp = self.session.get(url, params=params, headers=headers, cookies=cookies,
                                        timeout=config.REQUEST_TIMEOUT)
            except requests.exceptions.ConnectionError as exc:
                last_exc = exc
                log.warning("Spojení s %s selhalo (pokus %d): %s", host, attempt + 1, exc)
            except requests.exceptions.Timeout as exc:
                last_exc = exc
                log.warning("Časový limit u %s (pokus %d)", host, attempt + 1)
            except requests.exceptions.RequestException as exc:
                raise NetworkError(f"Chyba požadavku na {host}: {exc}") from exc
            else:
                if looks_blocked(resp.status_code, resp.text):
                    raise BlockedError(f"{host} požaduje ověření (ochrana proti robotům, HTTP {resp.status_code}).")
                if resp.status_code >= 500:
                    last_exc = SourceError(f"{host} vrací chybu serveru (HTTP {resp.status_code}).")
                    log.warning("%s", last_exc)
                elif resp.status_code >= 400:
                    raise SourceError(f"{host} vrací HTTP {resp.status_code} pro {urlparse(url).path}.")
                else:
                    return resp
            if attempt < config.REQUEST_RETRIES:
                time.sleep(1.5 * (attempt + 1))

        if isinstance(last_exc, requests.exceptions.ConnectionError):
            raise NetworkError(f"Nelze se připojit k {host}. Zkontrolujte připojení k internetu.",
                               offline=True) from last_exc
        if isinstance(last_exc, requests.exceptions.Timeout):
            raise NetworkError(f"{host} neodpovídá (vypršel časový limit).") from last_exc
        raise last_exc if isinstance(last_exc, SourceError) else NetworkError(str(last_exc))

    def get_text(self, url: str, **kw) -> str:
        resp = self.get(url, **kw)
        return resp.content.decode(resp.encoding if resp.encoding and resp.encoding.lower() != "iso-8859-1"
                                   else "utf-8", errors="replace")

    def get_json(self, url: str, **kw) -> dict:
        resp = self.get(url, **kw)
        try:
            return resp.json()
        except ValueError as exc:
            raise SourceError(f"{urlparse(url).netloc} nevrátil platná data (JSON).") from exc
