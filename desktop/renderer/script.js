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
  const FOREBET_CODES = new Set(["1", "X", "2", "1X", "X2", "12", "BTTS", "NOBTTS"]);
  // Forebet hodnotí 1X2, dvojitou šanci, BTTS a Over/Under celého zápasu (týmové totaly a handicapy ne).
  const forebetCovers = (code) => FOREBET_CODES.has(code) || /^[OU]\d+(?:\.\d+)?$/.test(code);
  const DAYS = ["today", "tomorrow"];

  const state = {
    payload: null,            // poslední data z hlavního procesu
    error: null,              // chyba celého stahování (text)
    busy: false,
    limits: { minProbability: 60, minOdds: 1.5, highProbability: 75 },
    day: DAYS.includes(store.get("day")) ? store.get("day") : "today",
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

  const stat = (value, label, cls = "") =>
    `<div class="stat ${cls}"><div class="stat__value">${esc(value)}</div><div class="stat__label" title="${esc(label)}">${esc(label)}</div></div>`;

  /* ---------- Navigace ---------- */
  const VIEWS = ["overview", "live", "tickets", "analysis", "history"];
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
    renderCats();
  };

  $$(".nav__link").forEach((link) => {
    link.title = link.textContent.trim();
    link.addEventListener("click", (e) => {
      e.preventDefault();
      if (app.classList.contains("is-editing")) return; // v režimu úprav se položky jen přesouvají
      showView(link.dataset.view);
    });
  });
  $(".brand").addEventListener("click", (e) => {
    e.preventDefault();
    if (!app.classList.contains("is-editing")) showView("overview");
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
    fb: (t) => t.probForebet,
    source: (t) => t.sources.join(" + "),
    status: (t) => matchState(t).order,
  };
  const HIST_SORT = {
    ...TIP_SORT,
    score: (t) => (t.homeScore !== null && t.awayScore !== null ? t.homeScore * 100 + t.awayScore : null),
    outcome: (t) => OUTCOME_ORDER[t.outcome] ?? null,
  };
  const DESC_FIRST = new Set(["prob", "odds", "value", "fb", "score"]);

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
    const fb = t.probForebet !== null ? fmtPct(t.probForebet) : (forebetCovers(t.tipCode) ? "–" : "n/a");
    return `<tr class="trow is-${t.probClass}${selected ? " is-selected" : ""}${ms.kind === "done" ? " is-done" : ""}${ms.kind === "live" || ms.kind === "started" ? " is-live" : ""}" data-key="${esc(key)}" tabindex="${selected ? 0 : -1}" aria-selected="${selected}">
      <td class="c-time">${esc(fmtKickoff(t.kickoff))}</td>
      <td class="c-match"><span class="match">${matchHtml(t, ms)}</span></td>
      <td class="c-tip">${esc(t.tipLabel)}</td>
      <td class="c-prob"><span class="pill pill--${t.probClass}"${t.probSource !== "Scores24" ? ` title="Scores24 procento neuvedl – hodnota z ${esc(t.probSource)}"` : ""}>${esc(fmtPct(t.probability))}</span></td>
      <td class="c-fb"${fb === "n/a" ? ' title="Forebet tento trh nehodnotí"' : ""}>${esc(fb)}</td>
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

  function forebetFact(t) {
    if (t.probForebet !== null) return `${fmtPct(t.probForebet)}${t.probForebet > state.limits.minProbability ? " – potvrzuje" : " – nepotvrzuje"}`;
    if (!forebetCovers(t.tipCode)) return "tento trh nehodnotí";
    const fb = state.payload?.statuses?.Forebet;
    if (fb && (fb.state === "failed" || fb.state === "skipped")) return "zdroj není dostupný";
    return "zápas nenalezen";
  }

  function renderDetail() {
    const t = tipByKey(state.selected);
    if (!t) {
      detailEl.innerHTML = `<p class="detail__empty">${state.visible.length ? "Vyber tip v tabulce." : "Žádný tip k zobrazení."}<br>Dvojklik na řádek otevře zápas na Scores24.</p>`;
      return;
    }
    const now = Date.now();
    const ms = matchState(t, now);
    const kickoff = Date.parse(t.kickoff);
    const when = `${fmtKickoff(t.kickoff)}${ms.kind === "wait" ? ` (${untilText(kickoff - now)})` : ""}`;
    const facts = [
      ["Začátek", `${when} · ${ms.text}`],
      [`Pravděpodobnost (${t.probSource})`, fmtPct(t.probability), true],
      ["Kurz", t.odds ? `${nf2.format(t.odds)}${t.oddsEstimated ? " – odhad z pravděpodobnosti" : " – orientační"}` : "není k dispozici", true],
      ["Forebet", forebetFact(t)],
      ["Zdroje", t.sources.join(" + ")],
    ];
    if (t.outcome) {
      const names = { win: "Výhra", loss: "Prohra", void: "Vráceno" };
      facts.push(["Výsledek", `${names[t.outcome] || t.outcome}${t.outcomeSource && t.outcomeSource !== "manual" ? " (automaticky)" : ""}`]);
    }
    const hi = state.limits.highProbability;
    detailEl.innerHTML = `
      <span class="detail__state is-${t.probClass}">${t.probClass === "high" ? `NAD ${hi} %` : `${state.limits.minProbability}–${hi} %`}</span>
      <div class="detail__tip">${esc(t.tipLabel)}</div>
      <div class="detail__match">${esc(t.matchName)}</div>
      <div class="detail__league">${esc(t.league)}</div>
      <dl class="facts">${facts.map(([k, v, strong]) => `<dt>${esc(k)}</dt><dd${strong ? ' class="is-strong"' : ""}>${esc(v)}</dd>`).join("")}</dl>
      <div class="detail__actions">
        ${t.url ? '<button class="btn btn--ghost btn--sm" type="button" data-act="scores24"><i data-lucide="external-link"></i>Scores24</button>' : ""}
        ${t.forebetUrl ? '<button class="btn btn--ghost btn--sm" type="button" data-act="forebet"><i data-lucide="external-link"></i>Forebet</button>' : ""}
        ${t.sofascoreUrl ? '<button class="btn btn--ghost btn--sm" type="button" data-act="sofascore"><i data-lucide="external-link"></i>SofaScore</button>' : ""}
      </div>`;
    renderIcons();
  }

  detailEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    const t = tipByKey(state.selected);
    if (!btn || !t) return;
    switch (btn.dataset.act) {
      case "scores24": openExternal(t.url); break;
      case "forebet": openExternal(t.forebetUrl); break;
      case "sofascore": openExternal(t.sofascoreUrl); break;
      default: break;
    }
  });

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

  const setBusy = (busy, message = "") => {
    state.busy = busy;
    app.classList.toggle("is-busy", busy);
    refreshBtn.disabled = busy;
    $("#evaluate").disabled = busy;
    $("span", refreshBtn).textContent = busy ? "Stahuji…" : "Obnovit tipy";
    topProgress.hidden = !busy;
    progressText.hidden = !busy;
    progressText.textContent = message;
    progressText.title = message;
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
    loadMini();
    if (app.dataset.view === "history") loadHistory();
  }
  refreshBtn.addEventListener("click", () => refresh());

  if (desktop) desktop.tips.onProgress((message) => { if (state.busy) { progressText.textContent = message; progressText.title = message; } });

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
  async function loadMini() {
    const data = await fetchHistory(30);
    if (data) state.mini = data;
    renderMini();
  }

  const statTiles = (s) => {
    const rate = s.hitRate === null ? "–" : `${Math.round(s.hitRate)} %`;
    const profit = s.profit === null ? "–" : fmtSigned(s.profit);
    const roi = s.roiPct === null ? "bez skutečných kurzů" : `ROI ${s.roiPct > 0 ? "+" : s.roiPct < 0 ? "−" : ""}${nf1.format(Math.abs(s.roiPct))} %`;
    return { rate, profit, roi, profitCls: s.profit > 0 ? "stat--pos" : s.profit < 0 ? "stat--neg" : "" };
  };

  function renderMini() {
    const s = state.mini?.stats;
    if (!s) { $("#mini-stats").innerHTML = '<p class="empty">Zatím žádná historie.</p>'; return; }
    const v = statTiles(s);
    $("#mini-stats").innerHTML = [
      stat(String(s.total), "uložených tipů", "stat--accent"),
      stat(String(s.evaluated), "vyhodnoceno"),
      stat(v.rate, `úspěšnost (${s.wins} V / ${s.losses} P)`),
      stat(v.profit, `zisk · ${v.roi}`, v.profitCls),
    ].join("");
  }

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
    $("#history-stats").innerHTML = [
      stat(String(s.total), "tipů v období", "stat--accent"),
      stat(String(s.evaluated), `vyhodnoceno (${s.wins} V · ${s.losses} P · ${s.voids} vr.)`),
      stat(v.rate, "úspěšnost"),
      stat(s.avgOdds === null ? "–" : nf2.format(s.avgOdds), "průměrný kurz"),
      stat(v.profit, `zisk (vklad 1) · ${v.roi}`, v.profitCls),
    ].join("");

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

  $("#export-csv").addEventListener("click", async () => {
    if (!desktop) return;
    const res = await desktop.history.exportCsv();
    if (!res.ok) toast(`Export se nepodařil: ${res.error}`, "error");
    else if (res.data.saved) toast("Historie je uložená do souboru CSV (otevři ji v Excelu).");
  });

  $("#evaluate").addEventListener("click", async () => {
    if (state.busy || !desktop) return;
    setBusy(true, "Zjišťuji výsledky zápasů…");
    let res;
    try { res = await desktop.history.evaluate(); } catch (err) { res = { ok: false, error: err.message }; }
    setBusy(false);
    if (res.ok) toast(res.data.message);
    else toast(`Vyhodnocení se nepodařilo: ${res.error}`, "error");
    await loadHistory();
    loadMini();
  });


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
    return `<ul class="events">${incidents.map((i) => `<li><span class="ev-home">${i.home ? text(i) : ""}</span><span class="ev-min">${i.minute}'</span><span>${i.home ? "" : text(i)}</span></li>`).join("")}</ul>`;
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
    live.timer = setInterval(() => { loadLiveList().then(loadLiveDetail); }, 30e3);
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
    const item = (key, name, badge, count) => `<button type="button" class="cat${state.league === key ? " is-active" : ""}${count ? "" : " is-empty"}" data-league="${esc(key)}" title="${esc(name)}" aria-pressed="${state.league === key}">
      <span class="cat__badge">${esc(badge)}</span><span class="cat__name">${esc(name)}</span><span class="cat__count">${count}</span></button>`;
    catsEl.innerHTML = `<div class="cats__title">Soutěže</div>${item("", "Všechny soutěže", "★", total)}${state.leagues.map((l) => item(l.key, l.short, badgeOf(l.short), counts[l.key] || 0)).join("")}`;
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
    result: store.get("tk-result2"),   // naposledy vytvořené tikety (zůstanou i po restartu)
    busy: false, hasKey: false, step: "", startedAt: 0, timer: null,
  };
  const CERTAINTY_CS = { good: "Vysoká jistota", ok: "Střední jistota", risky: "Nižší jistota" };
  const TK_NOTE = $("#tk-note").textContent;
  const kickoffShort = (iso) => fmtKickoff(iso);

  const busyText = () => `${tk.step || "Připravuji tikety…"} (${Math.round((Date.now() - tk.startedAt) / 1000)} s)`;
  const tickBusy = () => { const el = $("#tk-busy-text"); if (el) el.textContent = busyText(); };

  /** Seznam zápasů, které skončily mimo tikety, každý s důvodem (rozbalovací). */
  const omittedHtml = (r) => (r && r.omitted && r.omitted.length
    ? `<section class="tk-omitted tk-wide"><h3 class="tk-omitted__title">Nezařazeno do tiketů: ${r.omitted.length} z ${r.analyzed} zápasů – proč?</h3><ul>${r.omitted.map((o) => `<li>
        <span class="tk-omitted__match">${esc(o.matchName)}</span><span class="tk-omitted__tip">${esc(o.tipLabel)} · ${esc(nf2.format(o.odds))}</span><span class="tk-omitted__why">${esc(o.reason)}</span></li>`).join("")}</ul></section>`
    : "");

  function renderTickets() {
    $$("#tk-day [data-tkday]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tkday === tk.day)));
    $("#tk-key-label").textContent = tk.hasKey ? "Gemini klíč uložen" : "Gemini API klíč";
    const note = $("#tk-note");
    const list = $("#tk-list");
    const r = tk.result;
    note.textContent = TK_NOTE;
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
      <div class="tk-legs">${t.legs.map((l) => `<div class="tk-leg"><div class="tk-leg__row">
          <span class="tk-leg__match">${esc(l.matchName)}</span><span class="tk-leg__odds">${esc(nf2.format(l.odds))}</span>
          <span class="tk-leg__tip">${esc(l.tipLabel)}</span><span class="tk-leg__meta">${esc(kickoffShort(l.kickoff))} · ${esc(fmtPct(l.probability))}</span>
        </div></div>`).join("")}</div>
      <div class="tk-totals">
        ${stat(nf2.format(t.totalOdds), "celkový kurz", "stat--accent")}
        ${stat(`${nf1.format(t.jointProbability)} %`, "pravděpodobnost (součin)")}
        ${stat(`${t.expectedReturn > 0 ? "+" : t.expectedReturn < 0 ? "−" : ""}${nf1.format(Math.abs(t.expectedReturn))} %`, "odhad výnosu", t.expectedReturn > 0 ? "stat--pos" : t.expectedReturn < 0 ? "stat--neg" : "")}
      </div>
      ${t.summary ? `<p class="tk-summary"><span class="tk-summary__label">Zdůvodnění</span>${esc(t.summary)}</p>` : ""}
      </article>`).join("") + omittedHtml(r);
    const parts = [`Z ${r.analyzed} zápasů z přehledu${r.at ? ` (${r.at})` : ""}`];
    if (r.covered < r.analyzed) parts.push(`statistiky se našly k ${r.covered}`);
    if (r.rejected) parts.push(`${r.rejected} ${r.rejected === 1 ? "tiket navržený" : "tiketů navržených"} AI porušil${r.rejected === 1 ? "" : "o"} pravidla a ${r.rejected === 1 ? "byl zahozen" : "bylo zahozeno"}`);
    note.textContent = `${parts.join(" · ")}. Pravděpodobnost je součin odhadů zdroje – bývá optimistická; kurzy u Tipsportu se mohou lišit a výnos není zaručen. Sázení je jen pro 18+.`;
    renderIcons();
  }

  const TK_STATUS = { pending: "Čeká", win: "Vyhráno", loss: "Prohráno", void: "Vráceno" };
  const LEG_MARK = { win: "✓", loss: "✗", void: "↺" };

  /** Dřívější tikety s výsledky (podle výsledků jejich tipů) a souhrnem. */
  function renderTicketHistory() {
    const el = $("#tk-history");
    const h = tk.history;
    if (!h || !h.tickets.length) { el.innerHTML = ""; return; }
    const st = h.stats;
    const sum = st.n ? `vyhodnoceno ${st.n}, vyhráno ${st.wins} (${nf1.format(st.actual)} %), ROI ${st.roi > 0 ? "+" : st.roi < 0 ? "−" : ""}${nf1.format(Math.abs(st.roi))} %` : "zatím žádný vyhodnocený";
    el.innerHTML = `<h3 class="tk-hist__title">Dřívější tikety<small>${esc(sum)}${st.pending ? ` · čeká ${st.pending}` : ""}</small></h3>`
      + h.tickets.map((t) => `<div class="tk-hist__row">
        <div class="tk-hist__meta"><strong>${esc(t.name)}</strong><span>${esc(fmtKickoff(t.createdAt))}</span></div>
        <ul class="tk-hist__legs">${t.legs.map((l) => `<li class="is-${l.outcome || "pending"}"><i>${LEG_MARK[l.outcome] || "…"}</i><span>${esc(l.matchName)}</span><em>${esc(l.tipLabel)} · ${esc(nf2.format(l.odds))}</em></li>`).join("")}</ul>
        <div class="tk-hist__odds">${esc(nf2.format(t.totalOdds))}</div>
        <span class="tk-hist__status tk-hist__status--${t.status}">${TK_STATUS[t.status]}</span></div>`).join("");
  }

  async function loadTicketHistory() {
    if (!desktop) return;
    const res = await desktop.tickets.history();
    if (res.ok) { tk.history = res.data; renderTicketHistory(); }
  }

  async function loadTickets() {
    if (desktop) {
      tk.hasKey = await desktop.analysis.hasKey();
      $("#ai-key-label").textContent = tk.hasKey ? "Gemini klíč uložen" : "Gemini API klíč";
    }
    renderTickets();
    loadTicketHistory();
  }

  $$("#tk-day [data-tkday]").forEach((b) => b.addEventListener("click", () => {
    tk.day = b.dataset.tkday;
    store.set("tk-day", tk.day);
    renderTickets();
  }));
  if (desktop) desktop.tickets.onProgress((message) => { tk.step = message; tickBusy(); });

  $("#tk-key-btn").addEventListener("click", () => { const f = $("#tk-key-form"); f.hidden = !f.hidden; if (!f.hidden) $("#tk-key").focus(); });
  $("#tk-key-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = $("#tk-key").value.trim();
    if (!key || !desktop) return;
    const res = await desktop.analysis.setKey(key);
    $("#tk-key").value = "";
    if (res.ok) { $("#tk-key-form").hidden = true; toast("API klíč je uložený (šifrovaně)."); loadTickets(); } else toast(res.error, "error");
  });
  $("#tk-key-remove").addEventListener("click", async () => {
    if (!desktop) return;
    await desktop.analysis.setKey("");
    toast("API klíč je odebraný.");
    loadTickets();
  });

  $("#tk-create").addEventListener("click", async () => {
    if (!desktop || tk.busy) return;
    if (!tk.hasKey) { $("#tk-key-form").hidden = false; $("#tk-key").focus(); toast("Nejdřív zadej Gemini API klíč.", "error"); return; }
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
    tk.result = res.ok ? { ...res.data, at: fmtKickoff(new Date().toISOString()) } : { error: res.error };
    if (res.ok) store.set("tk-result2", tk.result);
    renderTickets();
    loadTicketHistory();
  });

  /* ---------- Analýza úspěšnosti tipů (+ AI) ---------- */
  const an = { data: null, tickets: null, hasKey: false, busy: false };
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
      stat(String(o.n), "vyhodnocených tipů", "stat--accent"),
      stat(o.n ? `${nf1.format(o.actual)} %` : "–", "skutečná úspěšnost"),
      stat(o.n ? `${nf1.format(o.predicted)} %` : "–", "průměrný odhad"),
      stat(o.n ? `${signed1(o.gap)} p. b.` : "–", "rozdíl (skutečnost − odhad)", o.gap > 0 ? "stat--pos" : o.gap < 0 ? "stat--neg" : ""),
      stat(o.roi === null ? "–" : `${signed1(o.roi)} %`, "ROI (skutečné kurzy)", o.roi > 0 ? "stat--pos" : o.roi < 0 ? "stat--neg" : ""),
    ].join("");
    $("#an-bands").innerHTML = tableHtml(a.bands, "Pásmo");
    $("#an-markets").innerHTML = tableHtml(a.markets, "Typ tipu");
    $("#an-leagues").innerHTML = tableHtml(a.leagues, "Soutěž");
    const th = an.tickets;
    $("#an-tickets").innerHTML = !th || !th.stats.n
      ? `<p class="empty">${th && (th.tickets.length) ? "Uložené tikety zatím čekají na výsledky zápasů." : "Zatím nejsou uložené žádné tikety. Vytvoř je v záložce Tikety, po zápasech se tady vyhodnotí."}</p>`
      : tableHtml([{ name: "Tikety od Gemini (počet tiketů)", ...th.stats }, { name: "Všechny tipy jednotlivě (počet tipů)", ...th.tips }], "Srovnání");
    $("#an-insights").innerHTML = (a.insights.length ? a.insights : ["Zatím nejsou žádná zjištění."]).map((t) => `<li>${esc(t)}</li>`).join("");
  }

  async function loadAnalysis() {
    if (!desktop) { renderAnalysis(); return; }
    const [res, hasKey] = await Promise.all([desktop.analysis.get(), desktop.analysis.hasKey()]);
    if (res.ok) an.data = res.data;
    const th = await desktop.tickets.history();
    if (th.ok) an.tickets = th.data;
    an.hasKey = hasKey;
    $("#ai-key-label").textContent = hasKey ? "Gemini klíč uložen" : "Gemini API klíč";
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

  $("#ai-key-btn").addEventListener("click", () => { const f = $("#ai-key-form"); f.hidden = !f.hidden; if (!f.hidden) $("#ai-key").focus(); });
  $("#ai-key-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = $("#ai-key").value.trim();
    if (!key || !desktop) return;
    const res = await desktop.analysis.setKey(key);
    $("#ai-key").value = "";
    if (res.ok) { $("#ai-key-form").hidden = true; toast("API klíč je uložený (šifrovaně)."); loadAnalysis(); } else toast(res.error, "error");
  });
  $("#ai-key-remove").addEventListener("click", async () => {
    if (!desktop) return;
    await desktop.analysis.setKey("");
    toast("API klíč je odebraný.");
    loadAnalysis();
  });
  $("#ai-run").addEventListener("click", async () => {
    if (!desktop || an.busy) return;
    if (!an.hasKey) { $("#ai-key-form").hidden = false; $("#ai-key").focus(); $("#ai-out").innerHTML = '<p class="is-error">Nejdřív zadej API klíč.</p>'; return; }
    an.busy = true;
    $("#ai-run").disabled = true;
    $("#ai-out").innerHTML = "<p>AI analyzuje tipy…</p>";
    const res = await desktop.analysis.run();
    an.busy = false;
    $("#ai-run").disabled = false;
    $("#ai-out").innerHTML = res.ok ? aiHtml(res.data) : `<p class="is-error">${esc(res.error)}</p>`;
  });

  /* ---------- Vykreslení všeho ---------- */
  function renderAll() {
    renderTips();
    renderNotice();
    renderCats();
    renderChip();
  }

  /* ---------- Přizpůsobitelná mřížka Přehledu (GridStack) ---------- */
  let relayout = () => {};
  const setupBoard = () => {
    const GS = window.GridStack?.GridStack || window.GridStack;
    const boardEl = $("#board");
    if (!GS || !boardEl) return;

    // Jemná mřížka 24 × 48, aby šla velikost bloků měnit po malých krocích.
    const COLUMNS = 24;
    const ROWS = 48;
    const DEFAULT_LAYOUT = $$(".grid-stack-item", boardEl).map((el) => ({
      id: el.getAttribute("gs-id"),
      x: +el.getAttribute("gs-x"), y: +el.getAttribute("gs-y"),
      w: +el.getAttribute("gs-w"), h: +el.getAttribute("gs-h"),
    }));

    // Výška řádku tak, aby všechny řádky přesně vyplnily okno pod horní lištou (a případným upozorněním).
    const rowHeight = () => {
      const top = $(".topbar").getBoundingClientRect().height;
      return Math.max(10, Math.round(((window.innerHeight - top - 17) / ROWS) * 100) / 100);
    };

    const grid = GS.init({
      column: COLUMNS,
      cellHeight: rowHeight(),
      margin: 8,                     // 16 px mezi bloky – stejně jako na ostatních záložkách
      float: false,
      animate: true,
      staticGrid: true,              // mimo režim úprav je mřížka zamčená
      handle: ".card__title",
      resizable: { handles: "e, se, s, sw, w" },
      draggable: { cancel: "button, input, textarea, select, a, table" },
    }, boardEl);

    const num = (v, fallback) => (Number.isFinite(v) && v >= 0 ? v : fallback);
    const applyLayout = (layout) => {
      grid.batchUpdate();
      DEFAULT_LAYOUT.forEach((def) => {
        const item = layout.find((l) => l.id === def.id) || def;
        const el = boardEl.querySelector(`[gs-id="${def.id}"]`);
        // chybějící nebo neplatné hodnoty doplnit z výchozího rozložení
        if (el) grid.update(el, { x: num(item.x, def.x), y: num(item.y, def.y), w: num(item.w, def.w) || def.w, h: num(item.h, def.h) || def.h });
      });
      grid.batchUpdate(false);
    };
    const saved = store.get("board-layout-v2-24");
    if (Array.isArray(saved)) applyLayout(saved);

    // Pozice brát přímo z GridStacku (grid.save() vynechává hodnoty rovné minimu).
    const saveLayout = () => store.set("board-layout-v2-24",
      grid.engine.nodes.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })));
    grid.on("change", saveLayout);
    $$(".nav__link").forEach((l) => { l.draggable = false; });

    relayout = () => grid.cellHeight(rowHeight());
    window.addEventListener("resize", relayout);

    /* Pořadí položek levého menu – v režimu úprav jde měnit přetažením */
    const navList = $(".nav__list");
    const navItems = () => $$(":scope > li", navList);
    const viewOf = (li) => $(".nav__link", li).dataset.view;
    const DEFAULT_NAV = navItems().map(viewOf);
    const applyNavOrder = (order) => {
      const byView = new Map(navItems().map((li) => [viewOf(li), li]));
      const list = order.filter((v) => byView.has(v));
      // nové položky (v uloženém pořadí chybí) za svého výchozího předchůdce
      DEFAULT_NAV.forEach((v, i) => {
        if (!list.includes(v)) list.splice(i === 0 ? 0 : list.indexOf(DEFAULT_NAV[i - 1]) + 1, 0, v);
      });
      list.forEach((v) => navList.append(byView.get(v)));
    };
    const saveNavOrder = () => store.set("nav-order", navItems().map(viewOf));
    const savedNav = store.get("nav-order");
    if (Array.isArray(savedNav)) applyNavOrder(savedNav);

    let draggedNav = null;
    navList.addEventListener("dragstart", (e) => {
      const li = e.target.closest?.("li");
      if (!li || !app.classList.contains("is-editing")) return;
      draggedNav = li;
      e.dataTransfer.clearData(); // bez adresy odkazu – přetažení mimo menu nic neotevře
      e.dataTransfer.setData("application/x-tips-nav", viewOf(li));
      e.dataTransfer.effectAllowed = "move";
      li.classList.add("is-dragging");
    });
    navList.addEventListener("dragover", (e) => {
      if (!draggedNav) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const over = e.target.closest?.("li");
      if (!over || over === draggedNav) return;
      const r = over.getBoundingClientRect();
      navList.insertBefore(draggedNav, e.clientX > r.left + r.width / 2 ? over.nextSibling : over);
    });
    navList.addEventListener("drop", (e) => { if (draggedNav) e.preventDefault(); });
    navList.addEventListener("dragend", () => {
      if (!draggedNav) return;
      draggedNav.classList.remove("is-dragging");
      draggedNav = null;
      saveNavOrder();
    });

    const editBtn = $("#layout-edit");
    const resetBtn = $("#layout-reset");
    const setEditing = (on) => {
      if (on && app.dataset.view !== "overview") showView("overview");
      grid.setStatic(!on);
      app.classList.toggle("is-editing", on);
      editBtn.setAttribute("aria-pressed", String(on));
      $("span", editBtn).textContent = on ? "Hotovo" : "Upravit rozložení";
      resetBtn.hidden = !on;
      $$(".nav__link").forEach((l) => { l.draggable = on; });
    };
    editBtn.addEventListener("click", () => setEditing(!app.classList.contains("is-editing")));
    resetBtn.addEventListener("click", () => {
      applyLayout(DEFAULT_LAYOUT);
      saveLayout();
      applyNavOrder(DEFAULT_NAV);
      saveNavOrder();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && app.classList.contains("is-editing")) setEditing(false); });
    // Přepnutí na jinou stránku režim úprav ukončí.
    new MutationObserver(() => {
      if (app.dataset.view !== "overview" && app.classList.contains("is-editing")) setEditing(false);
    }).observe(app, { attributes: true, attributeFilter: ["data-view"] });
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
  let updateInfo = null;   // zjištěné novější sestavení { current, latest, url }
  let appBuild = 0;        // číslo sestavení této aplikace

  function renderUpdateBtn(checking = false) {
    updateBtn.disabled = checking;
    updateBtn.classList.toggle("side-btn--busy", checking);
    updateBtn.classList.toggle("side-btn--found", Boolean(updateInfo) && !checking);
    updateBtnLabel.textContent = checking ? "Hledám…" : updateInfo ? `Stáhnout verzi ${updateInfo.latest}` : "Aktualizace";
    updateBtnSub.textContent = checking ? "kontroluji GitHub" : updateInfo ? `máš ${updateInfo.current || "starší"} · nová je ${updateInfo.latest}` : appBuild ? `sestavení ${appBuild}` : "Vyhledat novou verzi";
    updateBtn.title = checking ? "Hledám novou verzi programu…"
      : updateInfo ? `Je k dispozici sestavení ${updateInfo.latest} (máš ${updateInfo.current}). Klikni pro stažení.` : "Vyhledat novou verzi programu";
  }

  function showUpdate(info) {
    if (!info || !info.available) return;
    updateInfo = info;
    updateChip.hidden = false;
    $("span", updateChip).textContent = `Nová verze ${info.latest}`;
    updateChip.title = `Je k dispozici sestavení ${info.latest} (máš ${info.current}). Klikni pro stažení.`;
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
    renderUpdateBtn();
    if (res.ok && res.data.notFound) {                  // vydání bez přihlášení nejde přečíst: ukáže se stránka vydání v prohlížeči
      openExternal(res.data.url);
      toast(`Nové sestavení nejde zjistit automaticky. Otevřel jsem stránku vydání – číslo je v názvu (ty máš ${res.data.current || "starší"}).`);
    } else if (!res.ok) toast(res.error, "error");
    else if (res.data.available) toast(`Je k dispozici sestavení ${res.data.latest} (máš ${res.data.current}). Klikni na „Stáhnout“.`);
    else toast(res.data.current ? `Máš nejnovější verzi (sestavení ${res.data.current}).` : "Máš nejnovější verzi.");
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
    renderMini();
    renderHistory();
    if (!desktop) return;

    const info = await desktop.appInfo();
    if (info) {
      const build = Number((/\.(\d+)$/.exec(info.version || "") || [])[1] || 0);
      if (build) {
        $(".brand").title = `Fotbalové tipy – sestavení ${build}`;
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
    loadMini();

    const age = state.payload?.updatedAt ? Date.now() - Date.parse(state.payload.updatedAt) : Infinity;
    if (age > STALE_MS) refresh();
  }

  // Stavy „před zápasem / zahájen“ se průběžně přepočítávají podle hodin.
  setInterval(() => { if (!state.busy && state.payload) renderTips(); }, 30e3);

  // Skóre rozehraných zápasů se každou minutu zaktualizuje ze SofaScore (nestahuje se všechno znovu).
  setInterval(async () => {
    if (!desktop || state.busy || !state.payload) return;
    const now = Date.now();
    if (!state.payload.tips.some((t) => ["live", "started"].includes(matchState(t, now).kind))) return;
    try {
      const res = await desktop.tips.live();
      if (res.ok && res.data && !state.busy) {
        state.payload = { ...state.payload, tips: res.data };
        renderTips();
      }
    } catch { /* příště */ }
  }, 60e3);

  start();
})();
