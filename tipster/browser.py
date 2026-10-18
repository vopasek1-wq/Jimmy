"""Záložní režim: skutečný prohlížeč přes Selenium.

Používá se tam, kde samotné HTTP nestačí:
  * Forebet je za kontrolou Cloudflare,
  * Scores24 načítá zápasy sbalených lig až po kliknutí na hlavičku ligy.

Prohlížeč se spouští líně (až když je potřeba) a sdílí se mezi zdroji.
Ovladač stahuje Selenium Manager sám; stačí nainstalovaný Chrome nebo Edge.
"""
from __future__ import annotations

import logging
import time
from collections.abc import Callable

from . import config

log = logging.getLogger(__name__)


class BrowserUnavailable(Exception):
    """Prohlížeč nelze spustit (chybí Selenium / Chrome / Edge). Text je určen uživateli."""


class BrowserSession:
    def __init__(self, headless: bool = config.SELENIUM_HEADLESS):
        self.headless = headless
        self._driver = None

    # --- životní cyklus ----------------------------------------------------------
    @property
    def driver(self):
        if self._driver is None:
            self._driver = self._start()
        return self._driver

    def _start(self):
        try:
            from selenium import webdriver
        except ImportError as exc:
            raise BrowserUnavailable("Není nainstalován balíček selenium (pip install selenium).") from exc

        args = ["--window-size=1400,1000", "--lang=cs-CZ", "--disable-gpu", "--no-first-run",
                "--disable-dev-shm-usage", f"--user-agent={config.USER_AGENT}", *config.SELENIUM_EXTRA_ARGS]
        if self.headless:
            args.append("--headless=new")

        errors: list[str] = []
        for name in ("Chrome", "Edge"):
            try:
                opts = getattr(webdriver, f"{name}Options")()
                for a in args:
                    opts.add_argument(a)
                opts.add_experimental_option("excludeSwitches", ["enable-automation"])
                if name == "Chrome" and config.SELENIUM_CHROME_BINARY:
                    opts.binary_location = config.SELENIUM_CHROME_BINARY
                driver = getattr(webdriver, name)(options=opts)
                driver.set_page_load_timeout(45)
                log.info("Spuštěn prohlížeč %s (headless=%s)", name, self.headless)
                return driver
            except Exception as exc:  # Selenium hází řadu různých výjimek
                errors.append(f"{name}: {str(exc).splitlines()[0][:160]}")
                log.warning("Start prohlížeče %s selhal: %s", name, exc)
        raise BrowserUnavailable(
            "Nepodařilo se spustit Chrome ani Edge. Nainstalujte Google Chrome. (" + "; ".join(errors) + ")")

    def close(self) -> None:
        if self._driver is not None:
            try:
                self._driver.quit()
            except Exception:  # prohlížeč mohl být zavřen ručně
                pass
            self._driver = None

    def __enter__(self) -> BrowserSession:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # --- načtení stránky ----------------------------------------------------------
    def load(self, url: str, ready: Callable[[str], bool], wait_s: float = 20.0) -> str:
        """Otevře URL a čeká, až `ready(html)` vrátí True (např. zmizí „Just a moment…“).

        Vrací HTML poslední podoby stránky; pokud podmínka do limitu nenastala,
        vrací i tak aktuální HTML a volající rozhodne, co s ním.
        """
        from selenium.common.exceptions import WebDriverException
        drv = self.driver
        try:
            drv.get(url)
        except WebDriverException as exc:
            raise BrowserUnavailable(f"Prohlížeč nedokázal načíst {url}: {str(exc).splitlines()[0][:160]}") from exc
        deadline = time.monotonic() + wait_s
        html = drv.page_source
        while not ready(html) and time.monotonic() < deadline:
            time.sleep(1.0)
            html = drv.page_source
        return html
