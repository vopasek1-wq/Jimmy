"""Grafické rozhraní (Tkinter / ttk) ve stejném design systému jako „Value Bet Kalkulačka“.

Rozvržení kopíruje kalkulačku: hlavička s kickerem, nadpisem a perexem pod dvoupixelovou
linkou, pás číselných ukazatelů, sekce s akcentní horní linkou a písmenem, vpravo boční
karty (detail tipu v „verdict“ kartě, rozložení, stav zdrojů). Barvy a písma jsou v theme.py,
světlý i tmavý režim se přepíná tlačítkem v hlavičce.

Stahování běží ve vedlejším vlákně a s oknem komunikuje přes frontu (`queue`),
takže se okno během načítání nezasekne. Tk se z vedlejšího vlákna nikdy nevolá.
"""
from __future__ import annotations

import logging
import queue
import sys
import threading
import tkinter as tk
import webbrowser
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from tkinter import font as tkfont
from tkinter import messagebox, ttk
from typing import Any

from . import config
from .database import Database
from .filters import HIGH, probability_class
from .models import FINISHED, LIVE, LOSS, OUTCOME_LABELS, VOID, WIN, ScrapeResult, SourceStatus, Tip
from .odds import fmt_odds
from .pipeline import Pipeline, update_results
from .theme import (BODY_FONTS, DISPLAY_FONTS, MONO_FONTS, PALETTES, Palette, load_theme_choice, pick_family,
                    resolve_palette, save_theme_choice)
from .timeutil import fmt_kickoff, fmt_stamp, local_date, now_utc, to_local, today_local

log = logging.getLogger(__name__)

STATE_ICON = {"ok": "✓", "partial": "◐", "failed": "✕", "skipped": "–", "pending": "…"}
SIDEBAR_W = 340
_WEEKDAYS = ("pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota", "neděle")


@dataclass
class Fonts:
    """Písma systému: display (nadpisy), body (text), mono (čísla a popisky)."""
    title: tkfont.Font
    letter: tkfont.Font
    head: tkfont.Font
    body: tkfont.Font
    bold: tkfont.Font
    small: tkfont.Font
    caps: tkfont.Font
    mono: tkfont.Font
    stat: tkfont.Font
    families: tuple[str, str, str]

    @classmethod
    def create(cls, root: tk.Misc) -> Fonts:
        avail = set(tkfont.families(root))
        display = pick_family(DISPLAY_FONTS, avail)
        body = pick_family(BODY_FONTS, avail)
        mono = pick_family(MONO_FONTS, avail)
        for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
            tkfont.nametofont(name, root).configure(family=body, size=10)

        def mk(family: str, size: int, weight: str = "normal") -> tkfont.Font:
            return tkfont.Font(root=root, family=family, size=size, weight=weight)

        return cls(title=mk(display, 26), letter=mk(display, 20), head=mk(display, 15), body=mk(body, 10),
                   bold=mk(body, 10, "bold"), small=mk(body, 9), caps=mk(mono, 8, "bold"), mono=mk(mono, 10),
                   stat=mk(mono, 19), families=(display, body, mono))


# --- drobné stavební prvky ----------------------------------------------------------------------

def _label(parent, text="", *, font, fg, bg, **kw) -> tk.Label:
    kw.setdefault("anchor", "w")
    return tk.Label(parent, text=text, font=font, fg=fg, bg=bg, **kw)


def _wrap_to_width(label: tk.Label, margin: int = 0, initial: int = SIDEBAR_W - 70) -> None:
    """Dlouhý text štítku se zalomí podle jeho aktuální šířky (Tk to samo neumí).

    `initial` platí dřív, než je štítek poprvé vykreslen – bez něj by si řekl o šířku celého
    textu a roztáhl by celý sloupec, ve kterém leží."""
    label.configure(wraplength=initial)
    label.bind("<Configure>", lambda e: label.configure(wraplength=max(120, label.winfo_width() - margin)))


def _hrule(parent, color: str, height: int = 1) -> tk.Frame:
    return tk.Frame(parent, height=height, bg=color)


class ScrollFrame(tk.Frame):
    """Svisle rolovatelný panel; posuvník se ukáže jen tehdy, když obsah nevejde (boční karty)."""

    def __init__(self, master, bg: str, width: int):
        super().__init__(master, bg=bg)
        self.canvas = tk.Canvas(self, bg=bg, highlightthickness=0, width=width)
        self.vsb = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=self.vsb.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        self.inner = tk.Frame(self.canvas, bg=bg)
        self._win = self.canvas.create_window(0, 0, window=self.inner, anchor="nw")
        self.inner.bind("<Configure>", lambda e: self._sync())
        self.canvas.bind("<Configure>", self._on_canvas)
        self.bind("<Enter>", self._bind_wheel)
        self.bind("<Leave>", self._unbind_wheel)

    def _on_canvas(self, event) -> None:
        self.canvas.itemconfigure(self._win, width=event.width)
        self._sync()

    def _sync(self) -> None:
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))
        if self.inner.winfo_reqheight() > self.canvas.winfo_height() > 1:
            if not self.vsb.winfo_ismapped():
                self.vsb.pack(side="right", fill="y")
        else:
            self.vsb.pack_forget()
            self.canvas.yview_moveto(0)

    def _bind_wheel(self, _e=None) -> None:
        self.canvas.bind_all("<MouseWheel>", self._wheel)                       # Windows, macOS
        self.canvas.bind_all("<Button-4>", lambda e: self._scroll(-1))           # Linux
        self.canvas.bind_all("<Button-5>", lambda e: self._scroll(1))

    def _unbind_wheel(self, _e=None) -> None:
        for seq in ("<MouseWheel>", "<Button-4>", "<Button-5>"):
            self.canvas.unbind_all(seq)

    def _wheel(self, event) -> None:
        self._scroll(-1 if event.delta > 0 else 1)

    def _scroll(self, step: int) -> None:
        if self.vsb.winfo_ismapped():
            self.canvas.yview_scroll(step * 2, "units")


class Card(tk.Frame):
    """Karta z kalkulačky: bílá plocha, 1px linka, volitelně 3px akcentní horní linka (sekce `.sec`)."""

    def __init__(self, master, pal: Palette, fonts: Fonts, *, letter: str = "", title: str = "", note: str = "",
                 accent_top: bool = True, pad: tuple[int, int] = (16, 14)):
        super().__init__(master, bg=pal.surface, highlightthickness=1, highlightbackground=pal.rule,
                         highlightcolor=pal.rule)
        if accent_top:
            tk.Frame(self, height=3, bg=pal.accent).pack(fill="x")
        inner = tk.Frame(self, bg=pal.surface)
        inner.pack(fill="both", expand=True, padx=pad[0], pady=(pad[1] - 2, pad[1]))
        if title:
            head = tk.Frame(inner, bg=pal.surface)
            head.pack(fill="x")
            if accent_top:           # sekce: písmeno + nadpis + poznámka vpravo
                if letter:
                    _label(head, letter, font=fonts.letter, fg=pal.accent, bg=pal.surface).pack(side="left", padx=(0, 10))
                _label(head, title, font=fonts.bold, fg=pal.ink, bg=pal.surface).pack(side="left")
                if note:
                    _label(head, note.upper(), font=fonts.caps, fg=pal.ink_soft, bg=pal.surface).pack(side="right")
                _hrule(inner, pal.rule).pack(fill="x", pady=(8, 12))
            else:                    # karta: mono kapitálky `.card-title`
                _label(head, title.upper(), font=fonts.caps, fg=pal.ink_soft, bg=pal.surface).pack(side="left")
        self.body = tk.Frame(inner, bg=pal.surface)
        self.body.pack(fill="both", expand=True, pady=(0 if accent_top else 8, 0))


