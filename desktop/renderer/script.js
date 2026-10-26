/* Fotbalové tipy – rozhraní (vykreslování, filtry, historie, rozložení Přehledu). */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const renderIcons = () => window.lucide?.createIcons();
  const desktop = window.desktop;

  /* Ukládání nastavení mezi spuštěními (localStorage je v Electronu trvalý). */
  const store = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(`tips:${key}`)); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(`tips:${key}`, JSON.stringify(value)); } catch { /* bez úložiště */ }
    },
  };
  // Zbytky nastavení z dřívějších verzí (rozložení karet, starší tikety…) se při startu smažou.
  try {
    const KEPT = new Set(["day", "live", "league", "sort", "hsort", "hist-range", "tk-day", "tk-result2", "ev-range", "ev-ai"]);
    Object.keys(localStorage).filter((k) => k.startsWith("tips:") && !KEPT.has(k.slice(5))).forEach((k) => localStorage.removeItem(k));
  } catch { /* bez úložiště */ }

  /* Všechna data ze zdrojů se do HTML vkládají jen přes esc(). */
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

  /* ---------- Formátování (česky, čas Europe/Prague jako v backendu) ---------- */
  const TZ = "Europe/Prague";
  const kickoffParts = new Intl.DateTimeFormat("cs-CZ", {
    timeZone: TZ, weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const nf2 = new Intl.NumberFormat("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf1 = new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 1 });

  const fmtKickoff = (iso) => {
    const p = Object.fromEntries(kickoffParts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return `${p.weekday} ${p.day}.${p.month}. ${p.hour}:${p.minute}`;
  };
  const localDay = (date) => dayFormat.format(date);
  const shiftDay = (day, delta) => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
  };
  const nextDay = (day) => shiftDay(day, 1);
  const fmtPct = (v) => (v === null || v === undefined ? "–" : `${nf1.format(v)} %`);
  /** Value = odhadovaná pravděpodobnost − pravděpodobnost z kurzu (v p. b.); u odhadnutého kurzu nemá smysl. */
  const valueOf = (t) => (t.odds && !t.oddsEstimated ? t.probability - 100 / t.odds : null);
  const fmtValue = (v) => (v === null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${nf1.format(Math.abs(v))} %`);
  const fmtOdds = (t) => (t.odds ? `${t.oddsEstimated ? "~" : ""}${nf2.format(t.odds)}` : "–");
  const fmtSigned = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + nf2.format(Math.abs(v));
  const fmtScore = (t) => (t.homeScore !== null && t.awayScore !== null ? `${t.homeScore}:${t.awayScore}` : "");
  const untilText = (ms) => {
    const min = Math.round(ms / 60000);
    if (min < 1) return "za chvíli";
    if (min < 60) return `za ${min} min`;
    const h = Math.floor(min / 60);
    const rest = min % 60;
    if (h < 24) return rest ? `za ${h} h ${rest} min` : `za ${h} h`;
    const d = Math.floor(h / 24);
    return `za ${d} ${d < 5 ? "dny" : "dní"}`;
  };

  /* ---------- Stav aplikace ---------- */
  const DAYS = ["today", "tomorrow"];

  const state = {
    payload: null,            // poslední data z hlavního procesu
    error: null,              // chyba celého stahování (text)
    busy: false,
    limits: { minProbability: 60, minOdds: 1.5, highProbability: 75 },
    day: DAYS.includes(store.get("day")) ? store.get("day") : "today",
    live: ["only", "hide"].includes(store.get("live")) ? store.get("live") : "",   // "only" = jen živé, "hide" = bez živých, "" = všechny
    query: "",
    league: store.get("league") || "",   // vybraná soutěž z levého sloupce ("" = všechny)
    leagues: [],
    sort: store.get("sort") || { key: "time", dir: "asc" },
    selected: null,           // klíč vybraného tipu
    visible: [],              // právě zobrazené tipy (po filtrech a řazení)
    history: null,            // { tips, stats } pro vybrané období
    mini: null,               // totéž za 30 dní (karta na Přehledu)
    range: ["today", "yesterday", "date", "month"].includes(store.get("hist-range")) ? store.get("hist-range") : "month",
    date: "",                 // vybraný den (RRRR-MM-DD) pro „Datum“
    hsort: store.get("hsort") || { key: "time", dir: "desc" },
    hselected: null,          // id vybraného řádku historie
  };

  const tipUid = (t) => `${t.kickoff}|${t.home}|${t.away}|${t.tipCode}`;
  const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

  /** Stav zápasu podle dat ze zdroje a hodin počítače. */
  const matchState = (t, now = Date.now()) => {
    const score = fmtScore(t);
    if (t.status === "finished") return { kind: "done", text: score ? `Skončil ${score}` : "Skončil", order: 3 };
    if (t.status === "live") return { kind: "live", text: score ? `Živě ${score}` : "Živě", order: 1 };
    const kickoff = Date.parse(t.kickoff);
    if (now < kickoff) return { kind: "wait", text: "Před zápasem", order: 2 };
    if (now - kickoff > 3.5 * 3600e3) return { kind: "done", text: "Skončil?", order: 3 };
    return { kind: "started", text: "Zahájen?", order: 1.5 };
  };

  /* ---------- Drobnosti UI ---------- */
  const app = $("#app");
  const toastEl = $("#toast");
  let toastTimer = 0;
  const toast = (message, kind = "") => {
    toastEl.textContent = message;
    toastEl.classList.toggle("is-error", kind === "error");
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, kind === "error" ? 7000 : 4500);
  };

  const openExternal = (url) => {
    if (!/^https?:\/\//i.test(url || "")) return;
    if (desktop) desktop.openExternal(url);
    else window.open(url, "_blank", "noopener");
  };

  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[data-external], a[href^='http']");
    if (!a) return;
    e.preventDefault();
    openExternal(a.getAttribute("href"));
  });

  /**
   * Dlaždice se statistikou. `extra`: icon (název ikony Lucide), bar (pole { w: šířka v %, cls: is-win|is-loss|is-void|is-good|is-warn|is-bad }),
   * note (HTML pod tím, vkládá se jen z hodnot, které už prošly přes esc()).
   */
  const stat = (value, label, cls = "", extra = {}) => `<div class="stat ${cls}">
    ${extra.icon ? `<i class="stat__icon" data-lucide="${extra.icon}"></i>` : ""}
    <div class="stat__value">${esc(value)}</div><div class="stat__label" title="${esc(label)}">${esc(label)}</div>
    ${extra.bar ? `<div class="stat__bar">${extra.bar.map((p) => `<i class="${p.cls}" style="width:${Math.max(0, Math.min(100, p.w))}%"></i>`).join("")}</div>` : ""}
    ${extra.note ? `<div class="stat__note">${extra.note}</div>` : ""}</div>`;

  /* ---------- Navigace ---------- */
  const VIEWS = ["overview", "live", "tickets", "evaluation", "analysis", "history"];
  const showView = (view) => {
    if (!VIEWS.includes(view)) view = "overview";
    app.dataset.view = view;
    $$(".nav__link").forEach((l) => {
      const active = l.dataset.view === view;
      l.classList.toggle("is-active", active);
      if (active) l.setAttribute("aria-current", "page");
      else l.removeAttribute("aria-current");
    });
    $("#main").scrollTop = 0;
    window.scrollTo(0, 0);
    try { sessionStorage.setItem("tips:view", view); } catch { /* bez úložiště */ }
    if (view === "history") loadHistory();
    if (view === "live") startLive();
    else stopLive();
    if (view === "analysis") loadAnalysis();
    if (view === "tickets") loadTickets();
    if (view === "evaluation") loadEvaluation();
    renderCats();
  };

  $$(".nav__link").forEach((link) => {
    link.title = link.textContent.trim();
    link.addEventListener("click", (e) => {
      e.preventDefault();
      showView(link.dataset.view);
    });
  });
  $(".brand").addEventListener("click", (e) => {
    e.preventDefault();
    showView("overview");
  });

  /* ---------- Hledání (Ctrl + K) ---------- */
  const search = $("#search");
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });
  search.addEventListener("input", () => {
    state.query = norm(search.value.trim());
    renderTips();
    renderHistory();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      search.value = "";
      search.dispatchEvent(new Event("input"));
      e.stopPropagation();
    }
  });

  const matchesQuery = (t) => {
    if (!state.query) return true;
    const hay = norm(`${t.matchName} ${t.league} ${t.leagueShort} ${t.tipLabel} ${t.sources.join(" ")}`);
    return state.query.split(/\s+/).every((w) => hay.includes(w));
  };

  /* ---------- Řazení ---------- */
  const OUTCOME_ORDER = { win: 1, loss: 2, void: 3 };
  const TIP_SORT = {
    time: (t) => Date.parse(t.kickoff),
    match: (t) => t.matchName,
    league: (t) => t.league,
    tip: (t) => t.tipLabel,
    prob: (t) => t.probability,
    odds: (t) => t.odds,
    value: valueOf,
    source: (t) => t.sources.join(" + "),
    status: (t) => matchState(t).order,
  };
  const HIST_SORT = {
    ...TIP_SORT,
    score: (t) => (t.homeScore !== null && t.awayScore !== null ? t.homeScore * 100 + t.awayScore : null),
    outcome: (t) => OUTCOME_ORDER[t.outcome] ?? null,
  };
  const DESC_FIRST = new Set(["prob", "odds", "value", "score"]);

  const sortList = (list, table, { key, dir }) => {
    const value = table[key] || table.time;
    const sign = dir === "desc" ? -1 : 1;
    return list.slice().sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const nx = x === null || x === undefined;
      const ny = y === null || y === undefined;
      if (nx || ny) {
        if (nx && ny) return 0;
        return nx ? 1 : -1; // chybějící hodnoty vždy na konec
      }
      const diff = typeof x === "string" ? x.localeCompare(y, "cs") : x - y;
      if (diff) return diff * sign;
      return Date.parse(a.kickoff) - Date.parse(b.kickoff) || b.probability - a.probability;
    });
  };

  const markSort = (table, attr, sort) => {
    $$(`th`, table).forEach((th) => {
      const btn = $(`button[${attr}]`, th);
      if (!btn) return;
      if (btn.getAttribute(attr) === sort.key) th.setAttribute("aria-sort", sort.dir === "asc" ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    });
  };

  const bindSort = (table, attr, getSort, setSort, rerender) => {
    table.addEventListener("click", (e) => {
      const btn = e.target.closest(`button[${attr}]`);
      if (!btn) return;
      const key = btn.getAttribute(attr);
      const cur = getSort();
      const first = DESC_FIRST.has(key) || (attr === "data-hsort" && key === "time") ? "desc" : "asc";
      setSort(cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: first });
      rerender();
    });
  };

  /* ---------- Tipy: filtry ---------- */
  const applyDayFilter = (t, today, tomorrow) => {
    switch (state.day) {
      case "today": return t.day === today;
      case "tomorrow": return t.day === tomorrow;
      default: return true;
    }
  };

  const computeVisible = () => {
    const tips = state.payload?.tips || [];
    const now = Date.now();
    const today = localDay(new Date(now));
    const tomorrow = nextDay(today);
    const list = tips.filter((t) => {
      if (!applyDayFilter(t, today, tomorrow)) return false;
      if (state.league && t.leagueKey !== state.league) return false;
      if (state.live) {
        const kind = matchState(t, now).kind;
        const playing = kind === "live" || kind === "started";
        if (state.live === "only" ? !playing : kind !== "wait") return false;   // „Nadcházející“ = jen zápasy, které ještě nezačaly
      }
      return matchesQuery(t);
    });
    return sortList(list, TIP_SORT, state.sort);
  };

  $$("#day-control [data-day]").forEach((b) => {
    b.addEventListener("click", () => {
      state.day = b.dataset.day;
      store.set("day", state.day);
      renderTips();
    });
  });
  $$("#live-control [data-live]").forEach((b) => {
    b.addEventListener("click", () => {
      state.live = state.live === b.dataset.live ? "" : b.dataset.live;   // druhé kliknutí filtr vypne
      store.set("live", state.live);
      renderTips();
    });
  });
  bindSort($("#tips-table"), "data-sort", () => state.sort, (s) => { state.sort = s; store.set("sort", s); }, () => renderTips());

  /* ---------- Tipy: tabulka ---------- */
  const tipsBody = $("#tips-body");

  /** Název zápasu; u živého zápasu blikající červená tečka, u rozehraného i skončeného aktuální skóre. */
  const matchHtml = (t, ms) => {
    const score = fmtScore(t);
    const live = ms.kind === "live" || ms.kind === "started";
    return `${live ? '<i class="live-dot" title="Právě se hraje"></i>' : ""}${esc(t.matchName)}${score && (live || ms.kind === "done") ? ` <b class="score${live ? " score--live" : ""}">${esc(score)}</b>` : ""}`;
  };

  const rowHtml = (t, now) => {
    const ms = matchState(t, now);
    const key = tipUid(t);
    const selected = key === state.selected;
    return `<tr class="trow is-${t.probClass}${selected ? " is-selected" : ""}${ms.kind === "done" ? " is-done" : ""}${ms.kind === "live" || ms.kind === "started" ? " is-live" : ""}" data-key="${esc(key)}" tabindex="${selected ? 0 : -1}" aria-selected="${selected}">
      <td class="c-time">${esc(fmtKickoff(t.kickoff))}</td>
      <td class="c-match"><span class="match">${matchHtml(t, ms)}</span></td>
      <td class="c-tip">${esc(t.tipLabel)}</td>
      <td class="c-prob"><span class="pill pill--${t.probClass}"${t.probSource !== "Scores24" ? ` title="Scores24 procento neuvedl – hodnota z ${esc(t.probSource)}"` : ""}>${esc(fmtPct(t.probability))}</span></td>
      <td class="c-odds"${t.oddsEstimated ? ' title="Odhad z pravděpodobnosti – zdroj kurz neuvedl"' : ""}>${esc(fmtOdds(t))}</td>
      <td class="c-value ${valueOf(t) === null ? "" : valueOf(t) > 0 ? "is-pos" : valueOf(t) < 0 ? "is-neg" : ""}">${esc(fmtValue(valueOf(t)))}</td>
    </tr>`;
  };

  const emptyTipsText = () => {
    const p = state.payload;
    const total = p?.tips.length || 0;
    if (state.busy && !total) return "Stahuji tipy…";
    if (!total) {
      if (!p || !p.updatedAt) return state.error || (p && !p.success) ? "Tipy se nepodařilo načíst – viz upozornění nahoře." : "Zatím nejsou stažené žádné tipy. Klikni na „Obnovit tipy“.";
      return `Zdroje teď neobsahují žádný zápas, který splňuje filtry (nad ${state.limits.minProbability} %, kurz alespoň ${nf2.format(state.limits.minOdds)}).`;
    }
    if (state.live === "only") return "Právě se nehraje žádný zápas z tipů. Druhé kliknutí na „Živě“ filtr vypne.";
    if (state.live === "hide") return "Žádný nadcházející zápas – všechny už začaly nebo skončily. Druhé kliknutí na „Nadcházející“ filtr vypne.";
    return `Výběru neodpovídá žádný tip (celkem ${total}). Zkus jiný den, nebo vypni filtry.`;
  };

  function renderTips() {
    state.visible = computeVisible();
    const keys = state.visible.map(tipUid);
    if (!keys.includes(state.selected)) state.selected = keys[0] ?? null;

    const hadFocus = tipsBody.contains(document.activeElement);
    const now = Date.now();
    tipsBody.innerHTML = state.visible.map((t) => rowHtml(t, now)).join("");
    if (hadFocus && state.selected) $(`tr[tabindex="0"]`, tipsBody)?.focus({ preventScroll: true });
    if (state.visible.length && !$(`tr[tabindex="0"]`, tipsBody)) tipsBody.firstElementChild.tabIndex = 0;

    const empty = $("#tips-empty");
    empty.hidden = state.visible.length > 0;
    empty.textContent = state.visible.length ? "" : emptyTipsText();
    $("#tips-table").hidden = state.visible.length === 0;

    $$("#day-control [data-day]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.day === state.day)));
    $$("#live-control [data-live]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.live === state.live)));
    markSort($("#tips-table"), "data-sort", state.sort);

    const p = state.payload;
    const total = p?.tips.length || 0;
    $("#tips-note").textContent = p && p.updatedLabel
      ? `${state.visible.length} z ${total} · aktualizováno ${p.updatedLabel}`
      : (total ? `${state.visible.length} z ${total}` : "");

    renderDetail();
    renderCats();
  }

  const selectTip = (key, { focus = false } = {}) => {
    if (key === state.selected && !focus) return;
    state.selected = key;
    $$("tr", tipsBody).forEach((tr) => {
      const on = tr.dataset.key === key;
      tr.classList.toggle("is-selected", on);
      tr.tabIndex = on ? 0 : -1;
      tr.setAttribute("aria-selected", String(on));
      if (on && focus) { tr.focus({ preventScroll: true }); tr.scrollIntoView({ block: "nearest" }); }
    });
    renderDetail();
  };

  const tipByKey = (key) => state.visible.find((t) => tipUid(t) === key);

  const bindRows = (body, onSelect, onOpen) => {
    body.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-key]");
      if (tr) onSelect(tr.dataset.key);
    });
    body.addEventListener("dblclick", (e) => {
      const tr = e.target.closest("tr[data-key]");
      if (tr) onOpen(tr.dataset.key);
    });
    body.addEventListener("keydown", (e) => {
      const tr = e.target.closest("tr[data-key]");
      if (!tr) return;
      const rows = $$("tr[data-key]", body);
      const i = rows.indexOf(tr);
      let next = null;
      if (e.key === "ArrowDown") next = rows[Math.min(rows.length - 1, i + 1)];
      else if (e.key === "ArrowUp") next = rows[Math.max(0, i - 1)];
      else if (e.key === "Home") next = rows[0];
      else if (e.key === "End") next = rows[rows.length - 1];
      else if (e.key === "Enter") { e.preventDefault(); onOpen(tr.dataset.key); return; }
      if (next) {
        e.preventDefault();
        onSelect(next.dataset.key, { focus: true });
      }
    });
  };

  bindRows(
    tipsBody,
    (key, opts) => selectTip(key, opts),
    (key) => { const t = tipByKey(key); if (t) openExternal(t.url || t.sofascoreUrl); },
  );

  /* ---------- Detail tipu ---------- */
  const detailEl = $("#detail");
  const detailMatch = $("#detail-match");

  /* ---------- Forma, H2H a absence v detailu tipu (SofaScore) ---------- */
  const detailStats = new Map(); // sofascoreId → { loading } | { data } | { error }

  const formChips = (form) => form.split(" ").reverse() // nejnovější vpravo
    .map((r) => `<i class="fchip fchip--${r}" title="${r === "V" ? "výhra" : r === "R" ? "remíza" : "prohra"}">${esc(r)}</i>`).join("");

  const teamFormRow = (name, f, venueLabel, venue) => {
    if (!f) return "";
    const goals = f.goly_na_zapas ? `Ø ${nf1.format(f.goly_na_zapas.dal)} : ${nf1.format(f.goly_na_zapas.obdrzel)} gólu` : "";
    const where = venue ? `${venueLabel} ${venue.V} V · ${venue.R} R · ${venue.P} P` : "";
    const last = (f.posledni_zapasy || []).map((x) => `• ${x}`).join("\n");
    return `<div class="dform" title="${esc(last)}"><span class="dform__team">${esc(name)}</span><span class="dform__chips">${formChips(f.forma)}</span>
      <span class="dform__meta">${esc([goals, where].filter(Boolean).join(" · "))}</span></div>`;
  };

  /** Prstencový koláč: `pct` % výseče barvy `cls` (is-over / is-yes), ve středu procenta. */
  const donut = (pct, cls) => {
    const r = 20;
    const c = 2 * Math.PI * r;
    return `<svg class="donut ${cls}" viewBox="0 0 52 52" aria-hidden="true"><circle class="donut__bg" cx="26" cy="26" r="${r}"/>
      <circle class="donut__fg" cx="26" cy="26" r="${r}" stroke-dasharray="${((pct / 100) * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 26 26)"/>
      <text x="26" y="30.5" text-anchor="middle">${Math.round(pct)} %</text></svg>`;
  };

  /** Góly v posledních zápasech obou týmů: více / méně než 1,5, 2,5 a 3,5 gólu a oba týmy skórovaly (koláče z Forebetu, jinak ze SofaScore). */
  function goalChartsHtml(t, ch) {
    if (!ch || !ch.home || !ch.away) return "";
    const cell = (s, key, cls) => `<div class="dgoals__cell">${donut(s[key], cls)}</div>`;
    const rows = [["over15", "1,5"], ["over25", "2,5"], ["over35", "3,5"]].map(([key, label]) => `<div class="dgoals__row">
      ${cell(ch.home, key, "is-over")}<div class="dgoals__mid"><b>${label}</b><small>gólu</small></div>${cell(ch.away, key, "is-over")}</div>`).join("");
    const btts = Number.isFinite(ch.home.btts) && Number.isFinite(ch.away.btts)
      ? `<div class="dgoals__row dgoals__row--btts">${cell(ch.home, "btts", "is-yes")}<div class="dgoals__mid"><small>oba týmy<br>skórovaly</small></div>${cell(ch.away, "btts", "is-yes")}</div>` : "";
    return `<div class="dstats__title">${ch.n ? `Posledních ${ch.n} zápasů` : "Poslední zápasy"} <small>góly v zápase, podle ${esc(ch.zdroj)}</small></div>
      <div class="dgoals"><div class="dgoals__head"><span>${esc(t.home)}</span><span>${esc(t.away)}</span></div>${rows}${btts}</div>`;
  }

  function detailStatsBody(t, st, charts) {
    const parts = [];
    parts.push(`<div class="dstats__title">Forma <small>posledních 5 zápasů, nejnovější vpravo</small></div>`
      + (teamFormRow(t.home, st.forma_domaci, "doma", st.forma_domaci && st.forma_domaci.doma) || '<p class="dstats__none">Forma domácích není k dispozici.</p>')
      + (teamFormRow(t.away, st.forma_hoste, "venku", st.forma_hoste && st.forma_hoste.venku) || '<p class="dstats__none">Forma hostů není k dispozici.</p>'));
    const h = st.h2h;
    if (h && h.zapasu) {
      const total = h.domaci_vyhry + h.remizy + h.hoste_vyhry;
      const w = (n) => `${total ? (100 * n) / total : 0}%`;
      const extra = [h.goly_na_zapas !== undefined ? `Ø ${nf1.format(h.goly_na_zapas)} gólu` : "", h.oba_skorovaly !== undefined ? `oba skórovali ${h.oba_skorovaly}×` : ""].filter(Boolean).join(" · ");
      parts.push(`<div class="dstats__title">Vzájemné zápasy <small>${h.zapasu} ${h.zapasu === 1 ? "zápas" : h.zapasu < 5 ? "zápasy" : "zápasů"}</small></div>
        <div class="dh2h" title="${esc((h.posledni || []).join("\n"))}"><div class="dh2h__bar"><i class="is-home" style="width:${w(h.domaci_vyhry)}"></i><i class="is-draw" style="width:${w(h.remizy)}"></i><i class="is-away" style="width:${w(h.hoste_vyhry)}"></i></div>
        <div class="dh2h__legend"><span>${esc(t.home)} ${h.domaci_vyhry}</span><span>remíz ${h.remizy}</span><span>${esc(t.away)} ${h.hoste_vyhry}</span></div>${extra ? `<div class="dh2h__extra">${esc(extra)}</div>` : ""}</div>`);
    } else if (h) {
      parts.push('<div class="dstats__title">Vzájemné zápasy</div><p class="dstats__none">Dřív spolu nehráli (nebo data nejsou).</p>');
    }
    parts.push(goalChartsHtml(t, charts));
    const z = st.zraneni;
    if (z) {
      const side = (name, list) => `<div class="dmiss__row"><b>${esc(name)}</b><span>${list.length ? esc(list.join(" · ")) : "bez hlášených absencí"}</span></div>`;
      parts.push(`<div class="dstats__title">Absence <small>podle SofaScore, mohou být neúplné</small></div><div class="dmiss">${side(t.home, z.domaci)}${side(t.away, z.hoste)}</div>`);
    }
    return parts.join("");
  }

  /** Obsah sekce se statistikami: z mezipaměti, nebo „načítám“ (a načtení se spustí). */
  function detailStatsHtml(t) {
    if (!desktop) return "";
    if (!t.sofascoreId) return '<p class="dstats__none">Zápas není spárovaný se SofaScore, statistiky nejsou.</p>';
    const c = detailStats.get(t.sofascoreId);
    if (!c) { loadDetailStats(t); return '<p class="dstats__none">Načítám formu a vzájemné zápasy…</p>'; }
    if (c.loading) return '<p class="dstats__none">Načítám formu a vzájemné zápasy…</p>';
    if (c.error) return `<p class="dstats__none">Statistiky se nepodařilo načíst (${esc(c.error)}).</p>`;
    return detailStatsBody(t, c.data, c.charts);
  }

  async function loadDetailStats(t) {
    detailStats.set(t.sofascoreId, { loading: true });
    let entry;
    try {
      const res = await desktop.tips.stats(t.sofascoreId, t.forebetUrl);
      entry = res.ok && res.data.complete ? { data: res.data.stats, charts: res.data.charts } : { error: res.ok ? "chybí údaje o formě" : res.error };
    } catch (err) {
      entry = { error: err.message || String(err) };
    }
    if (entry.error) detailStats.delete(t.sofascoreId); else detailStats.set(t.sofascoreId, entry); // při chybě se příště zkusí znovu
    $$(`.dstats[data-sofa="${t.sofascoreId}"]`).forEach((box) => {
      box.innerHTML = entry.error ? `<p class="dstats__none">Statistiky se nepodařilo načíst (${esc(entry.error)}).</p>` : detailStatsBody(t, entry.data, entry.charts);
    });
  }

  /** Detail tipu `t` v kartě (`box` = obsah, `matchEl` = název zápasu v záhlaví); stejný pro Přehled i Tikety. */
  function fillDetail(box, matchEl, t, emptyHtml) {
    box._tip = t || null;
    matchEl.textContent = t ? t.matchName : "";
    matchEl.title = t ? t.matchName : "";
    if (!t) { box.innerHTML = emptyHtml; return; }
    const now = Date.now();
    const ms = matchState(t, now);
    const kickoff = Date.parse(t.kickoff);
    const when = `${fmtKickoff(t.kickoff)} · ${ms.kind === "wait" ? untilText(kickoff - now) : ms.text}`;
    const facts = [];
    if (t.outcome) {
      const names = { win: "Výhra", loss: "Prohra", void: "Vráceno" };
      facts.push(["Výsledek", `${names[t.outcome] || t.outcome}${t.outcomeSource && t.outcomeSource !== "manual" ? " (automaticky)" : ""}`]);
    }
    const hi = state.limits.highProbability;
    const val = valueOf(t);
    const kpis = [
      stat(fmtPct(t.probability), "Pravděpodobnost", "stat--accent"),
      stat(t.odds ? nf2.format(t.odds) : "–", t.oddsEstimated ? "Kurz (odhad)" : "Kurz"),
      stat(fmtValue(val), "Value", val === null ? "" : val > 0 ? "stat--pos" : val < 0 ? "stat--neg" : ""),
    ].join("");
    const links = [["scores24", "Scores24", t.url], ["forebet", "Forebet", t.forebetUrl], ["sofascore", "SofaScore", t.sofascoreUrl]]
      .map(([act, name, url]) => `<button class="btn btn--ghost btn--sm" type="button" data-act="${act}"${url ? "" : ` disabled title="${name}: zápas nenalezen"`}><i data-lucide="external-link"></i>${name}</button>`).join("");
    box.innerHTML = `
      <div class="detail__when">Začátek <b>${esc(when)}</b></div>
      <div class="detail__tip">${esc(t.tipLabel)}<span class="detail__state is-${t.probClass}">${t.probClass === "high" ? `NAD ${hi} %` : `${state.limits.minProbability}–${hi} %`}</span></div>
      ${t.reason ? `<p class="detail__why">${esc(t.reason)}</p>` : ""}
      <div class="stat-row stat-row--detail">${kpis}</div>
      ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}
      <div class="detail__actions">${links}</div>
      <div class="dstats" data-sofa="${t.sofascoreId || ""}">${detailStatsHtml(t)}</div>`;
    renderIcons();
  }

  function renderDetail() {
    const t = tipByKey(state.selected);
    fillDetail(detailEl, detailMatch, t, `<p class="detail__empty">${state.visible.length ? "Vyber tip v tabulce." : "Žádný tip k zobrazení."}<br>Dvojklik na řádek otevře zápas na Scores24.</p>`);
  }

  /** Tlačítka s odkazy v detailu (Přehled i Tikety): odkaz podle tipu, který je v kartě právě zobrazený. */
  const onDetailLink = (e) => {
    const btn = e.target.closest("button[data-act]");
    const t = e.currentTarget._tip;
    if (!btn || !t) return;
    const url = { scores24: t.url, forebet: t.forebetUrl, sofascore: t.sofascoreUrl }[btn.dataset.act];
    if (url) openExternal(url);
  };
  detailEl.addEventListener("click", onDetailLink);

  /* ---------- Upozornění (zdroj selhal, bez internetu…) ---------- */
  const warnEl = $("#warn");
  const warnPop = $("#warn-pop");
  const warnBtn = $("#warn-btn");
  const setWarnOpen = (open) => {
    warnPop.hidden = !open;
    warnBtn.setAttribute("aria-expanded", String(open));
  };
  function renderNotice() {
    const warnings = [];
    if (state.error) warnings.push(`Stahování selhalo: ${state.error}`);
    if (state.payload) warnings.push(...state.payload.warnings);
    if (!desktop) warnings.push("Aplikace neběží v okně Electronu – stahování tipů není k dispozici.");
    const forebetFailed = state.payload?.statuses?.Forebet?.state === "failed";
    warnEl.hidden = warnings.length === 0;
    if (!warnings.length) { setWarnOpen(false); warnPop.innerHTML = ""; return; }
    $("#warn-count").textContent = warnings.length > 1 ? String(warnings.length) : "";
    warnBtn.title = warnings.length === 1 ? warnings[0] : `${warnings.length} upozornění`;
    warnPop.innerHTML = `<ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
      ${forebetFailed && desktop ? '<button class="btn btn--ghost btn--sm" type="button" data-act="verify" title="Otevře okno, ve kterém projdeš ověřením Cloudflare"><i data-lucide="shield-check"></i>Ověřit Forebet</button>' : ""}`;
    renderIcons();
  }

  warnBtn.addEventListener("click", () => setWarnOpen(warnPop.hidden));
  warnPop.addEventListener("click", (e) => { if (e.target.closest("button[data-act='verify']")) { setWarnOpen(false); refresh({ verify: true }); } });
  document.addEventListener("click", (e) => { if (!warnPop.hidden && !warnEl.contains(e.target)) setWarnOpen(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !warnPop.hidden) setWarnOpen(false); });

  const cacheChip = $("#cache-chip");
  function renderChip() {
    const p = state.payload;
    cacheChip.hidden = !(p && p.fromCache && p.updatedAt);
    cacheChip.title = p && !p.success
      ? "Stažení se nepodařilo – zobrazují se poslední uložená data"
      : "Zobrazují se uložená data z poslední aktualizace";
  }

  /* ---------- Stahování ---------- */
  const refreshBtn = $("#refresh");
  const progressText = $("#progress-text");
  const topProgress = $("#topbar-progress");

  const stepsEl = $("#steps");
  const updatedLabel = $("#updated-label");
  const STEPS = ["Scores24", "Forebet", "SofaScore"];

  /** Text průběhu + které zdroje jsou hotové (✓), který se právě stahuje a které čekají. */
  const showProgress = (message) => {
    progressText.textContent = message;
    progressText.title = message;
    const at = STEPS.findIndex((n) => message.startsWith(n));
    if (at >= 0) $$("i", stepsEl).forEach((el, i) => { el.className = i < at ? "is-done" : i === at ? "is-active" : ""; });
  };

  const agoText = (ms) => {
    const min = Math.floor(ms / 60000);
    if (min < 1) return "právě teď";
    if (min < 60) return `před ${min} min`;
    const h = Math.floor(min / 60);
    return h < 24 ? `před ${h} h` : `před ${Math.floor(h / 24)} d`;
  };

  /** „Aktualizováno před 3 min“ v horní liště (jen mimo stahování; přepočítává se každých 30 s). */
  function renderUpdated() {
    const p = state.payload;
    const show = !state.busy && Boolean(p && p.updatedAt);
    updatedLabel.hidden = !show;
    if (!show) return;
    const age = Date.now() - Date.parse(p.updatedAt);
    updatedLabel.textContent = `Aktualizováno ${agoText(age)}`;
    updatedLabel.title = `Poslední stažení: ${p.updatedLabel || p.updatedAt}`;
    updatedLabel.classList.toggle("is-stale", age > 3600e3);
  }

  const setBusy = (busy, message = "") => {
    state.busy = busy;
    app.classList.toggle("is-busy", busy);
    refreshBtn.disabled = busy;
    $("#evaluate").disabled = busy;
    $("span", refreshBtn).textContent = busy ? "Stahuji…" : "Obnovit tipy";
    topProgress.hidden = !busy;
    progressText.hidden = !busy;
    stepsEl.hidden = !busy;
    if (busy) $$("i", stepsEl).forEach((el) => { el.className = ""; });
    showProgress(message);
    renderUpdated();
  };

  async function refresh({ verify = false } = {}) {
    if (state.busy || !desktop) return;
    setBusy(true, verify ? "Otevírám Forebet…" : "Připravuji stahování…");
    try {
      const res = await (verify ? desktop.tips.verifyForebet() : desktop.tips.refresh());
      if (res.ok) {
        state.payload = res.data;
        state.error = null;
        if (res.data.success) toast(`Aktualizováno – ${res.data.tips.length} tipů po filtraci.`);
      } else {
        state.error = res.error;
      }
    } catch (err) {
      state.error = err.message || String(err);
    } finally {
      setBusy(false);
    }
    renderAll();
    if (app.dataset.view === "history") loadHistory();
  }
  refreshBtn.addEventListener("click", () => refresh());

  if (desktop) desktop.tips.onProgress((message) => { if (state.busy) showProgress(message); });

  /* ---------- Historie ---------- */
  const histBody = $("#history-body");
  const OUTCOME_VIEW = {
    win: { icon: "circle-check", text: "Výhra" },
    loss: { icon: "circle-x", text: "Prohra" },
    void: { icon: "rotate-ccw", text: "Vráceno" },
  };

  /** Rozsah dnů pro filtr historie: dnes / vybraný den / tento kalendářní měsíc. */
  const historyRange = () => {
    const today = localDay(new Date());
    if (state.range === "today") return { from: today, to: today };
    if (state.range === "yesterday") { const y = shiftDay(today, -1); return { from: y, to: y }; }
    if (state.range === "date") { const d = state.date || today; return { from: d, to: d }; }
    const [y, m] = today.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mm = String(m).padStart(2, "0");
    return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}` };
  };
  const fetchHistory = async (days, range = null) => {
    if (!desktop) return null;
    const res = await desktop.history.list(range || days);
    return res.ok ? res.data : null;
  };

  async function loadHistory() {
    const data = await fetchHistory(null, historyRange());
    if (data) state.history = data;
    renderHistory();
  }
  const statTiles = (s) => {
    const rate = s.hitRate === null ? "–" : `${Math.round(s.hitRate)} %`;
    const profit = s.profit === null ? "–" : fmtSigned(s.profit);
    const roiText = s.roiPct === null ? "bez skutečných kurzů" : `ROI ${s.roiPct > 0 ? "+" : s.roiPct < 0 ? "−" : ""}${nf1.format(Math.abs(s.roiPct))} %`;
    const tone = s.profit > 0 ? "pos" : s.profit < 0 ? "neg" : "muted";
    const rateTone = s.hitRate === null ? "" : s.hitRate >= 60 ? "good" : s.hitRate >= 45 ? "warn" : "bad";
    return {
      rate, profit, roi: roiText, profitCls: s.profit > 0 ? "stat--pos" : s.profit < 0 ? "stat--neg" : "",
      roiChip: `<span class="stat__chip stat__chip--${tone}">${esc(roiText)}</span>`,
      rateCls: rateTone ? `stat--${rateTone}` : "",
      rateBar: s.hitRate === null ? null : [{ w: s.hitRate, cls: `is-${rateTone}` }],
      // výhry / prohry / vrácené jako dělený pruh a barevná legenda
      outcomeBar: s.evaluated ? [{ w: (100 * s.wins) / s.evaluated, cls: "is-win" }, { w: (100 * s.losses) / s.evaluated, cls: "is-loss" }, { w: (100 * s.voids) / s.evaluated, cls: "is-void" }] : null,
      outcomeNote: `<span class="g">${s.wins} V</span><span class="r">${s.losses} P</span><span class="y">${s.voids} vr.</span>`,
    };
  };

  function renderHistory() {
    const h = state.history;
    $$("#hist-range [data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === state.range)));
    const dateEl = $("#hist-date");
    dateEl.hidden = state.range !== "date";
    dateEl.value = state.date || localDay(new Date());
    markSort($("#history-table"), "data-hsort", state.hsort);
    if (!h) {
      $("#history-stats").innerHTML = "";
      histBody.innerHTML = "";
      $("#history-empty").hidden = false;
      $("#history-empty").textContent = desktop ? "Historie se načítá…" : "Historie je dostupná jen v aplikaci.";
        return;
    }
    const s = h.stats;
    const v = statTiles(s);
    // doplňky do prázdných míst dlaždic: čeká / soutěže, očekávaná vs. skutečná úspěšnost, rozpětí kurzů, zisk na tip
    const pending = Math.max(0, s.total - s.evaluated);
    const leagues = new Set(h.tips.map((t) => t.leagueKey)).size;
    const decided = h.tips.filter((t) => t.outcome === "win" || t.outcome === "loss");
    const expected = decided.length ? decided.reduce((a, t) => a + t.probability, 0) / decided.length : null;
    const odds = h.tips.filter((t) => t.odds && !t.oddsEstimated).map((t) => t.odds);
    const span = (txt) => `<span>${esc(txt)}</span>`;
    $("#history-stats").innerHTML = [
      stat(String(s.total), "tipů v období", "stat--accent", {
        icon: "list", bar: s.total ? [{ w: (100 * s.evaluated) / s.total, cls: "is-muted" }] : null,
        note: span(`${pending} čeká na výsledek`) + span(`${leagues} ${leagues === 1 ? "soutěž" : leagues > 0 && leagues < 5 ? "soutěže" : "soutěží"}`),
      }),
      stat(String(s.evaluated), "vyhodnoceno", "", { bar: v.outcomeBar, note: v.outcomeNote }),
      stat(v.rate, "úspěšnost", v.rateCls, { bar: v.rateBar, icon: "target", note: expected === null ? "" : span(`odhad zdrojů ${Math.round(expected)} %`) }),
      stat(s.avgOdds === null ? "–" : nf2.format(s.avgOdds), "průměrný kurz", "", {
        icon: "coins", bar: s.avgOdds ? [{ w: 100 / s.avgOdds, cls: "is-muted" }] : null,
        note: odds.length ? span(`kurz značí ${Math.round(100 / s.avgOdds)} %`) + span(`${nf2.format(Math.min(...odds))}–${nf2.format(Math.max(...odds))}`) : "",
      }),
      stat(v.profit, "zisk (vklad 1)", v.profitCls, { note: v.roiChip + (s.evaluated && s.profit !== null ? span(`${fmtSigned(s.profit / s.evaluated)} na tip`) : ""), icon: "trending-up" }),
    ].join("");
    renderIcons();

    const list = sortList(h.tips.filter((t) => matchesQuery(t) && (!state.league || t.leagueKey === state.league)), HIST_SORT, state.hsort);
    if (!list.some((t) => t.id === state.hselected)) state.hselected = null;
    histBody.innerHTML = list.map((t) => {
      const ov = OUTCOME_VIEW[t.outcome];
      const outcome = ov
        ? `<span class="outcome outcome--${t.outcome}"><i data-lucide="${ov.icon}"></i>${ov.text}</span>`
        : '<span class="outcome outcome--none">—</span>';
      const sel = t.id === state.hselected;
      return `<tr class="trow${t.outcome ? ` is-${t.outcome}` : ""}${sel ? " is-selected" : ""}" data-key="${esc(t.id)}" tabindex="${sel ? 0 : -1}" aria-selected="${sel}">
        <td class="c-time">${esc(fmtKickoff(t.kickoff))}</td>
        <td class="c-match"><span class="match">${esc(t.matchName)}</span></td>
        <td class="c-tip">${esc(t.tipLabel)}</td>
        <td class="c-score">${esc(fmtScore(t) || "–")}</td>
        <td class="c-prob"><span class="pill pill--${t.probClass}">${esc(fmtPct(t.probability))}</span></td>
        <td class="c-odds">${esc(fmtOdds(t))}</td>
        <td class="c-outcome">${outcome}</td></tr>`;
    }).join("");
    if (list.length && !$(`tr[tabindex="0"]`, histBody)) histBody.firstElementChild.tabIndex = 0;
    const empty = $("#history-empty");
    empty.hidden = list.length > 0;
    empty.textContent = h.tips.length ? "Hledání neodpovídá žádný tip." : "V tomto období nejsou žádné tipy.";
    $("#history-table").hidden = list.length === 0;
    renderCats();
    renderIcons();
  }

  const selectHistory = (key, { focus = false } = {}) => {
    const id = Number(key);
    state.hselected = id;
    $$("tr", histBody).forEach((tr) => {
      const on = Number(tr.dataset.key) === id;
      tr.classList.toggle("is-selected", on);
      tr.tabIndex = on ? 0 : -1;
      tr.setAttribute("aria-selected", String(on));
      if (on && focus) { tr.focus({ preventScroll: true }); tr.scrollIntoView({ block: "nearest" }); }
    });
  };
  bindRows(histBody, selectHistory, (key) => {
    const t = state.history?.tips.find((x) => x.id === Number(key));
    if (t) openExternal(t.url || t.sofascoreUrl);
  });
  bindSort($("#history-table"), "data-hsort", () => state.hsort, (s) => { state.hsort = s; store.set("hsort", s); }, () => renderHistory());

  $$("#hist-range [data-range]").forEach((b) => b.addEventListener("click", () => {
    state.range = b.dataset.range;
    store.set("hist-range", state.range);
    loadHistory();
  }));
  $("#hist-date").addEventListener("change", (e) => {
    state.date = e.target.value;
    loadHistory();
  });

  async function evaluateResults() {
    if (state.busy || !desktop) return;
    setBusy(true, "Zjišťuji výsledky zápasů…");
    let res;
    try { res = await desktop.history.evaluate(); } catch (err) { res = { ok: false, error: err.message }; }
    setBusy(false);
    if (res.ok) toast(res.data.message);
    else toast(`Vyhodnocení se nepodařilo: ${res.error}`, "error");
    await loadHistory();
    await loadTicketHistory();
  }
  $("#evaluate").addEventListener("click", evaluateResults);


  /* ---------- Živé zápasy (SofaScore) ---------- */
  const live = { list: [], selected: null, detail: null, timer: 0, error: null, loaded: false };
  const liveListEl = $("#live-list");
  const liveDetailEl = $("#live-detail");

  const tipsOfMatch = (id) => (state.payload?.tips || []).filter((t) => t.sofascoreId === id);

  /** Živé zápasy jen z tipů v Přehledu (spárované přes SofaScore ID). */
  const liveOfOverview = () => {
    const ids = new Set((state.payload?.tips || []).map((t) => t.sofascoreId).filter(Boolean));
    return live.list.filter((m) => ids.has(m.id));
  };

  function renderLiveList() {
    renderCats();
    const shown = liveOfOverview().filter((m) => !state.league || m.leagueKey === state.league);
    $("#live-note").textContent = live.loaded ? `${shown.length} ${shown.length === 1 ? "zápas" : shown.length < 5 && shown.length ? "zápasy" : "zápasů"}` : "";
    if (!shown.length) {
      liveListEl.innerHTML = `<p class="empty">${esc(live.error ? `Živé zápasy se nepodařilo načíst: ${live.error}` : !live.loaded ? "Načítám živé zápasy…"
        : "Právě se nehraje žádný zápas z Přehledu.")}</p>`;
      return;
    }
    let group = "";
    liveListEl.innerHTML = shown.map((m) => {
      const head = m.title;
      const title = head !== group ? `<h3 class="live-group">${esc(head)}</h3>` : "";
      group = head;
      const tips = tipsOfMatch(m.id);
      return `${title}<button type="button" class="live-row${m.id === live.selected ? " is-selected" : ""}" data-id="${m.id}">
        <span class="live-row__min"><i class="live-dot"></i>${esc(m.minute)}</span>
        <span class="live-row__teams"><span>${esc(m.home)}</span><span>${esc(m.away)}</span></span>
        ${tips.length ? `<span class="live-row__tip" title="${esc(tips.map((t) => t.tipLabel).join(", "))}">${esc(tips.map((t) => t.tipLabel).join(", "))}</span>` : "<span></span>"}
        <span class="live-row__score"><span>${m.homeScore}</span><span>${m.awayScore}</span></span></button>`;
    }).join("");
  }

  /** Momentum: nad osou tlak domácích, pod ní hostů; červená čára = aktuální minuta, dole branky. */
  function momentumSvg(graph, incidents) {
    if (!graph.length) return '<p class="empty">Momentum zatím není k dispozici.</p>';
    const W = 300;
    const last = graph[graph.length - 1].m;
    const span = Math.max(90, last);
    const X = (m) => (m / span) * W;
    const maxAbs = Math.max(60, ...graph.map((p) => Math.abs(p.v)));
    const k = 38 / maxAbs;
    const area = (sign) => {
      const pts = graph.map((p) => `${X(p.m).toFixed(1)},${(40 - sign * Math.max(0, sign * p.v) * k).toFixed(1)}`);
      return `M${X(graph[0].m).toFixed(1)},40 L${pts.join(" L")} L${X(last).toFixed(1)},40 Z`;
    };
    const goals = incidents.filter((i) => i.kind === "goal").map((g) =>
      `<circle cx="${X(g.minute).toFixed(1)}" cy="86" r="3.2" fill="#fff" stroke="${g.home ? "#36b5f4" : "#ff6b6b"}" stroke-width="1.2"><title>${g.minute}' ${esc(g.player)}</title></circle>`).join("");
    return `<svg class="momentum" viewBox="0 0 ${W} 92" role="img" aria-label="Momentum zápasu">
      <rect x="0" y="0" width="${W}" height="40" fill="rgba(43,210,107,.10)"/><rect x="0" y="40" width="${W}" height="40" fill="rgba(59,143,240,.12)"/>
      <path d="${area(1)}" fill="rgba(43,210,107,.75)"/><path d="${area(-1)}" fill="rgba(59,143,240,.8)"/>
      <line x1="0" y1="40" x2="${W}" y2="40" stroke="rgba(255,255,255,.25)" stroke-width=".5"/>
      <line x1="${X(45)}" y1="0" x2="${X(45)}" y2="80" stroke="rgba(255,255,255,.18)" stroke-width=".5" stroke-dasharray="2 2"/>
      <line x1="${X(last).toFixed(1)}" y1="0" x2="${X(last).toFixed(1)}" y2="80" stroke="#ff3b3b" stroke-width="1.2"/>${goals}</svg>`;
  }

  function eventsHtml(incidents) {
    if (!incidents.length) return '<p class="empty">Zatím žádné branky ani karty.</p>';
    const text = (i) => {
      if (i.kind === "goal") {
        const score = i.homeScore !== null ? ` (${i.homeScore}:${i.awayScore})` : "";
        return `⚽ ${esc(i.player)}${i.own ? " (vlastní)" : i.penalty ? " (pen.)" : ""}${score}`;
      }
      return `<i class="card-mark card-mark--${i.kind}"></i>${esc(i.player)}`;
    };
    return `<ul class="events">${[...incidents].reverse().map((i) => `<li><span class="ev-home">${i.home ? text(i) : ""}</span><span class="ev-min">${i.minute}'</span><span>${i.home ? "" : text(i)}</span></li>`).join("")}</ul>`;
  }

  function statsHtml(stats) {
    if (!stats.length) return '<p class="empty">Statistiky zatím nejsou k dispozici.</p>';
    return stats.map((st) => {
      const h = st.homeValue ?? 0;
      const a = st.awayValue ?? 0;
      const total = h + a || 1;
      return `<div class="stat-line"><div class="stat-line__caption"><span>${esc(st.home)}</span><b>${esc(st.label)}</b><span>${esc(st.away)}</span></div>
        <div class="stat-line__bar"><i class="h" style="flex:${h / total} 1 0"></i><i class="a" style="flex:${a / total} 1 0"></i></div></div>`;
    }).join("");
  }

  function renderLiveDetail() {
    const m = live.list.find((x) => x.id === live.selected);
    $("#live-open").hidden = !m;
    if (!m) {
      liveDetailEl.innerHTML = '<p class="detail__empty">Vyber zápas vlevo – ukážu momentum, střely na hřišti, branky a statistiky ze SofaScore.</p>';
      return;
    }
    $("#live-open").dataset.url = m.url;
    const d = live.detail && live.detail.id === m.id ? live.detail : null;
    const head = `<div class="live-head"><div class="live-head__team">${esc(m.home)}</div><div class="live-head__score">${m.homeScore} : ${m.awayScore}</div><div class="live-head__team">${esc(m.away)}</div>
      <div class="live-head__meta"><i class="live-dot"></i><span>${esc(m.minute)}</span><span>${esc(m.title)}</span></div></div>`;
    if (!d) {
      liveDetailEl.innerHTML = `${head}<p class="empty">${esc(live.detailError || "Načítám podrobnosti…")}</p>`;
      return;
    }
    liveDetailEl.innerHTML = `${head}
      <div class="live-box"><div class="live-box__title">Momentum zápasu</div>${momentumSvg(d.graph, d.incidents)}
        <div class="momentum-teams"><span>▲ ${esc(m.home)}</span><span>▼ ${esc(m.away)}</span></div></div>
      <div class="live-box"><div class="live-box__title">Branky a karty</div>${eventsHtml(d.incidents)}</div>
      <div class="live-box"><div class="live-box__title">Statistiky</div>${statsHtml(d.stats)}</div>`;
    renderIcons();
  }

  async function loadLiveDetail() {
    const id = live.selected;
    if (!desktop || id === null) return;
    const res = await desktop.live.detail(id);
    if (id !== live.selected) return; // mezitím vybrán jiný zápas
    if (res.ok) { live.detail = { id, ...res.data }; live.detailError = null; } else live.detailError = res.error;
    renderLiveDetail();
  }

  async function loadLiveList() {
    if (!desktop) return;
    const res = await desktop.live.list();
    live.loaded = true;
    if (res.ok) { live.list = res.data; live.error = null; } else live.error = res.error;
    if (live.selected !== null && !live.list.some((m) => m.id === live.selected)) { live.selected = null; live.detail = null; }
    renderLiveList();
    renderLiveDetail();
  }

  function startLive() {
    stopLive();
    renderLiveList();
    renderLiveDetail();
    loadLiveList().then(loadLiveDetail);
    live.timer = setInterval(() => { if (awake()) loadLiveList().then(loadLiveDetail); }, 30e3);
  }
  function stopLive() { clearInterval(live.timer); live.timer = 0; }

  liveListEl.addEventListener("click", (e) => {
    const row = e.target.closest(".live-row");
    if (!row) return;
    live.selected = Number(row.dataset.id);
    live.detail = null;
    live.detailError = null;
    renderLiveList();
    renderLiveDetail();
    loadLiveDetail();
  });
  $("#live-open").addEventListener("click", (e) => openExternal(e.currentTarget.dataset.url));


  /* ---------- Levý sloupec: soutěže jako filtr ---------- */
  const catsEl = $("#cats");
  const badgeOf = (short) => {
    const words = short.split(/\s+/);
    return (words.length > 1 ? words[0][0] + words[1][0] : short.slice(0, 2)).toUpperCase();
  };

  // Levý sloupec: ligy se jmenují podle zemí (Francie, Itálie…), evropské poháry zůstávají pod svým názvem.
  // Vlajky (flag-icons, MIT; soubory ve vendor/flags): emoji vlajky Windows neukazuje. Poháry nejsou země, ty zůstávají se zkratkou.
  const COUNTRY_FLAG = { EPL: "gb-eng", LALIGA: "es", SERIEA: "it", BUNDESLIGA: "de", LIGUE1: "fr", EREDIVISIE: "nl", PORTUGAL: "pt", BELGIE: "be", TURECKO: "tr", SKOTSKO: "gb-sct", CESKO: "cz" };
  const leagueLabel = (l) => (String(l.nameCs || "").includes(" – ") ? l.nameCs.split(" – ")[0] : l.short);

  /** Počty zápasů podle soutěže pro právě otevřenou záložku. */
  function leagueCounts() {
    const view = app.dataset.view;
    const counts = {};
    let list = [];
    if (view === "live") list = liveOfOverview();
    else if (view === "history") list = (state.history?.tips || []).filter(matchesQuery);
    else {
      const today = localDay(new Date());
      const tomorrow = nextDay(today);
      list = (state.payload?.tips || []).filter((t) => applyDayFilter(t, today, tomorrow) && matchesQuery(t));
    }
    for (const x of list) counts[x.leagueKey] = (counts[x.leagueKey] || 0) + 1;
    return { counts, total: list.length };
  }

  function renderCats() {
    if (!state.leagues.length) { catsEl.innerHTML = ""; return; }
    const { counts, total } = leagueCounts();
    const item = (key, name, badge, count, title = name) => `<button type="button" class="cat${state.league === key ? " is-active" : ""}${count ? "" : " is-empty"}" data-league="${esc(key)}" title="${esc(title)}" aria-pressed="${state.league === key}">
      ${badge.startsWith("flag:") ? `<span class="cat__badge cat__badge--flag"><img src="vendor/flags/${esc(badge.slice(5))}.svg" alt="" width="26" height="26"></span>` : `<span class="cat__badge">${esc(badge)}</span>`}<span class="cat__name">${esc(name)}</span><span class="cat__count">${count}</span></button>`;
    catsEl.innerHTML = `<div class="cats__title">Soutěže</div>${item("", "Všechny soutěže", "★", total)}${state.leagues.map((l) => item(l.key, leagueLabel(l), COUNTRY_FLAG[l.key] ? `flag:${COUNTRY_FLAG[l.key]}` : badgeOf(l.short), counts[l.key] || 0, l.nameCs || l.short)).join("")}`;
  }

  catsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".cat");
    if (!btn) return;
    state.league = btn.dataset.league;
    store.set("league", state.league);
    renderTips();
    renderHistory();
    renderLiveList();
  });



  /* ---------- Tikety (Gemini) ---------- */
  const tk = {
    day: ["today", "tomorrow"].includes(store.get("tk-day")) ? store.get("tk-day") : "today",
    result: store.get("tk-result2"),   // naposledy vytvořené tikety (zůstanou i po restartu; ukážou se jen u dne, pro který vznikly)
    busy: false, step: "", startedAt: 0, timer: null,
    selected: null,                    // tipId zápasu, jehož detail je vpravo
  };
  const CERTAINTY_CS = { good: "Vysoká jistota", ok: "Střední jistota", risky: "Nižší jistota" };
  const TK_NOTE = $("#tk-note").textContent;
  const kickoffShort = (iso) => fmtKickoff(iso);

  const busyText = () => `${tk.step || "Připravuji tikety…"} (${Math.round((Date.now() - tk.startedAt) / 1000)} s)`;
  const tickBusy = () => { const el = $("#tk-busy-text"); if (el) el.textContent = busyText(); };

  /** Zápas mimo tikety s doplněným id tipu: starší výsledky ho neměly uložené, tak se najde v Přehledu podle názvu zápasu a tipu. */
  const withTipId = (o) => {
    if (Number.isFinite(o.tipId)) return o;
    const t = (state.payload?.tips || []).find((x) => x.matchName === o.matchName && x.tipLabel === o.tipLabel);
    return t ? { ...o, tipId: t.id } : o;
  };

  /** Seznam zápasů, které skončily mimo tikety, každý s důvodem (rozbalovací). */
  const omittedHtml = (r) => (r && r.omitted && r.omitted.length
    ? `<section class="tk-omitted tk-wide"><h3 class="tk-omitted__title">Nezařazeno do tiketů: ${r.omitted.length} z ${r.analyzed} zápasů – proč?</h3><ul>${r.omitted.map(withTipId).map((o) => `<li${legAttrs(o)}>
        <span class="tk-omitted__match">${esc(o.matchName)}</span><span class="tk-omitted__tip">${esc(o.tipLabel)} · ${esc(nf2.format(o.odds))}</span><span class="tk-omitted__why">${esc(o.reason)}</span></li>`).join("")}</ul></section>`
    : "");

  /** Den (RRRR-MM-DD), pro který se tikety vytvářejí podle přepínače Dnes / Zítra. */
  const tkTargetDay = () => { const today = localDay(new Date()); return tk.day === "tomorrow" ? nextDay(today) : today; };
  /** Den, pro který uložený výsledek vznikl (starší uložené výsledky: den prvního zápasu). */
  const tkResultDay = (r) => r.forDay || (r.tickets && r.tickets[0] && r.tickets[0].legs[0] ? localDay(new Date(r.tickets[0].legs[0].kickoff)) : null);

  const tkDetailEl = $("#tk-detail");
  const tkDetailMatch = $("#tk-detail-match");

  /** Tip pro detail: nejnovější údaje z posledního stažení, u starších tiketů záloha z údajů uložených u nohy tiketu. */
  function legTip(l) {
    const live = (state.payload?.tips || []).find((x) => x.id === l.tipId);
    if (live) return { ...live, reason: l.reason || "" };
    const [h, a] = l.home && l.away ? [l.home, l.away] : String(l.matchName).split(" – ");
    const scoreParts = /^(\d+):(\d+)$/.test(l.score || "") ? l.score.split(":").map(Number) : [null, null];
    return {
      id: l.tipId, home: h, away: a || "", matchName: l.matchName, league: l.league || "", tipLabel: l.tipLabel, probability: l.probability,
      probClass: l.probability > state.limits.highProbability ? "high" : "mid", probSource: "Scores24", odds: l.odds, oddsEstimated: false,
      kickoff: l.kickoff, status: l.score ? "finished" : "upcoming", homeScore: scoreParts[0], awayScore: scoreParts[1], sofascoreId: l.sofascoreId ?? null,
      url: l.url || "", forebetUrl: l.forebetUrl || "", sofascoreUrl: l.sofascoreUrl || "", outcome: l.outcome ?? null, outcomeSource: null, reason: l.reason || "",
    };
  }

  // zápasy, na které jde v Tiketech kliknout: nohy právě vytvořených tiketů, zápasy mimo ně (Nezařazeno, s důvodem) a nohy uložených tiketů
  const tkLegs = () => [
    ...((tk.result && tk.result.tickets) || []).flatMap((t) => t.legs),
    ...((tk.result && tk.result.omitted) || []).map(withTipId).map((o) => ({ ...o, reason: `Nezařazeno do tiketů: ${o.reason}` })),
    ...((tk.history && tk.history.tickets) || []).flatMap((t) => t.legs),
  ];

  function renderTicketDetail() {
    const leg = tk.selected === null ? null : tkLegs().find((l) => l.tipId === tk.selected);
    fillDetail(tkDetailEl, tkDetailMatch, leg ? legTip(leg) : null, '<p class="detail__empty">Klikni na zápas v tiketu – ukážu statistiky, formu a vzájemné zápasy.</p>');
    $$("#tk-list [data-tip], #tk-history [data-tip]").forEach((el) => el.classList.toggle("is-selected", Number(el.dataset.tip) === tk.selected));
  }

  const onLegPick = (e) => {
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    const el = e.target.closest("[data-tip]");
    if (!el) return;
    e.preventDefault();
    tk.selected = Number(el.dataset.tip);
    renderTicketDetail();
  };
  ["#tk-list", "#tk-history"].forEach((sel) => { $(sel).addEventListener("click", onLegPick); $(sel).addEventListener("keydown", onLegPick); });
  tkDetailEl.addEventListener("click", onDetailLink);

  const legAttrs = (l) => (Number.isFinite(l.tipId) ? ` data-tip="${l.tipId}" tabindex="0" role="button"` : "");

  function renderTickets() {
    renderTicketList();
    renderTicketDetail();
  }

  function renderTicketList() {
    $$("#tk-day [data-tkday]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tkday === tk.day)));
    const note = $("#tk-note");
    const list = $("#tk-list");
    renderTicketHistory();
    const r = tk.result && tkResultDay(tk.result) === tkTargetDay() ? tk.result : null; // včerejší tikety se v „Dnes“ neukazují
    note.textContent = TK_NOTE;
    note.hidden = false;
    if (tk.busy) {
      list.innerHTML = `<div class="tk-busy"><span class="tk-busy__spin" aria-hidden="true"></span><p class="tk-busy__text" id="tk-busy-text">${esc(busyText())}</p>
        <p class="tk-busy__hint">Aplikace stahuje ze SofaScore statistiky zápasů a Gemini je pak vyhodnotí a složí tikety. Obvykle to trvá do dvou minut, mezitím můžeš přepnout na jinou záložku.</p></div>`;
      return;
    }
    if (!r || !r.tickets || !r.tickets.length) {
      const msg = r && r.error ? r.error
        : r && r.tickets ? `Gemini nenašel žádné tipy s dostatečnou oporou ve statistikách, žádný tiket nevznikl.${r.note ? ` ${r.note}` : ""}`
          : "Zatím žádné tikety. Zvol den a klikni na „Vytvořit tikety (AI)“.";
      list.innerHTML = `<p class="empty tk-wide">${esc(msg)}</p>${omittedHtml(r)}`;
      return;
    }
    list.innerHTML = r.tickets.map((t) => `<article class="tk-card">
      <div class="tk-head"><span class="tk-name">${esc(t.name)}</span>${t.verdict ? `<span class="tk-verdict tk-verdict--${t.verdict}">${CERTAINTY_CS[t.verdict] || ""}</span>` : ""}</div>
      <div class="tk-legs">${t.legs.map((l) => `<div class="tk-leg"${legAttrs(l)}><div class="tk-leg__row">
          <span class="tk-leg__match">${esc(l.matchName)}</span><span class="tk-leg__odds">${esc(nf2.format(l.odds))}</span>
          <span class="tk-leg__tip">${esc(l.tipLabel)}</span><span class="tk-leg__meta">${esc(kickoffShort(l.kickoff))} · ${esc(fmtPct(l.probability))}</span>
        </div></div>`).join("")}</div>
      <div class="tk-totals">
        ${stat(nf2.format(t.totalOdds), "celkový kurz", "stat--accent")}
        ${stat(`${nf1.format(t.jointProbability)} %`, "pravděpodobnost (součin)")}
        ${stat(`${t.expectedReturn > 0 ? "+" : t.expectedReturn < 0 ? "−" : ""}${nf1.format(Math.abs(t.expectedReturn))} %`, "odhad výnosu", t.expectedReturn > 0 ? "stat--pos" : t.expectedReturn < 0 ? "stat--neg" : "")}
      </div>
      ${t.summary ? `<p class="tk-summary"><span class="tk-summary__label">Shrnutí</span>${esc(t.summary)}</p>` : ""}
      </article>`).join("") + omittedHtml(r);
    // upozornění se ukážou jen při potížích (chybějící statistiky, zahozené tikety)
    const parts = [];
    if (r.covered < r.analyzed) parts.push(`Statistiky se našly jen k ${r.covered} z ${r.analyzed} zápasů`);
    if (r.rejected) parts.push(`${r.rejected} ${r.rejected === 1 ? "tiket navržený" : "tiketů navržených"} AI porušil${r.rejected === 1 ? "" : "o"} pravidla a ${r.rejected === 1 ? "byl zahozen" : "bylo zahozeno"}`);
    note.textContent = parts.length ? `${parts.join(" · ")}.` : "";
    note.hidden = !parts.length;
    renderIcons();
  }

  const TK_STATUS = { pending: "Čeká", win: "Vyhráno", loss: "Prohráno", void: "Vráceno" };
  const LEG_MARK = { win: "✓", loss: "✗", void: "↺" };

  /** Dřívější tikety s výsledky (podle výsledků jejich tipů) a souhrnem. */
  /** Uložené tikety zvoleného dne (Dnes / Zítra) – jen když se nezobrazují jako čerstvě vytvořené karty; starší dny se tu neukazují. */
  function renderTicketHistory() {
    const el = $("#tk-history");
    const h = tk.history;
    if (!h) { el.innerHTML = ""; return; }
    const target = tkTargetDay();
    const shownNow = tk.result && tkResultDay(tk.result) === target;
    const rows = shownNow ? [] : h.tickets.filter((t) => t.day === target);
    if (!rows.length) { el.innerHTML = ""; return; }
    el.innerHTML = '<h3 class="tk-hist__title">Uložené tikety na tento den</h3>'
      + rows.map((t) => `<div class="tk-hist__row">
        <div class="tk-hist__meta"><strong>${esc(t.name)}</strong><span>${esc(fmtKickoff(t.createdAt))}</span></div>
        <ul class="tk-hist__legs">${t.legs.map((l) => `<li class="is-${l.outcome || "pending"}"${legAttrs(l)}><i>${LEG_MARK[l.outcome] || "…"}</i><span>${esc(l.matchName)}</span><em>${esc(l.tipLabel)} · ${esc(nf2.format(l.odds))}</em></li>`).join("")}</ul>
        <div class="tk-hist__odds">${esc(nf2.format(t.totalOdds))}</div>
        <span class="tk-hist__status tk-hist__status--${t.status}">${TK_STATUS[t.status]}</span></div>`).join("");
  }

  async function loadTicketHistory() {
    if (!desktop) return;
    const res = await desktop.tickets.history();
    if (res.ok) { tk.history = res.data; renderTicketHistory(); renderTicketDetail(); renderEvaluation(); }
  }

  /* ---------- Vyhodnocení: uložené tikety s výsledky ---------- */
  const ev = { range: ["today", "yesterday", "week", "all"].includes(store.get("ev-range")) ? store.get("ev-range") : "all" };

  /** Uložené tikety za zvolené období (podle dne zápasů). */
  function evTickets() {
    const all = (tk.history && tk.history.tickets) || [];
    const today = localDay(new Date());
    if (ev.range === "today") return all.filter((t) => t.day === today);
    if (ev.range === "yesterday") return all.filter((t) => t.day === shiftDay(today, -1));
    if (ev.range === "week") return all.filter((t) => t.day >= shiftDay(today, -6) && t.day <= today);
    return all;
  }

  const fmtProfit = (p) => (p === null ? "–" : `${p > 0 ? "+" : p < 0 ? "−" : ""}${nf2.format(Math.abs(p))}`);
  const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

  function evStatsHtml(list) {
    const n = (status) => list.filter((t) => t.status === status).length;
    const [win, loss, voided, pending] = [n("win"), n("loss"), n("void"), n("pending")];
    const decided = win + loss;
    const settled = win + loss + voided;
    const profit = list.filter((t) => t.profit !== null).reduce((s, t) => s + t.profit, 0);
    const rate = decided ? (100 * win) / decided : null;
    const tone = rate === null ? "" : rate >= 60 ? "good" : rate >= 45 ? "warn" : "bad";
    const roi = decided ? (100 * list.filter((t) => t.status === "win" || t.status === "loss").reduce((s, t) => s + t.profit, 0)) / decided : null;
    const roiText = roi === null ? "bez vyhodnocených" : `ROI ${roi > 0 ? "+" : roi < 0 ? "−" : ""}${nf1.format(Math.abs(roi))} %`;
    const span = (txt) => `<span>${esc(txt)}</span>`;
    const expected = mean(list.filter((t) => t.status === "win" || t.status === "loss").map((t) => t.jointProbability));
    return [
      stat(String(list.length), "tiketů", "stat--accent", { icon: "ticket", bar: list.length ? [{ w: (100 * settled) / list.length, cls: "is-muted" }] : null, note: span(`${pending} čeká na výsledek`) }),
      stat(String(win), "vyhráno", "", {
        bar: settled ? [{ w: (100 * win) / settled, cls: "is-win" }, { w: (100 * loss) / settled, cls: "is-loss" }, { w: (100 * voided) / settled, cls: "is-void" }] : null,
        note: `<span class="g">${win} V</span><span class="r">${loss} P</span><span class="y">${voided} vr.</span>`,
      }),
      stat(rate === null ? "–" : `${Math.round(rate)} %`, "úspěšnost tiketů", tone ? `stat--${tone}` : "", { icon: "target", bar: rate === null ? null : [{ w: rate, cls: `is-${tone}` }], note: expected === null ? "" : span(`odhad ${Math.round(expected)} %`) }),
      stat(list.length ? nf2.format(mean(list.map((t) => t.totalOdds))) : "–", "průměrný kurz tiketu", "", { icon: "coins" }),
      stat(decided || voided ? fmtProfit(profit) : "–", "zisk (vklad 1 na tiket)", profit > 0 ? "stat--pos" : profit < 0 ? "stat--neg" : "", {
        icon: "trending-up", note: `<span class="stat__chip stat__chip--${profit > 0 ? "pos" : profit < 0 ? "neg" : "muted"}">${esc(roiText)}</span>`,
      }),
    ].join("");
  }

  function evCardHtml(t) {
    const [, m, d] = String(t.day).split("-").map(Number);
    const count = t.legs.length;
    const profit = t.status === "pending" ? "čeká" : fmtProfit(t.profit);
    return `<article class="ev-card ev-card--${t.status}">
      <div class="ev-card__head"><strong>${esc(t.name)}</strong><small>${d}. ${m}. · ${count} ${count < 5 ? "zápasy" : "zápasů"}</small><span class="tk-hist__status tk-hist__status--${t.status}">${TK_STATUS[t.status]}</span></div>
      <ul class="ev-legs">${t.legs.map((l) => `<li class="ev-leg is-${l.outcome || "pending"}"><i>${LEG_MARK[l.outcome] || "…"}</i>
        <span class="ev-leg__match">${esc(l.matchName)}</span><span class="ev-leg__tip">${esc(l.tipLabel)}</span><span class="ev-leg__score">${esc(l.score || "–")}</span><span class="ev-leg__odds">${esc(nf2.format(l.odds))}</span></li>`).join("")}</ul>
      <div class="ev-card__foot"><span>Kurz tiketu <b>${esc(nf2.format(t.totalOdds))}</b></span>${t.effectiveOdds && t.effectiveOdds !== t.totalOdds ? `<span>Skutečný kurz <b>${esc(nf2.format(t.effectiveOdds))}</b></span>` : ""}<span>Pravděpodobnost <b>${esc(nf1.format(t.jointProbability))} %</b></span>
        <span>Zisk <b class="${t.profit > 0 ? "is-pos" : t.profit < 0 ? "is-neg" : ""}">${esc(profit)}</b></span></div>
    </article>`;
  }

  function renderEvaluation() {
    $$("#ev-range [data-evrange]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.evrange === ev.range)));
    const list = evTickets();
    $("#ev-stats").innerHTML = evStatsHtml(list);
    $("#ev-list").innerHTML = !tk.history ? `<p class="empty">${desktop ? "Načítám tikety…" : "Tikety jsou dostupné jen v aplikaci."}</p>`
      : list.length ? list.map(evCardHtml).join("") : '<p class="empty">V tomto období nejsou žádné uložené tikety.</p>';
    renderIcons();
  }

  /* ---------- Slovní vyhodnocení tiketů (Gemini) – pravá část záložky Vyhodnocení ---------- */
  const evAi = { busy: false, saved: store.get("ev-ai") };   // { text, at }: poslední rozbor zůstane i po restartu

  function renderEvAi(errorText = "") {
    const out = $("#ev-ai-out");
    const note = $("#ev-ai-note");
    const btn = $("#ev-ai-run");
    btn.disabled = evAi.busy;
    btn.classList.toggle("is-busy", evAi.busy);
    $("span", btn).textContent = evAi.busy ? "Vyhodnocuji…" : "Vyhodnotit pomocí AI";
    note.textContent = "";
    if (evAi.busy) { out.innerHTML = "<p>AI rozebírá tikety…</p>"; return; }
    if (errorText) { out.innerHTML = `<p class="is-error">${esc(errorText)}</p>`; return; }
    if (evAi.saved && evAi.saved.text) {
      out.innerHTML = aiHtml(evAi.saved.text);
      note.textContent = `Vytvořeno ${fmtKickoff(evAi.saved.at)}`;
      return;
    }
    out.innerHTML = '<p class="detail__empty">Klikni na „Vyhodnotit pomocí AI“ – Gemini slovně rozebere tvoje vyhodnocené tikety: co je špatně a na co si dát pozor.</p>';
  }

  $("#ev-ai-run").addEventListener("click", async () => {
    if (!desktop || evAi.busy) return;
    if (!geminiKey.has) { openKey(); renderEvAi("Nejdřív zadej Gemini API klíč (vlevo dole)."); return; }
    evAi.busy = true;
    renderEvAi();
    let res;
    try { res = await desktop.analysis.run(); } catch (err) { res = { ok: false, error: err.message }; }
    evAi.busy = false;
    if (res.ok) {
      evAi.saved = { text: res.data, at: new Date().toISOString() };
      store.set("ev-ai", evAi.saved);
      renderEvAi();
    } else renderEvAi(res.error);
  });
  $$("#ev-range [data-evrange]").forEach((b) => b.addEventListener("click", () => {
    ev.range = b.dataset.evrange;
    store.set("ev-range", ev.range);
    renderEvaluation();
  }));
  $("#ev-run").addEventListener("click", evaluateResults);

  function loadEvaluation() {
    renderEvaluation();
    renderEvAi();
    renderIcons();
    loadTicketHistory();
  }

  async function loadTickets() {
    renderTickets();
    loadTicketHistory();
  }

  $$("#tk-day [data-tkday]").forEach((b) => b.addEventListener("click", () => {
    tk.day = b.dataset.tkday;
    store.set("tk-day", tk.day);
    renderTickets();
  }));
  if (desktop) desktop.tickets.onProgress((message) => { tk.step = message; tickBusy(); });

  $("#tk-create").addEventListener("click", async () => {
    if (!desktop || tk.busy) return;
    if (!geminiKey.has) { openKey(); toast("Nejdřív zadej Gemini API klíč (vlevo dole).", "error"); return; }
    const forDay = tkTargetDay(); // den platí pro to, co se právě žádá, i kdyby se mezitím přepnul filtr
    tk.busy = true;
    tk.step = "";
    tk.startedAt = Date.now();
    tk.timer = setInterval(tickBusy, 1000);
    $("#tk-create").disabled = true;
    renderTickets();
    const res = await desktop.tickets.create({ day: tk.day });
    clearInterval(tk.timer);
    tk.busy = false;
    $("#tk-create").disabled = false;
    tk.result = { ...(res.ok ? res.data : { error: res.error }), forDay, at: fmtKickoff(new Date().toISOString()) };
    if (res.ok) store.set("tk-result2", tk.result);
    if (res.ok && res.data.reused) toast("Podklady se od minula nezměnily – použila se předchozí odpověď Gemini, nový dotaz se neposlal.");
    renderTickets();
    loadTicketHistory();
  });

  /* ---------- Analýza úspěšnosti tipů a tiketů ---------- */
  const an = { data: null, tickets: null };
  const signed1 = (v) => (v === null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${nf1.format(Math.abs(v))}`);

  function tableHtml(rows, nameHead) {
    if (!rows.length) return '<p class="empty">Zatím není co ukázat.</p>';
    const body = rows.map((r) => {
      const cls = r.gap === null ? "" : r.gap >= 3 ? "gap-pos" : r.gap <= -3 ? "gap-neg" : "";
      const bar = r.n ? `<div class="an-bar" title="skutečnost ${r.actual} %, předpoklad ${r.predicted} %"><i style="width:${Math.min(100, r.actual)}%"></i><b style="left:${Math.min(100, r.predicted)}%"></b></div>` : "";
      return `<tr><td>${esc(r.label || r.name)}</td><td>${r.n}</td><td>${r.n ? `${nf1.format(r.predicted)} %` : "–"}</td><td>${r.n ? `${nf1.format(r.actual)} %` : "–"}</td>
        <td class="${cls}">${signed1(r.gap)}${r.n ? " p. b." : ""}</td><td>${r.roi === null ? "–" : `${signed1(r.roi)} %`}</td><td>${bar}</td></tr>`;
    }).join("");
    return `<table class="an-table"><thead><tr><th>${esc(nameHead)}</th><th>Tipů</th><th>Odhad</th><th>Skutečně</th><th>Rozdíl</th><th>ROI</th><th></th></tr></thead><tbody>${body}</tbody></table>`;
  }

  function renderAnalysis() {
    const a = an.data;
    if (!a) {
      $("#an-stats").innerHTML = "";
      ["an-bands", "an-markets", "an-leagues"].forEach((id) => { $(`#${id}`).innerHTML = ""; });
      $("#an-insights").innerHTML = `<li>${desktop ? "Načítám…" : "Analýza je dostupná jen v aplikaci."}</li>`;
      return;
    }
    const o = a.overall;
    $("#an-stats").innerHTML = [
      stat(String(o.n), "vyhodnocených tipů", "stat--accent", { icon: "list-checks" }),
      stat(o.n ? `${nf1.format(o.actual)} %` : "–", "skutečná úspěšnost", "", { icon: "target", bar: o.n ? [{ w: o.actual, cls: o.actual >= 60 ? "is-good" : o.actual >= 45 ? "is-warn" : "is-bad" }] : null }),
      stat(o.n ? `${nf1.format(o.predicted)} %` : "–", "průměrný odhad", "", { icon: "gauge", bar: o.n ? [{ w: o.predicted, cls: "is-muted" }] : null }),
      stat(o.n ? `${signed1(o.gap)} p. b.` : "–", "rozdíl od odhadu", o.gap > 0 ? "stat--pos" : o.gap < 0 ? "stat--neg" : ""),
      stat(o.roi === null ? "–" : `${signed1(o.roi)} %`, "ROI (skutečné kurzy)", o.roi > 0 ? "stat--pos" : o.roi < 0 ? "stat--neg" : ""),
    ].join("");
    renderIcons();
    $("#an-bands").innerHTML = tableHtml(a.bands, "Pásmo");
    $("#an-markets").innerHTML = tableHtml(a.markets, "Typ tipu");
    $("#an-leagues").innerHTML = tableHtml(a.leagues, "Soutěž");
    const th = an.tickets;
    $("#an-tickets").innerHTML = !th || !th.stats.n
      ? `<p class="empty">${th && (th.tickets.length) ? "Uložené tikety zatím čekají na výsledky zápasů." : "Zatím nejsou uložené žádné tikety. Vytvoř je v záložce Tikety, po zápasech se tady vyhodnotí."}</p>`
      : tableHtml([{ name: "Tikety od Gemini (počet tiketů)", ...th.stats }, { name: "Všechny tipy jednotlivě (počet tipů)", ...th.tips }], "Srovnání");
    $("#an-insights").innerHTML = (a.insights.length ? a.insights : ["Zatím nejsou žádná zjištění."]).map((t) => `<li>${esc(t)}</li>`).join("");
    renderAdvice(th && th.advice);
  }

  /** „Na co sázet a na co ne“ podle výsledků tiketů: dva sloupce se skupinami, které se osvědčily / ne. */
  function renderAdvice(adv) {
    const el = $("#an-advice");
    if (!adv) { el.innerHTML = ""; return; }
    const list = (items, empty) => (items.length
      ? `<ul>${items.map((i) => `<li><strong>${esc(i.label)}</strong><span>${esc(i.text)}</span></li>`).join("")}</ul>`
      : `<p class="adv__empty">${esc(empty)}</p>`);
    el.innerHTML = `<div class="adv">
        <div class="adv__col adv__col--bet"><h4>Sázet</h4>${list(adv.bet, "Zatím nic, co by se výrazně osvědčilo.")}</div>
        <div class="adv__col adv__col--avoid"><h4>Nesázet</h4>${list(adv.avoid, "Zatím nic, co by výrazně prodělávalo.")}</div>
      </div><p class="adv__note">${esc(adv.note)}</p>`;
  }

  async function loadAnalysis() {
    if (!desktop) { renderAnalysis(); return; }
    const res = await desktop.analysis.get();
    if (res.ok) an.data = res.data;
    const th = await desktop.tickets.history();
    if (th.ok) an.tickets = th.data;
    renderAnalysis();
  }

  /** Jednoduché zobrazení textu od AI: odstavce, odrážky „- “ a **tučné**. */
  function aiHtml(text) {
    const bold = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    const out = [];
    let list = [];
    const flush = () => { if (list.length) { out.push(`<ul>${list.join("")}</ul>`); list = []; } };
    for (const line of text.split(/\n+/)) {
      const t = line.trim();
      if (!t) continue;
      if (/^[-*•]\s+/.test(t)) list.push(`<li>${bold(t.replace(/^[-*•]\s+/, ""))}</li>`);
      else { flush(); out.push(`<p>${bold(t.replace(/^#+\s*/, ""))}</p>`); }
    }
    flush();
    return out.join("");
  }

  /* ---------- Gemini API klíč (levý panel; společný pro Tikety a AI analýzu) ---------- */
  const geminiKey = { has: false };
  const keyForm = $("#key-form");
  const keyBtn = $("#key-btn");
  function renderKey() {
    $("#key-label").textContent = geminiKey.has ? "Uložen" : "Nenastaven – klikni";
    $("#key-remove").hidden = !geminiKey.has;
  }
  async function loadKey() {
    if (!desktop) return;
    geminiKey.has = await desktop.analysis.hasKey();
    renderKey();
  }
  function openKey(open = true) {
    keyForm.hidden = !open;
    keyBtn.setAttribute("aria-expanded", String(open));
    if (open) $("#key-input").focus();
  }
  keyBtn.addEventListener("click", () => openKey(keyForm.hidden));
  $("#key-close").addEventListener("click", () => openKey(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !keyForm.hidden) openKey(false); });
  document.addEventListener("mousedown", (e) => { if (!keyForm.hidden && !keyForm.contains(e.target) && !keyBtn.contains(e.target)) openKey(false); });
  keyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = $("#key-input").value.trim();
    if (!key || !desktop) return;
    const res = await desktop.analysis.setKey(key);
    $("#key-input").value = "";
    if (res.ok) { openKey(false); toast("API klíč je uložený (šifrovaně)."); loadKey(); } else toast(res.error, "error");
  });
  $("#key-remove").addEventListener("click", async () => {
    if (!desktop) return;
    await desktop.analysis.setKey("");
    toast("API klíč je odebraný.");
    openKey(false);
    loadKey();
  });
  /* ---------- Vykreslení všeho ---------- */
  function renderAll() {
    renderTips();
    renderNotice();
    renderCats();
    renderChip();
    renderUpdated();
  }

  /* ---------- Mřížka Přehledu (GridStack, pevné rozložení) ---------- */
  const setupBoard = () => {
    const GS = window.GridStack?.GridStack || window.GridStack;
    const boardEl = $("#board");
    if (!GS || !boardEl) return;

    const ROWS = 48; // jemná mřížka 24 × 48

    // Výška řádku tak, aby všechny řádky přesně vyplnily okno pod horní lištou (a případným upozorněním).
    const rowHeight = () => {
      const top = $(".topbar").getBoundingClientRect().height;
      return Math.max(10, Math.round(((window.innerHeight - top - 17) / ROWS) * 100) / 100);
    };

    const grid = GS.init({
      column: 24,
      cellHeight: rowHeight(),
      margin: 8,                     // 16 px mezi bloky – stejně jako na ostatních záložkách
      float: false,
      animate: false,
      staticGrid: true,              // rozložení je pevné
    }, boardEl);
    window.addEventListener("resize", () => grid.cellHeight(rowHeight()));
  };
  setupBoard();

  /* ---------- Desktop (Electron): ovládání okna ---------- */
  if (desktop) {
    document.documentElement.classList.add("is-desktop");

    $('[data-win="minimize"]').addEventListener("click", desktop.minimize);
    $('[data-win="maximize"]').addEventListener("click", desktop.toggleMaximize);
    $('[data-win="close"]').addEventListener("click", desktop.close);

    const maxBtn = $('[data-win="maximize"]');
    desktop.onMaximizedChange((maximized) => {
      maxBtn.setAttribute("aria-label", maximized ? "Obnovit" : "Maximalizovat");
      maxBtn.innerHTML = `<i data-lucide="${maximized ? "copy" : "square"}"></i>`;
      renderIcons();
    });
  }

  /* ---------- Diagnostika pro vývojáře: Ctrl + Shift + D zkopíruje do schránky stav zdrojů a ladicí soubory ---------- */
  document.addEventListener("keydown", async (e) => {
    if (!(e.ctrlKey && e.shiftKey && e.code === "KeyD") || !desktop) return;
    e.preventDefault();
    const res = await desktop.diagnostics.copy();
    if (res.ok) toast(`Diagnostika je zkopírovaná do schránky (${nf1.format(res.data.chars / 1000)} tis. znaků) – vlož ji do zprávy.`);
    else toast(`Diagnostiku se nepodařilo zkopírovat: ${res.error}`, "error");
  });

  /* ---------- Nová verze: štítek v horní liště a tlačítko Aktualizace vlevo dole ---------- */
  const updateChip = $("#update-chip");
  const updateBtn = $("#update-btn");
  const updateBtnLabel = $(".side-btn__title", updateBtn);
  const updateBtnSub = $("#build-label");
  let updateInfo = null;   // zjištěná novější verze { current, latest, url }
  let appBuild = 0;        // číslo verze této aplikace
  let upToDate = false;    // poslední kontrola potvrdila, že je to nejnovější verze

  const updateBtnIcon = $(".side-btn__icon", updateBtn);
  let updateIcon = "refresh-cw";

  function renderUpdateBtn(checking = false) {
    updateBtn.disabled = checking;
    updateBtn.classList.toggle("side-btn--busy", checking);
    updateBtn.classList.toggle("side-btn--found", Boolean(updateInfo) && !checking);
    updateBtn.classList.toggle("side-btn--ok", upToDate && !updateInfo && !checking);
    const icon = upToDate && !updateInfo && !checking ? "circle-check" : "refresh-cw";
    if (icon !== updateIcon) {
      updateIcon = icon;
      updateBtnIcon.innerHTML = `<i data-lucide="${icon}"></i>`;
      renderIcons();
    }
    updateBtnLabel.textContent = checking ? "Hledám…" : updateInfo ? `Stáhnout verzi ${updateInfo.latest}` : upToDate ? "Máš aktuální verzi" : "Aktualizace";
    updateBtnSub.textContent = checking ? "kontroluji GitHub" : updateInfo ? "klikni pro stažení" : appBuild ? `verze ${appBuild}` : upToDate ? "nejnovější verze" : "Vyhledat novou verzi";
    updateBtn.title = checking ? "Hledám novou verzi programu…"
      : updateInfo ? `Je k dispozici verze ${updateInfo.latest} (máš ${updateInfo.current}). Klikni pro stažení.` : upToDate ? "Máš nejnovější verzi programu. Klikni pro novou kontrolu." : "Vyhledat novou verzi programu";
  }

  function showUpdate(info) {
    if (!info || !info.available) return;
    updateInfo = info;
    upToDate = false;
    updateChip.hidden = false;
    $("span", updateChip).textContent = `Nová verze ${info.latest}`;
    updateChip.title = `Je k dispozici verze ${info.latest} (máš ${info.current}). Klikni pro stažení.`;
    renderUpdateBtn();
  }

  function downloadUpdate() {
    if (!updateInfo) return;
    openExternal(updateInfo.url);
    toast("Stažení se otevřelo v prohlížeči. Po stažení zavři aplikaci a spusť nový FotbalTipy.exe.");
  }

  updateChip.addEventListener("click", downloadUpdate);
  updateBtn.addEventListener("click", async () => {
    if (updateInfo) { downloadUpdate(); return; }       // novější verze už je známá: druhý klik stáhne
    if (!desktop) return;
    renderUpdateBtn(true);
    const res = await desktop.update.check();
    if (res.ok && res.data.available) showUpdate(res.data);
    upToDate = Boolean(res.ok && !res.data.available);
    renderUpdateBtn();
    if (!res.ok) toast(res.error, "error");
    else if (res.data.available) toast(`Je k dispozici verze ${res.data.latest} (máš ${res.data.current}). Klikni na „Stáhnout“.`);
  });
  if (desktop) {
    desktop.update.onAvailable(showUpdate);
    desktop.update.get().then(showUpdate).catch(() => {});
  } else {
    updateBtn.hidden = true;
  }

  /* ---------- Start ---------- */
  const STALE_MS = 15 * 60e3; // čerstvější data se po spuštění znovu nestahují

  async function start() {
    try { showView(sessionStorage.getItem("tips:view") || "overview"); } catch { showView("overview"); }
    renderIcons();
    renderAll();
    renderHistory();
    if (!desktop) return;

    const info = await desktop.appInfo();
    if (info) {
      const build = Number((/\.(\d+)$/.exec(info.version || "") || [])[1] || 0);
      if (build) {
        $(".brand").title = `Fotbalové tipy – verze ${build}`;
        appBuild = build;
        renderUpdateBtn();
      }
      state.limits = { ...state.limits, ...info.limits };
      state.leagues = info.leagues || [];
      if (state.league && !state.leagues.some((l) => l.key === state.league)) state.league = "";
    }
    const cached = await desktop.tips.cached();
    if (cached.ok) state.payload = cached.data;
    else state.error = cached.error;
    renderAll();
    loadKey();

    const age = state.payload?.updatedAt ? Date.now() - Date.parse(state.payload.updatedAt) : Infinity;
    if (age > STALE_MS) refresh();
  }

  // Okno je vidět? (minimalizované nebo skryté okno nic nestahuje ani nepřekresluje; po návratu se všechno doplní hned.)
  let windowShown = true;
  const awake = () => windowShown && !document.hidden;

  // Stavy „před zápasem / zahájen“ a „aktualizováno před …“ se průběžně přepočítávají podle hodin.
  setInterval(() => { if (awake() && !state.busy && state.payload) { renderTips(); renderUpdated(); } }, 30e3);

  // Skóre rozehraných zápasů se každou minutu zaktualizuje ze SofaScore (nestahuje se všechno znovu).
  async function liveScoreTick() {
    if (!desktop || state.busy || !state.payload || !awake()) return;
    const now = Date.now();
    if (!state.payload.tips.some((t) => ["live", "started"].includes(matchState(t, now).kind))) return;
    try {
      const res = await desktop.tips.live();
      if (res.ok && res.data && !state.busy) {
        state.payload = { ...state.payload, tips: res.data };
        renderTips();
      }
    } catch { /* příště */ }
  }
  setInterval(liveScoreTick, 60e3);

  function wakeUp() {
    if (!awake()) return;
    if (state.payload) { renderTips(); renderUpdated(); }
    liveScoreTick();
    if (app.dataset.view === "live") loadLiveList().then(loadLiveDetail);
  }
  document.addEventListener("visibilitychange", wakeUp);
  if (desktop && desktop.onVisibleChange) desktop.onVisibleChange((shown) => { windowShown = shown; wakeUp(); });

  start();
})();
