"""Grafické rozhraní (Tkinter / ttk) – přehled dnešních tipů a historie se statistikami.

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
from .models import (FINISHED, LIVE, LOSS, OUTCOME_LABELS, VOID, WIN, ScrapeResult, SourceStatus, Tip)
from .odds import fmt_odds
from .pipeline import Pipeline, update_results
from .timeutil import fmt_kickoff, fmt_stamp, local_date, now_utc, today_local

log = logging.getLogger(__name__)

# --- barvy ---------------------------------------------------------------------------------
BG = "#f3f5f9"
HEADER_BG = "#1b2540"
ACCENT = "#2457d6"
ROW_HIGH = "#d6f0da"      # zelená: pravděpodobnost > 75 %
ROW_MID = "#fff2bf"       # žlutá: 60–75 %
ROW_WIN, ROW_LOSS, ROW_VOID = "#d6f0da", "#f8d7d7", "#e6e8ee"
WARN_BG, WARN_FG = "#fff0c2", "#6b4b00"
MUTED = "#6a7285"

STATE_ICON = {"ok": "✔", "partial": "◐", "failed": "✖", "skipped": "–", "pending": "…"}


@dataclass(frozen=True)
class Column:
    id: str
    title: str
    width: int
    text: Callable[[Any], str]
    sort_key: Callable[[Any], Any]
    anchor: str = "w"
    stretch: bool = False


class SortableTable(ttk.Frame):
    """Treeview se seznamem objektů; kliknutí na záhlaví řadí, druhé kliknutí obrací pořadí."""

    def __init__(self, master, columns: list[Column], row_tags: Callable[[Any], tuple[str, ...]],
                 default_sort: str, descending: bool = True):
        super().__init__(master)
        self.columns = {c.id: c for c in columns}
        self.row_tags = row_tags
        self.items: list[Any] = []
        self._by_iid: dict[str, Any] = {}
        self._sort_id, self._desc = default_sort, descending

        self.tree = ttk.Treeview(self, columns=[c.id for c in columns], show="headings", selectmode="browse")
        for c in columns:
            self.tree.column(c.id, width=c.width, anchor=c.anchor, stretch=c.stretch, minwidth=50)
            self.tree.heading(c.id, text=c.title, command=lambda cid=c.id: self.sort_by(cid))
        vsb = ttk.Scrollbar(self, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky="ns")
        # hláška uprostřed prázdné tabulky
        self.placeholder = tk.Label(self.tree, text="", bg="white", fg=MUTED, font=("TkDefaultFont", 11))
        self.rowconfigure(0, weight=1)
        self.columnconfigure(0, weight=1)

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
            self.tree.heading(c.id, text=c.title + arrow)


# --- formátování buněk -----------------------------------------------------------------------------

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


def forebet_text(t: Tip) -> str:
    return f"{t.prob_forebet:.0f} %" if t.prob_forebet is not None else "–"


TODAY_COLUMNS = [
    Column("time", "Začátek", 122, lambda t: fmt_kickoff(t.kickoff_utc), lambda t: t.kickoff_utc),
    Column("match", "Zápas", 215, lambda t: t.match_name, lambda t: t.match_name.casefold(), stretch=True),
    Column("league", "Soutěž", 170, lambda t: t.league, lambda t: t.league.casefold()),
    Column("tip", "Tip", 240, lambda t: t.tip_label, lambda t: t.tip_label.casefold(), stretch=True),
    Column("prob", "Pravděp.", 80, lambda t: f"{t.probability:.0f} %", lambda t: t.probability, "center"),
    Column("odds", "Kurz*", 70, lambda t: fmt_odds(t.odds, t.odds_estimated), lambda t: t.odds or 0, "center"),
    Column("fb", "Forebet", 70, forebet_text, lambda t: t.prob_forebet if t.prob_forebet is not None else -1, "center"),
    Column("source", "Zdroj", 150, lambda t: t.source_label, lambda t: t.source_label),
    Column("status", "Stav", 125, status_text, lambda t: (is_started(t), t.kickoff_utc)),
]


def today_row_tags(t: Tip) -> tuple[str, ...]:
    tags = ["high" if probability_class(t.probability) == HIGH else "mid"]
    if t.status == FINISHED:
        tags.append("finished")
    elif is_started(t):
        tags.append("live")
    return tuple(tags)


HISTORY_COLUMNS = [
    Column("date", "Datum", 122, lambda t: fmt_kickoff(t.kickoff_utc), lambda t: t.kickoff_utc),
    Column("match", "Zápas", 215, lambda t: t.match_name, lambda t: t.match_name.casefold(), stretch=True),
    Column("league", "Soutěž", 170, lambda t: t.league, lambda t: t.league.casefold()),
    Column("tip", "Tip", 240, lambda t: t.tip_label, lambda t: t.tip_label.casefold(), stretch=True),
    Column("prob", "Pravděp.", 80, lambda t: f"{t.probability:.0f} %", lambda t: t.probability, "center"),
    Column("odds", "Kurz*", 70, lambda t: fmt_odds(t.odds, t.odds_estimated), lambda t: t.odds or 0, "center"),
    Column("score", "Skóre", 70, lambda t: (f"{t.home_score}:{t.away_score}"
                                           if t.home_score is not None and t.away_score is not None else "–"),
           lambda t: (t.home_score or 0) + (t.away_score or 0), "center"),
    Column("source", "Zdroj", 150, lambda t: t.source_label, lambda t: t.source_label),
    Column("outcome", "Výsledek", 140,
           lambda t: OUTCOME_LABELS.get(t.outcome, "—") + (" (auto)" if t.outcome_source == "auto" else ""),
           lambda t: t.outcome or "", "center"),
]


def history_row_tags(t: Tip) -> tuple[str, ...]:
    return {WIN: ("win",), LOSS: ("loss",), VOID: ("void",)}.get(t.outcome, ())


# --- aplikace ---------------------------------------------------------------------------------------------

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
        self.tips: list[Tip] = []
        self.statuses: dict[str, SourceStatus] = {}
        self.warnings: list[str] = []
        self.updated_at = None
        self.from_cache = False

        self.title(f"{config.APP_TITLE} – tipy na fotbal")
        self.geometry("1280x760")
        self.minsize(1100, 560)
        self.configure(bg=BG)
        self._setup_style()
        self._build()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        self._load_cached()
        self._refresh_history()
        if auto_refresh:
            self.after(300, self.refresh)        # automatické stažení po startu

    # --- vzhled -----------------------------------------------------------------------------------------
    def _setup_style(self) -> None:
        base = tkfont.nametofont("TkDefaultFont")
        families = set(tkfont.families())
        family = "Segoe UI" if "Segoe UI" in families else base.actual("family")
        for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
            tkfont.nametofont(name).configure(family=family, size=10)
        self.f_title = tkfont.Font(family=family, size=17, weight="bold")
        self.f_big = tkfont.Font(family=family, size=24, weight="bold")
        self.f_bold = tkfont.Font(family=family, size=10, weight="bold")
        self.f_small = tkfont.Font(family=family, size=9)

        s = ttk.Style(self)
        s.theme_use("clam")
        s.configure(".", background=BG, foreground="#1d2433")
        s.configure("TFrame", background=BG)
        s.configure("TLabel", background=BG)
        s.configure("TNotebook", background=BG, borderwidth=0)
        s.configure("TNotebook.Tab", padding=(18, 8), font=(family, 10, "bold"), background="#dfe4ee")
        s.map("TNotebook.Tab", background=[("selected", "#ffffff")])
        s.configure("Treeview", rowheight=30, background="white", fieldbackground="white", borderwidth=0)
        s.configure("Treeview.Heading", font=(family, 10, "bold"), background="#e4e8f1", relief="flat", padding=6)
        s.map("Treeview.Heading", background=[("active", "#d4dbea")])
        s.map("Treeview", background=_fixed_map(s, "background"), foreground=_fixed_map(s, "foreground"))
        s.configure("Accent.TButton", background=ACCENT, foreground="white", padding=(16, 7), font=(family, 10, "bold"))
        s.map("Accent.TButton", background=[("disabled", "#9db3e8"), ("active", "#1b45ad")])
        s.configure("TButton", padding=(12, 6))
        s.configure("TCheckbutton", background=BG)
        s.configure("Card.TFrame", background="white")

    def _build(self) -> None:
        # záhlaví
        header = tk.Frame(self, bg=HEADER_BG)
        header.pack(fill="x")
        left = tk.Frame(header, bg=HEADER_BG)
        left.pack(side="left", padx=20, pady=12)
        tk.Label(left, text="⚽ Fotbalové tipy", font=self.f_title, bg=HEADER_BG, fg="white").pack(anchor="w")
        self.lbl_updated = tk.Label(left, text="Poslední aktualizace: —", font=self.f_small, bg=HEADER_BG, fg="#b9c3dd")
        self.lbl_updated.pack(anchor="w")
        right = tk.Frame(header, bg=HEADER_BG)
        right.pack(side="right", padx=20, pady=8)
        self.lbl_count = tk.Label(right, text="0", font=self.f_big, bg=HEADER_BG, fg="white")
        self.lbl_count.grid(row=0, column=0, rowspan=2, padx=(0, 10))
        tk.Label(right, text="Nalezeno tipů", font=self.f_bold, bg=HEADER_BG, fg="white").grid(row=0, column=1, sticky="sw")
        self.lbl_count_detail = tk.Label(right, text="", font=self.f_small, bg=HEADER_BG, fg="#b9c3dd")
        self.lbl_count_detail.grid(row=1, column=1, sticky="nw")

        # banner s varováním (skrytý, dokud není co hlásit)
        self.banner = tk.Label(self, text="", bg=WARN_BG, fg=WARN_FG, anchor="w", justify="left",
                               padx=16, pady=8, font=self.f_small)

        # záložky
        self.nb = ttk.Notebook(self)
        self.nb.pack(fill="both", expand=True, padx=14, pady=(10, 4))
        self.tab_today = ttk.Frame(self.nb)
        self.tab_history = ttk.Frame(self.nb)
        self.nb.add(self.tab_today, text="  Dnešní tipy  ")
        self.nb.add(self.tab_history, text="  Historie a statistiky  ")
        self._build_today()
        self._build_history()

        # patička
        foot = tk.Frame(self, bg=BG)
        foot.pack(fill="x", padx=16, pady=(0, 8))
        self.lbl_sources = tk.Label(foot, text="", bg=BG, fg=MUTED, font=self.f_small, cursor="hand2")
        self.lbl_sources.pack(side="left")
        self.lbl_sources.bind("<Button-1>", lambda e: self._show_source_details())
        self.progress = ttk.Progressbar(foot, mode="indeterminate", length=120)
        self.lbl_progress = tk.Label(foot, text="", bg=BG, fg=ACCENT, font=self.f_small)

    def _build_today(self) -> None:
        bar = ttk.Frame(self.tab_today)
        bar.pack(fill="x", pady=(10, 8))
        self.btn_refresh = ttk.Button(bar, text="⟳  Obnovit tipy", style="Accent.TButton", command=self.refresh)
        self.btn_refresh.pack(side="left")
        ttk.Label(bar, text="Zobrazit:").pack(side="left", padx=(18, 4))
        self.day_var = tk.StringVar(value=self.DAY_CHOICES[0])
        day = ttk.Combobox(bar, textvariable=self.day_var, values=self.DAY_CHOICES, state="readonly", width=13)
        day.pack(side="left")
        day.bind("<<ComboboxSelected>>", lambda e: self._apply_view())
        self.hide_started = tk.BooleanVar(value=False)
        ttk.Checkbutton(bar, text="Skrýt zahájené zápasy", variable=self.hide_started,
                        command=self._apply_view).pack(side="left", padx=(18, 0))
        self.only_confirmed = tk.BooleanVar(value=False)
        ttk.Checkbutton(bar, text="Jen potvrzené Forebetem (> 60 %)", variable=self.only_confirmed,
                        command=self._apply_view).pack(side="left", padx=(14, 0))
        ttk.Button(bar, text="Otevřít Tipsport", command=lambda: webbrowser.open(config.TIPSPORT_URL)).pack(side="right")

        self.today_table = SortableTable(self.tab_today, TODAY_COLUMNS, today_row_tags, default_sort="prob")
        self.today_table.pack(fill="both", expand=True)
        tree = self.today_table.tree
        tree.tag_configure("high", background=ROW_HIGH)
        tree.tag_configure("mid", background=ROW_MID)
        tree.tag_configure("finished", foreground="#8a90a0")
        tree.tag_configure("live", foreground="#1a4fbf")
        tree.bind("<Double-1>", lambda e: self._open_selected("scores24"))
        tree.bind("<Button-3>", self._popup_today)
        tree.bind("<Button-2>", self._popup_today)       # macOS
        self.today_menu = tk.Menu(self, tearoff=0)
        self.today_menu.add_command(label="Otevřít zápas na Scores24", command=lambda: self._open_selected("scores24"))
        self.today_menu.add_command(label="Otevřít zápas na SofaScore", command=lambda: self._open_selected("sofascore"))
        self.today_menu.add_separator()
        self.today_menu.add_command(label="Zkopírovat zápas a otevřít Tipsport", command=self._copy_and_open_tipsport)
        self.today_menu.add_command(label="Zkopírovat tip", command=self._copy_tip)

        legend = ttk.Frame(self.tab_today)
        legend.pack(fill="x", pady=(6, 2))
        for color, text in ((ROW_HIGH, f"pravděpodobnost nad {config.HIGH_PROBABILITY:.0f} %"),
                            (ROW_MID, f"{config.MIN_PROBABILITY:.0f}–{config.HIGH_PROBABILITY:.0f} %")):
            tk.Label(legend, text="   ", bg=color, relief="solid", borderwidth=1).pack(side="left", padx=(0, 4))
            tk.Label(legend, text=text, bg=BG, font=self.f_small).pack(side="left", padx=(0, 16))
        note = tk.Label(legend, bg=BG, fg=MUTED, font=self.f_small, justify="left", anchor="w",
                        text=f"Pravděp. = míra shody tipu podle Scores24 (není to záruka); sloupec Forebet = statistický model. "
                             f"* Kurzy jsou orientační (Scores24), ~ = odhad z pravděpodobnosti – před vsazením je ověřte u Tipsportu. "
                             f"Filtr: pravděpodobnost > {config.MIN_PROBABILITY:.0f} %, kurz ≥ {config.MIN_ODDS:.2f}.")
        note.pack(side="left", fill="x", expand=True)
        _wrap_to_width(note, margin=360)

    def _build_history(self) -> None:
        bar = ttk.Frame(self.tab_history)
        bar.pack(fill="x", pady=(10, 4))
        ttk.Label(bar, text="Období:").pack(side="left")
        self.period_var = tk.StringVar(value="Posledních 30 dní")
        period = ttk.Combobox(bar, textvariable=self.period_var, values=list(self.PERIOD_CHOICES),
                              state="readonly", width=18)
        period.pack(side="left", padx=(4, 16))
        period.bind("<<ComboboxSelected>>", lambda e: self._refresh_history())
        ttk.Label(bar, text="Označit výsledek:").pack(side="left", padx=(0, 4))
        for text, outcome in (("Výhra", WIN), ("Prohra", LOSS), ("Vráceno", VOID), ("Smazat", None)):
            ttk.Button(bar, text=text, command=lambda o=outcome: self._set_outcome(o)).pack(side="left", padx=2)
        self.btn_eval = ttk.Button(bar, text="Vyhodnotit automaticky", command=self._auto_evaluate)
        self.btn_eval.pack(side="right")

        self.lbl_stats = tk.Label(self.tab_history, text="", bg=BG, fg="#1d2433", anchor="w", justify="left",
                                  font=self.f_bold)
        self.lbl_stats.pack(fill="x", pady=(2, 6))

        self.history_table = SortableTable(self.tab_history, HISTORY_COLUMNS, history_row_tags, default_sort="date")
        self.history_table.pack(fill="both", expand=True)
        tree = self.history_table.tree
        tree.tag_configure("win", background=ROW_WIN)
        tree.tag_configure("loss", background=ROW_LOSS)
        tree.tag_configure("void", background=ROW_VOID)
        self.history_menu = tk.Menu(self, tearoff=0)
        for text, outcome in (("Označit jako výhru", WIN), ("Označit jako prohru", LOSS),
                              ("Označit jako vrácenou sázku", VOID), ("Smazat výsledek", None)):
            self.history_menu.add_command(label=text, command=lambda o=outcome: self._set_outcome(o))
        tree.bind("<Button-3>", self._popup_history)
        tree.bind("<Button-2>", self._popup_history)
        note = tk.Label(self.tab_history, bg=BG, fg=MUTED, font=self.f_small, anchor="w", justify="left",
                        text="Výsledky lze zadat ručně, nebo je doplní tlačítko „Vyhodnotit automaticky“ podle SofaScore "
                             "(vyhodnotí se jen běžné trhy; ruční výsledek se nikdy nepřepisuje). "
                             "Zisk/ROI se počítá jen z tipů se skutečným kurzem při vkladu 1 na tip.")
        note.pack(fill="x", pady=(6, 2))
        _wrap_to_width(note)

    # --- data: cache, stažení --------------------------------------------------------------------------------
    def _load_cached(self) -> None:
        """Hned po startu ukáže poslední uložená data, než doběhne nové stahování."""
        run = self.db.latest_run()
        if run is None:
            self._apply_view()
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
                    self.lbl_progress.configure(text=payload)
                elif kind == "done":
                    self._on_result(payload)
                    return
                elif kind == "crash":
                    self._set_busy(False)
                    self._show_banner([f"Neočekávaná chyba při stahování: {payload}"])
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
            self._load_cached_keep_statuses()
            when = f" z {fmt_stamp(self.updated_at)}" if self.updated_at else ""
            head = ("Bez připojení k internetu" if result.offline else "Tipy se nepodařilo stáhnout")
            self.warnings = [f"{head} – zobrazuji poslední uložená data{when}." if self.tips
                             else f"{head} a v databázi zatím nejsou žádná uložená data.", *result.warnings]
        self._apply_view()
        self._update_chrome()
        self._refresh_history()

    def _load_cached_keep_statuses(self) -> None:
        run = self.db.latest_run()
        self.tips = self.db.tips_of_latest_run() if run else []
        self.updated_at = run.finished_at if run else None
        self.from_cache = True

    def _set_busy(self, busy: bool, text: str = "") -> None:
        self._busy = busy
        self.btn_refresh.configure(state="disabled" if busy else "normal")
        self.btn_eval.configure(state="disabled" if busy else "normal")
        if busy:
            self.progress.pack(side="right", padx=(8, 0))
            self.lbl_progress.pack(side="right")
            self.lbl_progress.configure(text=text)
            self.progress.start(12)
        else:
            self.progress.stop()
            self.progress.pack_forget()
            self.lbl_progress.pack_forget()

    # --- zobrazení ---------------------------------------------------------------------------------------------
    def _apply_view(self) -> None:
        choice = self.day_var.get() if hasattr(self, "day_var") else self.DAY_CHOICES[0]
        today = today_local()
        wanted = {"Dnes": {today}, "Zítra": {today + timedelta(days=1)},
                  "Dnes a zítra": {today, today + timedelta(days=1)}}.get(choice)
        rows = [t for t in self.tips if wanted is None or local_date(t.kickoff_utc) in wanted]
        if self.hide_started.get():
            rows = [t for t in rows if not is_started(t)]
        if self.only_confirmed.get():
            rows = [t for t in rows if t.prob_forebet is not None and t.prob_forebet > config.MIN_PROBABILITY]
        if not self.tips:
            empty = "Zatím nejsou žádná data. Klikněte na „Obnovit tipy“."
        else:
            empty = "Pro zvolené zobrazení není žádný tip, který splňuje filtry."
        self.today_table.set_items(rows, empty)

        high = sum(1 for t in rows if probability_class(t.probability) == HIGH)
        self.lbl_count.configure(text=str(len(rows)))
        detail = f"z toho {high} nad {config.HIGH_PROBABILITY:.0f} %"
        if len(rows) != len(self.tips):
            detail += f"  ·  celkem po filtraci: {len(self.tips)}"
        self.lbl_count_detail.configure(text=detail)

    def _update_chrome(self) -> None:
        if self.updated_at:
            suffix = "  (data z mezipaměti)" if self.from_cache else ""
            self.lbl_updated.configure(text=f"Poslední aktualizace: {fmt_stamp(self.updated_at)}{suffix}",
                                       fg="#ffd37a" if self.from_cache else "#b9c3dd")
        else:
            self.lbl_updated.configure(text="Poslední aktualizace: —", fg="#b9c3dd")
        parts = [f"{s.name} {STATE_ICON.get(s.state, '?')}" for s in self.statuses.values()]
        self.lbl_sources.configure(text=("Zdroje: " + "   ".join(parts) + "   (klikněte pro podrobnosti)") if parts else "")
        self._show_banner(self.warnings)

    def _show_banner(self, lines: list[str]) -> None:
        if lines:
            self.banner.configure(text="⚠  " + "\n⚠  ".join(lines))
            self.banner.pack(fill="x", before=self.nb)
        else:
            self.banner.pack_forget()

    def _show_source_details(self) -> None:
        if not self.statuses:
            return
        lines = [f"{STATE_ICON.get(s.state, '?')}  {s.name}: {s.message or s.state}" for s in self.statuses.values()]
        messagebox.showinfo("Stav zdrojů", "\n\n".join(lines), parent=self)

    # --- akce nad řádky ------------------------------------------------------------------------------------------------
    def _popup_today(self, event) -> None:
        row = self.today_table.tree.identify_row(event.y)
        if row:
            self.today_table.tree.selection_set(row)
            self.today_menu.tk_popup(event.x_root, event.y_root)

    def _open_selected(self, which: str) -> None:
        t = self.today_table.selected()
        if t is None:
            return
        url = t.url if which == "scores24" else t.sofascore_url
        if url:
            webbrowser.open(url)
        else:
            messagebox.showinfo("Odkaz", "Pro tento zápas není odkaz k dispozici.", parent=self)

    def _copy_tip(self) -> None:
        t = self.today_table.selected()
        if t is not None:
            self._to_clipboard(f"{t.match_name} – {t.tip_label} @ {fmt_odds(t.odds, t.odds_estimated)}")

    def _copy_and_open_tipsport(self) -> None:
        t = self.today_table.selected()
        if t is not None:
            self._to_clipboard(t.match_name)
            webbrowser.open(config.TIPSPORT_URL)

    def _to_clipboard(self, text: str) -> None:
        self.clipboard_clear()
        self.clipboard_append(text)

    # --- historie --------------------------------------------------------------------------------------------------------
    def _refresh_history(self) -> None:
        days = self.PERIOD_CHOICES[self.period_var.get()]
        self.history_table.set_items(self.db.history(days), "V historii zatím nejsou žádné tipy.")
        s = self.db.stats(days)
        hit = f"{s.hit_rate:.0f} %" if s.hit_rate is not None else "—"
        roi = (f"{s.profit:+.2f} j. (ROI {s.roi_pct:+.0f} %)" if s.profit is not None else "—")
        avg = f"{s.avg_odds:.2f}" if s.avg_odds else "—"
        self.lbl_stats.configure(
            text=f"Tipů: {s.total}   ·   vyhodnoceno: {s.evaluated} (výhry {s.wins}, prohry {s.losses}, vráceno {s.voids})"
                 f"   ·   úspěšnost: {hit}   ·   průměrný kurz: {avg}   ·   zisk: {roi}")

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


def _wrap_to_width(label: tk.Label, margin: int = 24) -> None:
    """Dlouhý text štítku se zalomí podle aktuální šířky okna (Tk to sám neumí)."""
    label.bind("<Configure>", lambda e: label.configure(wraplength=max(200, label.winfo_width() - margin)))


def _fixed_map(style: ttk.Style, option: str):
    """Obejití chyby Tk 8.6.9, kdy Treeview ignoruje barvy z tag_configure."""
    return [elm for elm in style.map("Treeview", query_opt=option) if elm[:2] != ("!disabled", "!selected")]


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