class Stat(tk.Frame):
    """Číselný ukazatel (hodnota v mono písmu, pod ní popisek) – jako `.lambda` v kalkulačce."""

    def __init__(self, master, pal: Palette, fonts: Fonts, caption: str, value: str = "–"):
        super().__init__(master, bg=pal.ground)
        self._pal = pal
        self._value = _label(self, value, font=fonts.stat, fg=pal.ink, bg=pal.ground)
        self._value.pack(anchor="w")
        self._caption = _label(self, caption, font=fonts.small, fg=pal.ink_soft, bg=pal.ground)
        self._caption.pack(anchor="w")

    def set(self, value: str, caption: str | None = None, color: str | None = None) -> None:
        self._value.configure(text=value, fg=color or self._pal.ink)
        if caption is not None:
            self._caption.configure(text=caption)

    @property
    def value(self) -> str:
        return self._value.cget("text")

    @property
    def caption(self) -> str:
        return self._caption.cget("text")


class SegBar(tk.Canvas):
    """Vodorovný pruh rozdělený na segmenty úměrně počtům (`.bar` / `.seg` z kalkulačky)."""

    def __init__(self, master, pal: Palette, fonts: Fonts, height: int = 26):
        super().__init__(master, width=10, height=height, bg=pal.ground, highlightthickness=0)
        self._pal, self._font, self._h = pal, fonts.mono, height
        self._parts: list[tuple[int, str, str]] = []
        self.bind("<Configure>", lambda e: self._draw())

    def set(self, parts: list[tuple[int, str, str]]) -> None:
        """parts = [(počet, barva výplně, barva textu), …]"""
        self._parts = parts
        self._draw()

    def _draw(self) -> None:
        self.delete("all")
        w = max(self.winfo_width(), 10)
        shown = [p for p in self._parts if p[0] > 0]
        total = sum(p[0] for p in shown)
        if not total:
            self.create_rectangle(0, 0, w, self._h, fill=self._pal.sunk, outline=self._pal.sunk)
            self.create_text(w / 2, self._h / 2, text="–", fill=self._pal.ink_faint, font=self._font)
            return
        gap, x = 2, 0.0
        avail = w - gap * (len(shown) - 1)
        for count, fill, fg in shown:
            seg = avail * count / total
            self.create_rectangle(x, 0, x + seg, self._h, fill=fill, outline=fill)
            if seg >= 30:
                self.create_text(x + seg / 2, self._h / 2, text=str(count), fill=fg, font=self._font)
            x += seg + gap


class Legend(tk.Frame):
    def __init__(self, master, pal: Palette, fonts: Fonts, items: list[tuple[str, str]], bg: str | None = None):
        bg = bg or pal.surface
        super().__init__(master, bg=bg)
        for color, text in items:
            tk.Frame(self, width=10, height=10, bg=color, highlightthickness=1,
                     highlightbackground=pal.rule_strong).pack(side="left", padx=(0, 5))
            _label(self, text, font=fonts.small, fg=pal.ink_soft, bg=bg).pack(side="left", padx=(0, 14))


class VerdictCard(tk.Frame):
    """Karta s detailem vybraného tipu (`.verdict`: barevný levý okraj, mono stav, nadpis v display písmu)."""

    def __init__(self, master, app: App):
        pal, fonts = app.pal, app.fonts
        super().__init__(master, bg=pal.surface, highlightthickness=1, highlightbackground=pal.rule,
                         highlightcolor=pal.rule)
        self.app, self.pal, self.fonts = app, pal, fonts
        self.strip = tk.Frame(self, width=5, bg=pal.rule_strong)
        self.strip.pack(side="left", fill="y")
        self.inner = tk.Frame(self, bg=pal.surface)
        self.inner.pack(side="left", fill="both", expand=True, padx=16, pady=14)
        self.state = _label(self.inner, "", font=fonts.caps, fg=pal.ink_soft, bg=pal.surface)
        self.state.pack(anchor="w")
        self.head = _label(self.inner, "", font=fonts.head, fg=pal.ink, bg=pal.surface, justify="left")
        self.head.pack(anchor="w", fill="x", pady=(4, 0))
        _wrap_to_width(self.head)
        self.sub = _label(self.inner, "", font=fonts.small, fg=pal.ink_soft, bg=pal.surface, justify="left")
        self.sub.pack(anchor="w", fill="x", pady=(2, 0))
        _wrap_to_width(self.sub)
        self.rows = tk.Frame(self.inner, bg=pal.surface)
        self.rows.pack(fill="x", pady=(10, 0))
        self.actions = tk.Frame(self.inner, bg=pal.surface)
        self.actions.pack(fill="x", pady=(12, 0))
        self.show(None)

    def _set_tone(self, tone: str | None) -> None:
        pal = self.pal
        strip, bg, fg = {"pos": (pal.pos, pal.pos_soft, pal.pos), "warn": (pal.warn, pal.warn_soft, pal.warn),
                         None: (pal.rule_strong, pal.surface, pal.ink_soft)}[tone]
        for w in (self, self.inner, self.head, self.sub, self.rows, self.actions, self.state):
            w.configure(bg=bg)
        self.strip.configure(bg=strip)
        self.state.configure(fg=fg)
        self.configure(highlightbackground=pal.rule)
        self._bg = bg

    def show(self, tip: Tip | None) -> None:
        for frame in (self.rows, self.actions):
            for child in frame.winfo_children():
                child.destroy()
        pal, fonts = self.pal, self.fonts
        if tip is None:
            self._set_tone(None)
            self.state.configure(text="DETAIL TIPU")
            self.head.configure(text="Vyberte tip v tabulce")
            self.sub.configure(text="Dvojklik na řádek otevře zápas na Scores24, pravé tlačítko nabídne další akce.")
            return
        high = probability_class(tip.probability) == HIGH
        self._set_tone("pos" if high else "warn")
        self.state.configure(text=("VYSOKÁ PRAVDĚPODOBNOST" if high else "STŘEDNÍ PRAVDĚPODOBNOST"))
        self.head.configure(text=tip.tip_label)
        self.sub.configure(text=f"{tip.match_name} · {tip.league}")
        implied = f"{100 / tip.odds:.1f} %".replace(".", ",") if tip.odds else "–"
        facts = [
            ("Začátek", fmt_kickoff(tip.kickoff_utc)),
            ("Pravděpodobnost", f"{tip.probability:.0f} %"),
            ("Kurz", _cz(fmt_odds(tip.odds, tip.odds_estimated)) + ("  (odhad)" if tip.odds_estimated else "")),
            ("Kurz implikuje", implied),
            ("Forebet", forebet_text(tip)),
        ]
        for i, (k, v) in enumerate(facts):
            _label(self.rows, k, font=fonts.small, fg=pal.ink_soft, bg=self._bg).grid(row=i, column=0, sticky="w", padx=(0, 14))
            _label(self.rows, v, font=fonts.mono, fg=pal.ink, bg=self._bg).grid(row=i, column=1, sticky="w")
        for col, (text, cmd) in enumerate((("Scores24", lambda: self.app._open(tip, "scores24")),
                                           ("SofaScore", lambda: self.app._open(tip, "sofascore")),
                                           ("Tipsport", lambda: self.app._copy_and_open_tipsport(tip)))):
            self.actions.columnconfigure(col, weight=1, uniform="act")
            ttk.Button(self.actions, text=text, style="Compact.TButton", command=cmd).grid(
                row=0, column=col, sticky="ew", padx=(0 if col == 0 else 6, 0))


