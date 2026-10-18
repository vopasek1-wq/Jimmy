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
  const nextDay = (day) => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  };
  const fmtPct = (v) => (v === null || v === undefined ? "–" : `${nf1.format(v)} %`);
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
  const DAYS = ["today", "tomorrow", "both", "all"];

  const state = {
    payload: null,            // poslední data z hlavního procesu
    error: null,              // chyba celého stahování (text)
    busy: false,
    limits: { minProbability: 60, minOdds: 1.5, highProbability: 75 },
    tipsportUrl: "https://www.tipsport.cz/",
    day: DAYS.includes(store.get("day")) ? store.get("day") : "today",
    hideStarted: store.get("hide-started") === true,
    onlyConfirmed: store.get("only-confirmed") === true,
    query: "",
    sort: store.get("sort") || { key: "time", dir: "asc" },
    selected: null,           // klíč vybraného tipu
    visible: [],              // právě zobrazené tipy (po filtrech a řazení)
    history: null,            // { tips, stats } pro vybrané období
    mini: null,               // totéž za 30 dní (karta na Přehledu)
    period: ["7", "30", "all"].includes(store.get("period")) ? store.get("period") : "30",
    from: "",                 // rozsah dnů z kalendáře (RRRR-MM-DD); prázdný = platí „Období“
    to: "",
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
  const copyText = async (text) => {
    if (desktop) return desktop.copyText(text);
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
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
  const VIEWS = ["overview", "tips", "history"];
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
    fb: (t) => t.probForebet,
    source: (t) => t.sources.join(" + "),
    status: (t) => matchState(t).order,
  };
  const HIST_SORT = {
    ...TIP_SORT,
    score: (t) => (t.homeScore !== null && t.awayScore !== null ? t.homeScore * 100 + t.awayScore : null),
    outcome: (t) => OUTCOME_ORDER[t.outcome] ?? null,
  };
  const DESC_FIRST = new Set(["prob", "odds", "fb", "score"]);

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
      case "both": return t.day === today || t.day === tomorrow;
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
      if (state.hideStarted && matchState(t, now).kind !== "wait") return false;
      if (state.onlyConfirmed && !(t.probForebet !== null && t.probForebet > state.limits.minProbability)) return false;
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
  $("#f-started").addEventListener("click", () => {
    state.hideStarted = !state.hideStarted;
    store.set("hide-started", state.hideStarted);
    renderTips();
  });
  $("#f-confirmed").addEventListener("click", () => {
    state.onlyConfirmed = !state.onlyConfirmed;
    store.set("only-confirmed", state.onlyConfirmed);
    renderTips();
  });
  bindSort($("#tips-table"), "data-sort", () => state.sort, (s) => { state.sort = s; store.set("sort", s); }, () => renderTips());

  /* ---------- Tipy: tabulka ---------- */
  const tipsBody = $("#tips-body");

  const rowHtml = (t, now) => {
    const ms = matchState(t, now);
    const key = tipUid(t);
    const selected = key === state.selected;
    const fb = t.probForebet !== null ? fmtPct(t.probForebet) : (forebetCovers(t.tipCode) ? "–" : "n/a");
    return `<tr class="trow is-${t.probClass}${selected ? " is-selected" : ""}${ms.kind === "done" ? " is-done" : ""}" data-key="${esc(key)}" tabindex="${selected ? 0 : -1}" aria-selected="${selected}">
      <td class="c-time">${esc(fmtKickoff(t.kickoff))}</td>
      <td class="c-match"><span class="match">${esc(t.matchName)}</span><span class="match__league">${esc(t.leagueShort)}</span></td>
      <td class="c-tip">${esc(t.tipLabel)}</td>
      <td class="c-prob"><span class="pill pill--${t.probClass}"${t.probSource !== "Scores24" ? ` title="Scores24 procento neuvedl – hodnota z ${esc(t.probSource)}"` : ""}>${esc(fmtPct(t.probability))}</span></td>
      <td class="c-odds"${t.oddsEstimated ? ' title="Odhad z pravděpodobnosti – zdroj kurz neuvedl"' : ""}>${esc(fmtOdds(t))}</td>
      <td class="c-fb"${fb === "n/a" ? ' title="Forebet tento trh nehodnotí"' : ""}>${esc(fb)}</td>
      <td class="c-status"><span class="state state--${ms.kind === "live" || ms.kind === "started" ? "live" : ms.kind === "done" ? "done" : "wait"}">${esc(ms.text)}</span></td>
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
    $("#f-started").setAttribute("aria-pressed", String(state.hideStarted));
    $("#f-confirmed").setAttribute("aria-pressed", String(state.onlyConfirmed));
    markSort($("#tips-table"), "data-sort", state.sort);

    const p = state.payload;
    const total = p?.tips.length || 0;
    $("#tips-note").textContent = p && p.updatedLabel
      ? `${state.visible.length} z ${total} · aktualizováno ${p.updatedLabel}`
      : (total ? `${state.visible.length} z ${total}` : "");

    renderDetail();
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
        <button class="btn btn--primary btn--sm" type="button" data-act="tipsport" title="Zkopíruje název zápasu a otevře Tipsport"><i data-lucide="external-link"></i>Najít v Tipsportu</button>
        <button class="btn btn--ghost btn--sm" type="button" data-act="copy"><i data-lucide="copy"></i>Kopírovat tip</button>
        ${t.url ? '<button class="btn btn--ghost btn--sm" type="button" data-act="scores24"><i data-lucide="external-link"></i>Scores24</button>' : ""}
        ${t.sofascoreUrl ? '<button class="btn btn--ghost btn--sm" type="button" data-act="sofascore"><i data-lucide="external-link"></i>SofaScore</button>' : ""}
      </div>`;
    renderIcons();
  }

  detailEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    const t = tipByKey(state.selected);
    if (!btn || !t) return;
    switch (btn.dataset.act) {
      case "tipsport":
        await copyText(t.matchName);
        toast(`Název zápasu „${t.matchName}“ je zkopírovaný – vlož ho do hledání na Tipsportu.`);
        openExternal(state.tipsportUrl);
        break;
      case "copy": {
        const odds = t.odds ? `, kurz ${t.oddsEstimated ? "~" : ""}${nf2.format(t.odds)}` : "";
        await copyText(`${t.matchName} – ${t.tipLabel} (${fmtPct(t.probability)}${odds})`);
        toast("Tip je zkopírovaný do schránky.");
        break;
      }
      case "scores24": openExternal(t.url); break;
      case "sofascore": openExternal(t.sofascoreUrl); break;
      default: break;
    }
  });

  /* ---------- Upozornění (zdroj selhal, bez internetu…) ---------- */
  const noticeEl = $("#notice");
  function renderNotice() {
    const warnings = [];
    if (state.error) warnings.push(`Stahování selhalo: ${state.error}`);
    if (state.payload) warnings.push(...state.payload.warnings);
    if (!desktop) warnings.push("Aplikace neběží v okně Electronu – stahování tipů není k dispozici.");
    const forebetFailed = state.payload?.statuses?.Forebet?.state === "failed";
    noticeEl.hidden = warnings.length === 0;
    if (warnings.length) {
      const icon = state.payload?.offline ? "wifi-off" : "triangle-alert";
      noticeEl.innerHTML = `<i data-lucide="${icon}"></i><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
        ${forebetFailed && desktop ? '<button class="btn btn--ghost btn--sm" type="button" data-act="verify" title="Otevře okno, ve kterém projdeš ověřením Cloudflare"><i data-lucide="shield-check"></i>Ověřit Forebet</button>' : ""}`;
      renderIcons();
    } else {
      noticeEl.innerHTML = "";
    }
    syncLayoutMetrics();
  }

  noticeEl.addEventListener("click", (e) => { if (e.target.closest("button[data-act='verify']")) refresh({ verify: true }); });

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

  const days = (period) => (period === "all" ? null : Number(period));
  const fetchHistory = async (period, range = null) => {
    if (!desktop) return null;
    const res = await desktop.history.list(range || days(period));
    return res.ok ? res.data : null;
  };

  async function loadHistory() {
    const data = await fetchHistory(state.period, state.from || state.to ? { from: state.from, to: state.to } : null);
    if (data) state.history = data;
    renderHistory();
  }
  async function loadMini() {
    const data = await fetchHistory("30");
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
    const custom = Boolean(state.from || state.to);
    $("#period").value = custom ? "custom" : state.period;
    $("#date-from").value = state.from;
    $("#date-to").value = state.to;
    $("#date-clear").hidden = !custom;
    markSort($("#history-table"), "data-hsort", state.hsort);
    if (!h) {
      $("#history-stats").innerHTML = "";
      histBody.innerHTML = "";
      $("#history-empty").hidden = false;
      $("#history-empty").textContent = desktop ? "Historie se načítá…" : "Historie je dostupná jen v aplikaci.";
      syncOutcomeButtons();
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

    const list = sortList(h.tips.filter(matchesQuery), HIST_SORT, state.hsort);
    if (!list.some((t) => t.id === state.hselected)) state.hselected = null;
    histBody.innerHTML = list.map((t) => {
      const ov = OUTCOME_VIEW[t.outcome];
      const outcome = ov
        ? `<span class="outcome outcome--${t.outcome}"><i data-lucide="${ov.icon}"></i>${ov.text}</span>`
        : '<span class="outcome outcome--none">—</span>';
      const sel = t.id === state.hselected;
      return `<tr class="trow${t.outcome ? ` is-${t.outcome}` : ""}${sel ? " is-selected" : ""}" data-key="${esc(t.id)}" tabindex="${sel ? 0 : -1}" aria-selected="${sel}">
        <td class="c-time">${esc(fmtKickoff(t.kickoff))}</td>
        <td class="c-match"><span class="match">${esc(t.matchName)}</span><span class="match__league">${esc(t.leagueShort)}</span></td>
        <td class="c-tip">${esc(t.tipLabel)}</td>
        <td class="c-prob"><span class="pill pill--${t.probClass}">${esc(fmtPct(t.probability))}</span></td>
        <td class="c-odds">${esc(fmtOdds(t))}</td>
        <td class="c-score">${esc(fmtScore(t) || "–")}</td>
        <td class="c-outcome">${outcome}</td></tr>`;
    }).join("");
    if (list.length && !$(`tr[tabindex="0"]`, histBody)) histBody.firstElementChild.tabIndex = 0;
    const empty = $("#history-empty");
    empty.hidden = list.length > 0;
    empty.textContent = h.tips.length ? "Hledání neodpovídá žádný tip." : "V historii zatím nejsou žádné tipy.";
    $("#history-table").hidden = list.length === 0;
    syncOutcomeButtons();
    renderIcons();
  }

  const selectedHistoryTip = () => state.history?.tips.find((t) => t.id === state.hselected);
  function syncOutcomeButtons() {
    const t = selectedHistoryTip();
    $$("[data-outcome]").forEach((b) => {
      b.disabled = !t;
      b.setAttribute("aria-pressed", String(Boolean(t) && (b.dataset.outcome === t.outcome)));
    });
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
    syncOutcomeButtons();
  };
  bindRows(histBody, selectHistory, (key) => {
    const t = state.history?.tips.find((x) => x.id === Number(key));
    if (t) openExternal(t.url || t.sofascoreUrl);
  });
  bindSort($("#history-table"), "data-hsort", () => state.hsort, (s) => { state.hsort = s; store.set("hsort", s); }, () => renderHistory());

  const onDates = () => {
    state.from = $("#date-from").value;
    state.to = $("#date-to").value;
    if (state.from && state.to && state.from > state.to) [state.from, state.to] = [state.to, state.from];
    loadHistory();
  };
  $("#date-from").addEventListener("change", onDates);
  $("#date-to").addEventListener("change", onDates);
  $("#date-clear").addEventListener("click", () => {
    state.from = "";
    state.to = "";
    loadHistory();
  });

  $("#period").addEventListener("change", (e) => {
    state.from = "";
    state.to = "";
    state.period = e.target.value;
    store.set("period", state.period);
    loadHistory();
  });

  $$("[data-outcome]").forEach((b) => {
    b.addEventListener("click", async () => {
      const t = selectedHistoryTip();
      if (!t || !desktop) return;
      const outcome = b.dataset.outcome === "clear" ? null : b.dataset.outcome;
      const res = await desktop.history.setOutcome(t.id, outcome);
      if (!res.ok) { toast(`Výsledek se nepodařilo uložit: ${res.error}`, "error"); return; }
      await loadHistory();
      loadMini();
    });
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

  /* ---------- Vykreslení všeho ---------- */
  function renderAll() {
    renderTips();
    renderNotice();
    renderChip();
  }

  /* ---------- Přizpůsobitelná mřížka Přehledu (GridStack) ---------- */
  let relayout = () => {};
  function syncLayoutMetrics() {
    const h = noticeEl.hidden ? 0 : noticeEl.offsetHeight + 8;
    document.documentElement.style.setProperty("--notice-h", `${h}px`);
    relayout();
    return h;
  }

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
      const notice = noticeEl.hidden ? 0 : noticeEl.offsetHeight + 8;
      return Math.max(10, Math.round(((window.innerHeight - top - 8 - notice) / ROWS) * 100) / 100);
    };

    const grid = GS.init({
      column: COLUMNS,
      cellHeight: rowHeight(),
      margin: 4,                     // 8 px mezi bloky
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
      navList.insertBefore(draggedNav, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
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
      state.limits = { ...state.limits, ...info.limits };
      state.tipsportUrl = info.tipsportUrl || state.tipsportUrl;
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

  start();
})();
