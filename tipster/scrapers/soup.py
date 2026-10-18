"""Pomocná továrna na BeautifulSoup – použije rychlý lxml, a když chybí, vestavěný parser."""
from __future__ import annotations

from bs4 import BeautifulSoup

try:
    import lxml  # noqa: F401
    _PARSER = "lxml"
except ImportError:  # lxml se nepodařilo nainstalovat – pomalejší, ale funkční záloha
    _PARSER = "html.parser"


def make_soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, _PARSER)