class Column:
    def __init__(self, id: str, title: str, width: int, text: Callable[[Any], str],
                 sort_key: Callable[[Any], Any], anchor: str = "w", stretch: bool = False):
        self.id, self.title, self.width, self.text = id, title, width, text
        self.sort_key, self.anchor, self.stretch = sort_key, anchor, stretch


class SortableTable(tk.Frame):
    """Treeview se seznamem objektů; kliknutí na záhlaví řadí, druhé kliknutí obrací pořadí."""

    def __init__(self, master, pal: Palette, fonts: Fonts, columns: list[Column],
                 row_tags: Callable[[Any], tuple[str, ...]], default_sort: str, descending: bool = True):
        super().__init__(master, bg=pal.surface, highlightthickness=1, highlightbackground=pal.rule)
        self.columns = {c.id: c for c in columns}
        self.row_tags = row_tags
        self.items: list[Any] = []
        self._by_iid: dict[str, Any] = {}
        self._sort_id, self._desc = default_sort, descending

        self.tree = ttk.Treeview(self, columns=[c.id for c in columns], show="headings", selectmode="browse")
        for c in columns:
            self.tree.column(c.id, width=c.width, anchor=c.anchor, stretch=c.stretch, minwidth=48)
            self.tree.heading(c.id, text=c.title.upper(), command=lambda cid=c.id: self.sort_by(cid))
        vsb = ttk.Scrollbar(self, orient="vertical", command=self.tree.yview)
        hsb = ttk.Scrollbar(self, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=lambda a, b: self._autohide(vsb, a, b),
                            xscrollcommand=lambda a, b: self._autohide(hsb, a, b))
        self.tree.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky="ns")
        hsb.grid(row=1, column=0, sticky="ew")
        self.rowconfigure(0, weight=1)
        self.columnconfigure(0, weight=1)
        self.placeholder = tk.Label(self.tree, text="", bg=pal.surface, fg=pal.ink_soft, font=fonts.body)

    @staticmethod
    def _autohide(bar: ttk.Scrollbar, first: str, last: str) -> None:
        """Posuvník se ukáže jen tehdy, když obsah nevejde."""
        bar.set(first, last)
        if float(first) <= 0.0 and float(last) >= 1.0:
            bar.grid_remove()
        else:
            bar.grid()

    def set_items(self, items: list[Any], empty_text: str = "") -> None:
        self.items = list(items)
        self._render()
        if self.items or not empty_text:
            self.placeholder.place_forget()
        else:
            self.placeholder.configure(text=empty_text)
            self.placeholder.place(relx=0.5, rely=0.4, anchor="center")

    def sort_by(self, column_id: str) -> None:
        if column_id == self._sort_id:
            self._desc = not self._desc
        else:
            self._sort_id, self._desc = column_id, column_id in ("prob", "odds")   # čísla od největšího
        self._render()

    def selected(self) -> Any | None:
        sel = self.tree.selection()
        return self._by_iid.get(sel[0]) if sel else None

    def _render(self) -> None:
        selected = self.selected()
        col = self.columns[self._sort_id]
        ordered = sorted(self.items, key=col.sort_key, reverse=self._desc)
        self.tree.delete(*self.tree.get_children())
        self._by_iid = {}
        for i, item in enumerate(ordered):
            iid = str(i)
            self._by_iid[iid] = item
            self.tree.insert("", "end", iid=iid, values=[c.text(item) for c in self.columns.values()],
                             tags=self.row_tags(item))
            if item is selected:
                self.tree.selection_set(iid)
        for c in self.columns.values():
            arrow = (" ▼" if self._desc else " ▲") if c.id == self._sort_id else ""
            self.tree.heading(c.id, text=c.title.upper() + arrow)


# --- formátování buněk ----------------------------------------------------------------------------------

def _cz(text: str) -> str:
    """Desetinná čárka jako v kalkulačce (cs-CZ)."""
    return text.replace(".", ",")


def status_text(t: Tip) -> str:
    started = t.kickoff_utc <= now_utc()
    score = f" {t.home_score}:{t.away_score}" if t.home_score is not None and t.away_score is not None else ""
    if t.status == FINISHED:
        return f"Skončil{score}"
    if t.status == LIVE:
        return f"Živě{score}"
    return "Zahájen?" if started else "Před zápasem"


def is_started(t: Tip) -> bool:
    return t.status in (LIVE, FINISHED) or t.kickoff_utc <= now_utc()


def league_short(t: Tip) -> str:
    lg = config.league_by_key(t.league_key)
    return (lg.short if lg and lg.short else t.league)


def forebet_text(t: Tip) -> str:
    return f"{t.prob_forebet:.0f} %" if t.prob_forebet is not None else "–"


TODAY_COLUMNS = [
    Column("time", "Začátek", 104, lambda t: fmt_kickoff(t.kickoff_utc), lambda t: t.kickoff_utc),
    Column("match", "Zápas", 180, lambda t: t.match_name, lambda t: t.match_name.casefold(), stretch=True),
    Column("league", "Soutěž", 112, league_short, lambda t: league_short(t).casefold()),
    Column("tip", "Tip", 170, lambda t: t.tip_label, lambda t: t.tip_label.casefold(), stretch=True),
    Column("prob", "Pravděp.", 62, lambda t: f"{t.probability:.0f} %", lambda t: t.probability, "center"),
    Column("odds", "Kurz*", 50, lambda t: _cz(fmt_odds(t.odds, t.odds_estimated)), lambda t: t.odds or 0, "center"),
    Column("fb", "Forebet", 64, forebet_text, lambda t: t.prob_forebet if t.prob_forebet is not None else -1, "center"),
    Column("source", "Zdroj", 112, lambda t: t.source_label, lambda t: t.source_label),
    Column("status", "Stav", 106, status_text, lambda t: (is_started(t), t.kickoff_utc)),
]


def today_row_tags(t: Tip) -> tuple[str, ...]:
    tags = ["high" if probability_class(t.probability) == HIGH else "mid"]
    if t.status == FINISHED:
        tags.append("finished")
    elif is_started(t):
        tags.append("live")
    return tuple(tags)


HISTORY_COLUMNS = [
    Column("date", "Datum", 112, lambda t: fmt_kickoff(t.kickoff_utc), lambda t: t.kickoff_utc),
    Column("match", "Zápas", 215, lambda t: t.match_name, lambda t: t.match_name.casefold(), stretch=True),
    Column("league", "Soutěž", 125, league_short, lambda t: league_short(t).casefold()),
    Column("tip", "Tip", 200, lambda t: t.tip_label, lambda t: t.tip_label.casefold(), stretch=True),
    Column("prob", "Pravděp.", 78, lambda t: f"{t.probability:.0f} %", lambda t: t.probability, "center"),
    Column("odds", "Kurz*", 66, lambda t: _cz(fmt_odds(t.odds, t.odds_estimated)), lambda t: t.odds or 0, "center"),
    Column("score", "Skóre", 64, lambda t: (f"{t.home_score}:{t.away_score}"
                                           if t.home_score is not None and t.away_score is not None else "–"),
           lambda t: (t.home_score or 0) + (t.away_score or 0), "center"),
    Column("source", "Zdroj", 130, lambda t: t.source_label, lambda t: t.source_label),
    Column("outcome", "Výsledek", 105,
           lambda t: OUTCOME_LABELS.get(t.outcome, "—") + (" (auto)" if t.outcome_source == "auto" else ""),
           lambda t: t.outcome or "", "center"),
]


def history_row_tags(t: Tip) -> tuple[str, ...]:
    return {WIN: ("win",), LOSS: ("loss",), VOID: ("void",)}.get(t.outcome, ())


def _long_date() -> str:
    d = today_local()
    return f"{_WEEKDAYS[d.weekday()]} {d.day}. {d.month}. {d.year}"


# --- aplikace ---------------------------------------------------------------------------------------------------

class App(tk.Tk):
    DAY_CHOICES = ("Dnes", "Zítra", "Dnes a zítra", "Vše")
    PERIOD_CHOICES = {"Posledních 7 dní": 7, "Posledních 30 dní": 30, "Vše": None}

    def __init__(self, db: Database | None = None, auto_refresh: bool = True,
                 pipeline_factory: Callable[[], Pipeline] = Pipeline):
        super().__init__()
        self.db = db or Database()
        self.pipeline_factory = pipeline_factory
        self._pipeline: Pipeline | None = None
        self._queue: queue.Queue = queue.Queue()
        self._busy = False
        self._progress_text = ""
        self.tips: list[Tip] = []
        self.statuses: dict[str, SourceStatus] = {}
        self.warnings: list[str] = []
        self.updated_at = None
        self.from_cache = False
        self.view = "today"

        # proměnné ovládacích prvků žijí v aplikaci, takže přežijí přepnutí motivu (překreslení)
        self.day_var = tk.StringVar(self, value=self.DAY_CHOICES[0])
        self.hide_started = tk.BooleanVar(self, value=False)
        self.only_confirmed = tk.BooleanVar(self, value=False)
        self.period_var = tk.StringVar(self, value="Posledních 30 dní")

        self.theme_choice = load_theme_choice()
        self.pal: Palette = resolve_palette(self.theme_choice)

        self.title(f"{config.APP_TITLE} – tipy na fotbal")
        width = min(1440, max(1100, self.winfo_screenwidth() - 80))
        height = min(940, max(700, self.winfo_screenheight() - 90))
        self.geometry(f"{width}x{height}")
        self.minsize(1100, 600)
        self.fonts = Fonts.create(self)
        self._setup_style()
        self._build()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.bind("<Configure>", self._on_resize)

        self._load_cached()
        self._refresh_history()
        if auto_refresh:
            self.after(300, self.refresh)        # automatické stažení po startu

    def _on_resize(self, event) -> None:
        if event.widget is self:
            self._apply_compact(event.height < 800)

    def _apply_compact(self, compact: bool) -> None:
        """V nízkém okně se schová perex, aby tabulka dostala víc místa."""
        if compact == self._compact:
            return
        self._compact = compact
        if compact:
            self.lead.pack_forget()
        else:
            self.lead.pack(anchor="w", after=self.title_label)

    # --- vzhled ----------------------------------------------------------------------------------------------------
    def _setup_style(self) -> None:
        p, f = self.pal, self.fonts
        self.configure(bg=p.ground)
        s = ttk.Style(self)
        s.theme_use("clam")
        s.configure(".", background=p.surface, foreground=p.ink, font=f.body, bordercolor=p.rule_strong,
                    lightcolor=p.surface, darkcolor=p.surface, troughcolor=p.sunk, focuscolor=p.surface)
        s.configure("Treeview", rowheight=30, background=p.surface, fieldbackground=p.surface, foreground=p.ink,
                    borderwidth=0, lightcolor=p.surface, darkcolor=p.surface)
        s.configure("Treeview.Heading", font=f.caps, background=p.sunk, foreground=p.ink_soft, relief="flat",
                    padding=(6, 8), borderwidth=0, lightcolor=p.sunk, darkcolor=p.sunk, bordercolor=p.rule)
        s.map("Treeview.Heading", background=[("active", p.rule)], foreground=[("active", p.ink)])
        s.map("Treeview", background=_fixed_map(s, "background") + [("selected", p.accent)],
              foreground=_fixed_map(s, "foreground") + [("selected", p.on_accent)])
        # tlačítka: hranaté, 1px linka (`.btn`), primární = akcent (`.btn.primary`)
        s.configure("TButton", background=p.surface, foreground=p.ink, padding=(14, 6), relief="solid", borderwidth=1,
                    bordercolor=p.rule_strong, lightcolor=p.surface, darkcolor=p.surface, font=f.body)
        s.map("TButton", bordercolor=[("active", p.ink_soft)], background=[("active", p.surface), ("disabled", p.sunk)],
              foreground=[("disabled", p.ink_faint)])
        s.configure("Compact.TButton", padding=(8, 5))
        s.configure("Primary.TButton", background=p.accent, foreground=p.on_accent, bordercolor=p.accent,
                    lightcolor=p.accent, darkcolor=p.accent, font=f.bold, padding=(16, 7))
        s.map("Primary.TButton", background=[("active", p.accent), ("disabled", p.rule_strong)],
              foreground=[("disabled", p.surface)], bordercolor=[("active", p.accent), ("disabled", p.rule_strong)])
        s.configure("TCombobox", fieldbackground=p.surface, background=p.surface, foreground=p.ink,
                    bordercolor=p.rule_strong, lightcolor=p.surface, darkcolor=p.surface, arrowcolor=p.ink_soft,
                    padding=5, selectbackground=p.accent_soft, selectforeground=p.ink)
        s.map("TCombobox", fieldbackground=[("readonly", p.surface)], bordercolor=[("focus", p.accent)],
              foreground=[("readonly", p.ink)], selectbackground=[("readonly", p.surface)],
              selectforeground=[("readonly", p.ink)])
        self.option_add("*TCombobox*Listbox.background", p.surface)
        self.option_add("*TCombobox*Listbox.foreground", p.ink)
        self.option_add("*TCombobox*Listbox.selectBackground", p.accent)
        self.option_add("*TCombobox*Listbox.selectForeground", p.on_accent)
        self.option_add("*TCombobox*Listbox.font", f.body)
        s.configure("TCheckbutton", background=p.surface, foreground=p.ink, indicatorbackground=p.surface,
                    indicatorforeground=p.ink, upperbordercolor=p.rule_strong, lowerbordercolor=p.rule_strong,
                    font=f.body, padding=2)
        s.map("TCheckbutton", background=[("active", p.surface)], indicatorbackground=[("selected", p.accent)],
              indicatorforeground=[("selected", p.on_accent)])
        s.configure("TScrollbar", background=p.rule_strong, troughcolor=p.sunk, bordercolor=p.sunk,
                    arrowcolor=p.ink_soft, lightcolor=p.rule_strong, darkcolor=p.rule_strong, gripcount=0)
        s.map("TScrollbar", background=[("active", p.ink_faint)])
        s.configure("Horizontal.TProgressbar", background=p.accent, troughcolor=p.sunk, bordercolor=p.sunk,
                    lightcolor=p.accent, darkcolor=p.accent, thickness=6)

    def _set_theme(self, choice: str) -> None:
        self.theme_choice = choice
        self.pal = PALETTES[choice] if choice in PALETTES else resolve_palette(choice)
        save_theme_choice(choice)
        self._rebuild()

    def _toggle_theme(self) -> None:
        self._set_theme("light" if self.pal.name == "dark" else "dark")

    def _rebuild(self) -> None:
        """Po změně motivu postaví okno znovu (barvy jsou zapečené do widgetů); data a filtry zůstávají."""
        for child in self.winfo_children():
            child.destroy()
        self._setup_style()
        self._build()
        self._apply_view()
        self._update_chrome()
        self._refresh_history()
        self._show_view(self.view)
        self._set_busy(self._busy, self._progress_text)
        self._apply_compact(self.winfo_height() < 800)       # nově postavená hlavička začíná v plné podobě

    # --- stavba okna --------------------------------------------------------------------------------------------------
    def _build(self) -> None:
        p, f = self.pal, self.fonts
        wrap = tk.Frame(self, bg=p.ground)
        wrap.pack(fill="both", expand=True, padx=28)
        self.wrap = wrap

        # hlavička (`.top`): kicker, nadpis, perex a akce; pod ní 2px linka
        top = tk.Frame(wrap, bg=p.ground)
        top.pack(fill="x", pady=(26, 0))
        left = tk.Frame(top, bg=p.ground)
        left.pack(side="left", anchor="s")
        _label(left, f"FOTBAL · {_long_date().upper()} · PRAŽSKÝ ČAS", font=f.caps, fg=p.signal, bg=p.ground).pack(anchor="w")
        self.title_label = _label(left, config.APP_TITLE, font=f.title, fg=p.ink, bg=p.ground)
        self.title_label.pack(anchor="w", pady=(4, 2))
        self.lead = _label(left, f"Scores24 dává tip, Forebet statistickou pravděpodobnost a SofaScore přesný čas a skóre. "
                     f"Zobrazí se jen tipy nad {config.MIN_PROBABILITY:.0f} % s kurzem od {_cz(f'{config.MIN_ODDS:.2f}')}.",
                           font=f.body, fg=p.ink_soft, bg=p.ground, justify="left", wraplength=620)
        self.lead.pack(anchor="w")
        self._compact = False
        actions = tk.Frame(top, bg=p.ground)
        actions.pack(side="right", anchor="s")
        self.chip = _label(actions, "DATA Z MEZIPAMĚTI", font=f.caps, fg=p.warn, bg=p.warn_soft, padx=9, pady=4)
        self.btn_theme = ttk.Button(actions, text="☾ Tmavý" if p.name == "light" else "☀ Světlý", command=self._toggle_theme)
        self.btn_theme.pack(side="right", padx=(8, 0))
        ttk.Button(actions, text="Otevřít Tipsport", command=lambda: webbrowser.open(config.TIPSPORT_URL)).pack(side="right", padx=(8, 0))
        self.btn_refresh = ttk.Button(actions, text="⟳  Obnovit tipy", style="Primary.TButton", command=self.refresh)
        self.btn_refresh.pack(side="right", padx=(8, 0))
        _hrule(wrap, p.ink, 2).pack(fill="x", pady=(16, 0))

        # přepínač pohledů a stav aktualizace
        nav = tk.Frame(wrap, bg=p.ground)
        nav.pack(fill="x", pady=(8, 0))
        self.nav_tabs: dict[str, tuple[tk.Label, tk.Frame]] = {}
        for key, text in (("today", "Dnešní tipy"), ("history", "Historie a statistiky")):
            cell = tk.Frame(nav, bg=p.ground, cursor="hand2")
            cell.pack(side="left", padx=(0, 22))
            lab = _label(cell, text.upper(), font=f.caps, fg=p.ink_soft, bg=p.ground, cursor="hand2")
            lab.pack(pady=(4, 4))
            bar = tk.Frame(cell, height=2, bg=p.ground)
            bar.pack(fill="x")
            for w in (cell, lab, bar):
                w.bind("<Button-1>", lambda e, k=key: self._show_view(k))
            self.nav_tabs[key] = (lab, bar)
        right = tk.Frame(nav, bg=p.ground)
        right.pack(side="right")
        self.lbl_updated = _label(right, "Poslední aktualizace: —", font=f.small, fg=p.ink_soft, bg=p.ground)
        self.lbl_updated.pack(side="right")
        self.progress = ttk.Progressbar(right, mode="indeterminate", length=110)
        self.lbl_progress = _label(right, "", font=f.small, fg=p.accent, bg=p.ground)

        # banner s varováním (`.locked-note`); zobrazí se až když je co hlásit
        self.banner = tk.Label(wrap, text="", bg=p.warn_soft, fg=p.warn, anchor="w", justify="left",
                               padx=14, pady=9, font=f.small)
        _wrap_to_width(self.banner, margin=28, initial=1100)
        self.banner_anchor = tk.Frame(wrap, height=1, bg=p.ground)
        self.banner_anchor.pack(fill="x")

        self._build_footer(wrap)                       # nejdřív patička (side=bottom), aby jí obsah nevzal místo
        self.content = tk.Frame(wrap, bg=p.ground)
        self.content.pack(fill="both", expand=True)
        self._build_today()
        self._build_history()
        self._show_view(self.view)

    def _stat_strip(self, parent, captions: dict[str, str],
                    extra: Callable[[tk.Frame], None] | None = None) -> dict[str, Stat]:
        """Pás ukazatelů pod hlavičkou (`.matchbar`) s linkou pod sebou; `extra` doplní blok vpravo."""
        p = self.pal
        strip = tk.Frame(parent, bg=p.ground)
        strip.pack(fill="x", pady=(14, 0))
        row = tk.Frame(strip, bg=p.ground)
        row.pack(fill="x")
        stats: dict[str, Stat] = {}
        for key, caption in captions.items():
            st = Stat(row, p, self.fonts, caption)
            st.pack(side="left", padx=(0, 44))
            stats[key] = st
        if extra is not None:
            extra(row)
        _hrule(strip, p.rule).pack(fill="x", pady=(14, 0))
        return stats

    def _distribution(self, row: tk.Frame) -> None:
        """Dva úzké pruhy vpravo v pásu: rozložení podle pravděpodobnosti a podle stavu zápasu."""
        p, f = self.pal, self.fonts
        box = tk.Frame(row, bg=p.ground)
        box.pack(side="right", anchor="e")

        def line(r: int, caption: str, legend: list[tuple[str, str]]) -> SegBar:
            _label(box, caption.upper(), font=f.caps, fg=p.ink_soft, bg=p.ground).grid(row=r, column=0, sticky="w", pady=2)
            bar = SegBar(box, p, f, height=18)
            bar.configure(width=180)
            bar.grid(row=r, column=1, padx=10, pady=2)
            Legend(box, p, f, legend, bg=p.ground).grid(row=r, column=2, sticky="w", pady=2)
            return bar

        self.bar_prob = line(0, "Pravděpodobnost", [(p.pos, f"nad {config.HIGH_PROBABILITY:.0f} %"),
                                                    (p.warn, f"{config.MIN_PROBABILITY:.0f}–{config.HIGH_PROBABILITY:.0f} %")])
        self.bar_state = line(1, "Stav zápasů", [(p.accent, "čeká"), (p.signal, "živě"), (p.draw, "konec")])

    def _field(self, parent, caption: str) -> tk.Frame:
        """Popisek nad ovládacím prvkem (`.field`)."""
        box = tk.Frame(parent, bg=self.pal.surface)
        _label(box, caption, font=self.fonts.small, fg=self.pal.ink_soft, bg=self.pal.surface).pack(anchor="w", pady=(0, 3))
        return box

    def _tree_tags(self, tree: ttk.Treeview) -> None:
        p = self.pal
        tree.tag_configure("high", background=p.pos_soft)
        tree.tag_configure("mid", background=p.warn_soft)
        tree.tag_configure("finished", foreground=p.ink_faint)
        tree.tag_configure("live", foreground=p.accent)
        tree.tag_configure("win", background=p.pos_soft)
        tree.tag_configure("loss", background=p.neg_soft)
        tree.tag_configure("void", background=p.sunk)

    def _menu(self) -> tk.Menu:
        p = self.pal
        return tk.Menu(self, tearoff=0, bg=p.surface, fg=p.ink, activebackground=p.accent, activeforeground=p.on_accent,
                       bd=1, relief="solid", font=self.fonts.body)

    def _build_today(self) -> None:
        p, f = self.pal, self.fonts
        self.today_view = tk.Frame(self.content, bg=p.ground)
        self.stats = self._stat_strip(self.today_view, {
            "count": "Nalezeno tipů", "high": f"Nad {config.HIGH_PROBABILITY:.0f} %",
            "odds": "Průměrný kurz", "next": "Nejbližší zápas"}, extra=self._distribution)
        self.lbl_count = self.stats["count"]._value        # (testy a starý kód čtou text počítadla)

        body = tk.Frame(self.today_view, bg=p.ground)
        body.pack(fill="both", expand=True, pady=(20, 0))
        body.columnconfigure(0, weight=1)
        body.columnconfigure(1, minsize=SIDEBAR_W)
        body.rowconfigure(0, weight=1)

        card = Card(body, p, f, letter="A", title="Tipy po filtraci",
                    note=f"pravděp. > {config.MIN_PROBABILITY:.0f} % · kurz ≥ {_cz(f'{config.MIN_ODDS:.2f}')}")
        card.grid(row=0, column=0, sticky="nsew", padx=(0, 22))
        bar = tk.Frame(card.body, bg=p.surface)
        bar.pack(fill="x", pady=(0, 12))
        fld = self._field(bar, "Zobrazit")
        fld.pack(side="left")
        day = ttk.Combobox(fld, textvariable=self.day_var, values=self.DAY_CHOICES, state="readonly", width=13)
        day.pack()
        day.bind("<<ComboboxSelected>>", lambda e: self._apply_view())
        checks = tk.Frame(bar, bg=p.surface)
        checks.pack(side="left", padx=(20, 0), anchor="s")
        ttk.Checkbutton(checks, text="Skrýt zahájené zápasy", variable=self.hide_started,
                        command=self._apply_view).pack(side="left")
        ttk.Checkbutton(checks, text=f"Jen potvrzené Forebetem (> {config.MIN_PROBABILITY:.0f} %)",
                        variable=self.only_confirmed, command=self._apply_view).pack(side="left", padx=(16, 0))

        legend = tk.Frame(card.body, bg=p.surface)
        legend.pack(fill="x", pady=(10, 0), side="bottom")
        Legend(legend, p, f, [(p.pos_soft, f"nad {config.HIGH_PROBABILITY:.0f} %"),
                              (p.warn_soft, f"{config.MIN_PROBABILITY:.0f}–{config.HIGH_PROBABILITY:.0f} %")]).pack(side="left")
        _label(legend, "* kurz orientační (Scores24), ~ = odhad · modře živě, šedě skončeno", font=f.small,
               fg=p.ink_soft, bg=p.surface).pack(side="left")

        self.today_table = SortableTable(card.body, p, f, TODAY_COLUMNS, today_row_tags, default_sort="prob")
        self.today_table.pack(fill="both", expand=True)
        tree = self.today_table.tree
        self._tree_tags(tree)
        tree.bind("<Double-1>", lambda e: self._open(self.today_table.selected(), "scores24"))
        tree.bind("<Button-3>", self._popup_today)
        tree.bind("<Button-2>", self._popup_today)       # macOS
        tree.bind("<<TreeviewSelect>>", lambda e: self._on_select())
        self.today_menu = self._menu()
        self.today_menu.add_command(label="Otevřít zápas na Scores24", command=lambda: self._open(self.today_table.selected(), "scores24"))
        self.today_menu.add_command(label="Otevřít zápas na SofaScore", command=lambda: self._open(self.today_table.selected(), "sofascore"))
        self.today_menu.add_separator()
        self.today_menu.add_command(label="Zkopírovat zápas a otevřít Tipsport",
                                    command=lambda: self._copy_and_open_tipsport(self.today_table.selected()))
        self.today_menu.add_command(label="Zkopírovat tip", command=self._copy_tip)

        # boční karty
        scroller = ScrollFrame(body, p.ground, SIDEBAR_W)
        scroller.grid(row=0, column=1, sticky="nsew")
        side = scroller.inner
        self.detail = VerdictCard(side, self)
        self.detail.pack(fill="x")

        src = Card(side, p, f, title="Zdroje dat", accent_top=False)
        src.pack(fill="x", pady=(16, 0))
        self.sources_body = src.body

    def _build_history(self) -> None:
        p, f = self.pal, self.fonts
        self.history_view = tk.Frame(self.content, bg=p.ground)
        self.hstats = self._stat_strip(self.history_view, {
            "total": "Uložených tipů", "evaluated": "Vyhodnoceno", "hit": "Úspěšnost",
            "odds": "Průměrný kurz", "profit": "Zisk při vkladu 1"})

        card = Card(self.history_view, p, f, letter="B", title="Historie tipů", note="záznam a výsledky")
        card.pack(fill="both", expand=True, pady=(20, 0))
        bar = tk.Frame(card.body, bg=p.surface)
        bar.pack(fill="x", pady=(0, 12))
        fld = self._field(bar, "Období")
        fld.pack(side="left")
        period = ttk.Combobox(fld, textvariable=self.period_var, values=list(self.PERIOD_CHOICES),
                              state="readonly", width=18)
        period.pack()
        period.bind("<<ComboboxSelected>>", lambda e: self._refresh_history())
        res = self._field(bar, "Označit výsledek vybraného tipu")
        res.pack(side="left", padx=(22, 0))
        btns = tk.Frame(res, bg=p.surface)
        btns.pack(anchor="w")
        for text, outcome in (("Výhra", WIN), ("Prohra", LOSS), ("Vráceno", VOID), ("Smazat", None)):
            ttk.Button(btns, text=text, command=lambda o=outcome: self._set_outcome(o)).pack(side="left", padx=(0, 6))
        self.btn_eval = ttk.Button(bar, text="Vyhodnotit automaticky", command=self._auto_evaluate)
        self.btn_eval.pack(side="right", anchor="s")

        note = _label(card.body, "Výsledky lze zadat ručně, nebo je doplní „Vyhodnotit automaticky“ podle SofaScore "
                                 "(jen běžné trhy; ruční výsledek se nikdy nepřepisuje). Zisk a ROI se počítají jen "
                                 "z tipů se skutečným kurzem.", font=f.small, fg=p.ink_soft, bg=p.surface, justify="left")
        note.pack(fill="x", pady=(10, 0), side="bottom")
        _wrap_to_width(note, initial=900)
        self.history_table = SortableTable(card.body, p, f, HISTORY_COLUMNS, history_row_tags, default_sort="date")
        self.history_table.pack(fill="both", expand=True)
        self._tree_tags(self.history_table.tree)
        self.history_menu = self._menu()
        for text, outcome in (("Označit jako výhru", WIN), ("Označit jako prohru", LOSS),
                              ("Označit jako vrácenou sázku", VOID), ("Smazat výsledek", None)):
            self.history_menu.add_command(label=text, command=lambda o=outcome: self._set_outcome(o))
        self.history_table.tree.bind("<Button-3>", self._popup_history)
        self.history_table.tree.bind("<Button-2>", self._popup_history)

    def _build_footer(self, parent) -> None:
        p, f = self.pal, self.fonts
        foot = tk.Frame(parent, bg=p.ground)
        foot.pack(fill="x", pady=(18, 16), side="bottom")
        _hrule(foot, p.rule_strong).pack(fill="x")
        a = _label(foot, "Pravděp. = míra shody tipu podle Scores24, ne záruka výhry; sloupec Forebet je statistický model. "
                         "Kurzy jsou orientační – před vsazením je vždy ověřte u Tipsportu.",
                   font=f.small, fg=p.ink_soft, bg=p.ground, justify="left")
        a.pack(fill="x", pady=(10, 2))
        _wrap_to_width(a, initial=1100)
        b = _label(foot, "Hazardní hry jsou jen pro osoby starší 18 let. Sázej jen peníze, které si můžeš dovolit prohrát. "
                         "Pomoc je zdarma: Národní linka pro odvykání 800 350 000 (všední dny 10–18), chciodvykat.cz.",
                   font=f.small, fg=p.ink_soft, bg=p.ground, justify="left", cursor="hand2")
        b.pack(fill="x")
        _wrap_to_width(b, initial=1100)
        b.bind("<Button-1>", lambda e: webbrowser.open("https://www.chciodvykat.cz/odvykani-hrani"))

    def _show_view(self, key: str) -> None:
        self.view = key
        for name, view in (("today", self.today_view), ("history", self.history_view)):
            if name == key:
                view.pack(fill="both", expand=True)
            else:
                view.pack_forget()
        for name, (lab, bar) in self.nav_tabs.items():
            active = name == key
            lab.configure(fg=self.pal.ink if active else self.pal.ink_soft)
            bar.configure(bg=self.pal.accent if active else self.pal.ground)

    # --- data: cache, stažení ---------------------------------------------------------------------------------------------
    def _load_cached(self) -> None:
        """Hned po startu ukáže poslední uložená data, než doběhne nové stahování."""
        run = self.db.latest_run()
        if run is None:
            self._apply_view()
            self._update_chrome()
            return
        self.tips = self.db.tips_of_latest_run()
        self.statuses, self.warnings = run.statuses, []
        self.updated_at, self.from_cache = run.finished_at, True
        self._apply_view()
        self._update_chrome()

    def refresh(self) -> None:
        if self._busy:
            return
        self._set_busy(True, "Načítám…")
        self._pipeline = self.pipeline_factory()
        pipeline = self._pipeline

        def worker() -> None:
            try:
                result = pipeline.run(progress=lambda m: self._queue.put(("progress", m)))
                self._queue.put(("done", result))
            except Exception as exc:  # poslední pojistka, ať vlákno nezmizí beze stopy
                log.exception("Stahování selhalo")
                self._queue.put(("crash", exc))

        threading.Thread(target=worker, daemon=True, name="scrape").start()
        self.after(100, self._poll)

    def _poll(self) -> None:
        try:
            while True:
                kind, payload = self._queue.get_nowait()
                if kind == "progress":
                    self._progress_text = payload
                    self.lbl_progress.configure(text=payload)
                elif kind == "done":
                    self._on_result(payload)
                    return
                elif kind == "crash":
                    self._set_busy(False)
                    self.warnings = [f"Neočekávaná chyba při stahování: {payload}"]
                    self._update_chrome()
                    return
                elif kind == "results_done":
                    self._set_busy(False)
                    self._refresh_history()
                    messagebox.showinfo("Vyhodnocení výsledků", payload, parent=self)
                    return
        except queue.Empty:
            pass
        if self._busy:
            self.after(100, self._poll)

    def _on_result(self, result: ScrapeResult) -> None:
        self._set_busy(False)
        self.statuses = result.statuses
        if result.success:
            try:
                self.db.save_run(result)
            except Exception as exc:
                log.exception("Uložení do databáze selhalo")
                result.warnings.append(f"Databáze: tipy se nepodařilo uložit ({exc}).")
            self.tips, self.warnings = result.tips, result.warnings
            self.updated_at, self.from_cache = result.finished_at, False
        else:
            # Stahování selhalo: ponecháme poslední uložená data a řekneme proč.
            run = self.db.latest_run()
            self.tips = self.db.tips_of_latest_run() if run else []
            self.updated_at = run.finished_at if run else None
            self.from_cache = True
            when = f" z {fmt_stamp(self.updated_at)}" if self.updated_at else ""
            head = "Bez připojení k internetu" if result.offline else "Tipy se nepodařilo stáhnout"
            self.warnings = [f"{head} – zobrazuji poslední uložená data{when}." if self.tips
                             else f"{head} a v databázi zatím nejsou žádná uložená data.", *result.warnings]
        self._apply_view()
        self._update_chrome()
        self._refresh_history()

    def _set_busy(self, busy: bool, text: str = "") -> None:
        self._busy = busy
        self._progress_text = text if busy else ""
        self.btn_refresh.configure(state="disabled" if busy else "normal")
        self.btn_eval.configure(state="disabled" if busy else "normal")
        if busy:
            self.lbl_updated.pack_forget()
            self.progress.pack(side="right", padx=(8, 0))
            self.lbl_progress.pack(side="right")
            self.lbl_progress.configure(text=text)
            self.progress.start(12)
        else:
            self.progress.stop()
            self.progress.pack_forget()
            self.lbl_progress.pack_forget()
            self.lbl_updated.pack(side="right")

    # --- zobrazení -----------------------------------------------------------------------------------------------------------
    def _apply_view(self) -> None:
        today = today_local()
        wanted = {"Dnes": {today}, "Zítra": {today + timedelta(days=1)},
                  "Dnes a zítra": {today, today + timedelta(days=1)}}.get(self.day_var.get())
        rows = [t for t in self.tips if wanted is None or local_date(t.kickoff_utc) in wanted]
        if self.hide_started.get():
            rows = [t for t in rows if not is_started(t)]
        if self.only_confirmed.get():
            rows = [t for t in rows if t.prob_forebet is not None and t.prob_forebet > config.MIN_PROBABILITY]
        empty = ("Zatím nejsou žádná data. Klikněte na „Obnovit tipy“." if not self.tips
                 else "Pro zvolené zobrazení není žádný tip, který splňuje filtry.")
        self.today_table.set_items(rows, empty)

        # ukazatele
        high = sum(1 for t in rows if probability_class(t.probability) == HIGH)
        self.stats["count"].set(str(len(rows)),
                                f"Nalezeno tipů" + (f" (z {len(self.tips)} celkem)" if len(rows) != len(self.tips) else ""))
        self.stats["high"].set(str(high), f"Nad {config.HIGH_PROBABILITY:.0f} %", self.pal.pos if high else None)
        odds = [t.odds for t in rows if t.odds]
        self.stats["odds"].set(_cz(f"{sum(odds) / len(odds):.2f}") if odds else "–", "Průměrný kurz")
        upcoming = sorted(t.kickoff_utc for t in rows if not is_started(t))
        self.stats["next"].set(f"{to_local(upcoming[0]):%H:%M}" if upcoming else "–", "Nejbližší zápas (praž. čas)")

        # rozložení
        p = self.pal
        mid = len(rows) - high
        self.bar_prob.set([(high, p.pos, p.on_accent), (mid, p.warn, p.on_accent)])
        live = sum(1 for t in rows if t.status == LIVE or (t.status != FINISHED and is_started(t)))
        done = sum(1 for t in rows if t.status == FINISHED)
        self.bar_state.set([(len(rows) - live - done, p.accent, p.on_accent), (live, p.signal, p.on_accent),
                            (done, p.draw, p.ink)])
        self._on_select()

    def _on_select(self) -> None:
        self.detail.show(self.today_table.selected())

    def _update_chrome(self) -> None:
        p = self.pal
        if self.updated_at:
            suffix = "  (data z mezipaměti)" if self.from_cache else ""
            self.lbl_updated.configure(text=f"Poslední aktualizace: {fmt_stamp(self.updated_at)}{suffix}",
                                       fg=p.warn if self.from_cache else p.ink_soft)
        else:
            self.lbl_updated.configure(text="Poslední aktualizace: —", fg=p.ink_soft)
        if self.from_cache:
            self.chip.pack(side="right", padx=(8, 0))
        else:
            self.chip.pack_forget()
        self._show_banner(self.warnings)
        self._render_sources()

    def _show_banner(self, lines: list[str]) -> None:
        if lines:
            self.banner.configure(text="⚠  " + "\n⚠  ".join(lines))
            self.banner.pack(fill="x", pady=(12, 0), after=self.banner_anchor)
        else:
            self.banner.pack_forget()

    def _render_sources(self) -> None:
        """Karta „Zdroje dat“ jako checklist (`.checks`): ikona, název a detail pod ním."""
        p, f = self.pal, self.fonts
        for child in self.sources_body.winfo_children():
            child.destroy()
        if not self.statuses:
            _label(self.sources_body, "Zdroje se zatím nenačetly.", font=f.small, fg=p.ink_soft, bg=p.surface).pack(anchor="w")
            return
        tone = {"ok": p.pos, "partial": p.warn, "failed": p.neg}
        for i, s in enumerate(self.statuses.values()):
            row = tk.Frame(self.sources_body, bg=p.surface)
            row.pack(fill="x")
            if i:
                _hrule(row, p.rule).pack(fill="x")
            line = tk.Frame(row, bg=p.surface)
            line.pack(fill="x", pady=7)
            _label(line, STATE_ICON.get(s.state, "?"), font=f.caps, fg=tone.get(s.state, p.ink_faint), bg=p.surface,
                   width=2).pack(side="left", anchor="n")
            text = tk.Frame(line, bg=p.surface)
            text.pack(side="left", fill="x", expand=True)
            _label(text, s.name, font=f.bold, fg=p.ink, bg=p.surface).pack(anchor="w")
            detail = s.message.removeprefix(f"{s.name}:").strip().split(". ")[0].rstrip(".")
            if detail:
                msg = _label(text, detail + ".", font=f.small, fg=p.ink_soft, bg=p.surface, justify="left")
                msg.pack(anchor="w", fill="x")
                _wrap_to_width(msg)

    # --- akce nad řádky ----------------------------------------------------------------------------------------------------------
    def _popup_today(self, event) -> None:
        row = self.today_table.tree.identify_row(event.y)
        if row:
            self.today_table.tree.selection_set(row)
            self.today_menu.tk_popup(event.x_root, event.y_root)

    def _open(self, tip: Tip | None, which: str) -> None:
        if tip is None:
            return
        url = tip.url if which == "scores24" else tip.sofascore_url
        if url:
            webbrowser.open(url)
        else:
            messagebox.showinfo("Odkaz", "Pro tento zápas není odkaz k dispozici.", parent=self)

    def _copy_tip(self) -> None:
        t = self.today_table.selected()
        if t is not None:
            self._to_clipboard(f"{t.match_name} – {t.tip_label} @ {_cz(fmt_odds(t.odds, t.odds_estimated))}")

    def _copy_and_open_tipsport(self, tip: Tip | None) -> None:
        if tip is not None:
            self._to_clipboard(tip.match_name)
            webbrowser.open(config.TIPSPORT_URL)

    def _to_clipboard(self, text: str) -> None:
        self.clipboard_clear()
        self.clipboard_append(text)

    # --- historie ----------------------------------------------------------------------------------------------------------------------
    def _refresh_history(self) -> None:
        days = self.PERIOD_CHOICES[self.period_var.get()]
        self.history_table.set_items(self.db.history(days), "V historii zatím nejsou žádné tipy.")
        s = self.db.stats(days)
        p = self.pal
        self.hstats["total"].set(str(s.total))
        self.hstats["evaluated"].set(str(s.evaluated), f"Vyhodnoceno · výhry {s.wins}, prohry {s.losses}, vráceno {s.voids}")
        self.hstats["hit"].set(f"{s.hit_rate:.0f} %" if s.hit_rate is not None else "–", "Úspěšnost")
        self.hstats["odds"].set(_cz(f"{s.avg_odds:.2f}") if s.avg_odds else "–", "Průměrný kurz")
        if s.profit is None:
            self.hstats["profit"].set("–", "Zisk při vkladu 1")
        else:
            self.hstats["profit"].set(_cz(f"{s.profit:+.2f}").replace("-", "−"),
                                      f"Zisk při vkladu 1 · ROI {s.roi_pct:+.0f} %".replace("-", "−"),
                                      p.pos if s.profit > 0 else p.neg if s.profit < 0 else None)

    def _popup_history(self, event) -> None:
        row = self.history_table.tree.identify_row(event.y)
        if row:
            self.history_table.tree.selection_set(row)
            self.history_menu.tk_popup(event.x_root, event.y_root)

    def _set_outcome(self, outcome: str | None) -> None:
        t = self.history_table.selected()
        if t is None or t.id is None:
            messagebox.showinfo("Výsledek", "Nejdřív vyberte tip v tabulce.", parent=self)
            return
        self.db.set_outcome(t.id, outcome, "manual")
        self._refresh_history()

    def _auto_evaluate(self) -> None:
        if self._busy:
            return
        self._set_busy(True, "Vyhodnocuji výsledky…")

        def worker() -> None:
            try:
                _, message = update_results(self.db, progress=lambda m: self._queue.put(("progress", m)))
            except Exception as exc:
                log.exception("Vyhodnocení selhalo")
                message = f"Vyhodnocení se nezdařilo: {exc}"
            self._queue.put(("results_done", message))

        threading.Thread(target=worker, daemon=True, name="results").start()
        self.after(100, self._poll)

    def _on_close(self) -> None:
        if self._pipeline is not None:
            try:
                self._pipeline.browser.close()      # ať po zavření nezůstane běžet Chrome
            except Exception:
                pass
        self.destroy()


def _fixed_map(style: ttk.Style, option: str):
    """Mapa stavů pro Treeview bez výchozích barev výběru a bez chyby Tk 8.6.9 (tag_configure se ignoroval)."""
    return [elm for elm in style.map("Treeview", query_opt=option)
            if not any("selected" in str(spec) for spec in elm[:-1])]


def _enable_hidpi() -> None:
    """Ve Windows vypne rozmazané škálování, aby bylo písmo ostré."""
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass


def run_app() -> None:
    _enable_hidpi()
    App().mainloop()
