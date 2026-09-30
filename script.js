/* J.I.M.M.Y. – interaktivita (UI je plně funkční i bez dat z backendu). */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const renderIcons = () => window.lucide?.createIcons();

  /* Ukládání stavu mezi spuštěními (localStorage je v Electronu trvalý). */
  const store = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(`dashboard:${key}`)); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(`dashboard:${key}`, JSON.stringify(value)); } catch { /* bez úložiště */ }
    },
  };

  /* ---------- Hodiny a datum (česky) ---------- */
  const timeEls = [$("#clock-time")].filter(Boolean);
  const dateEl = $("#clock-date");
  const timeFmt = new Intl.DateTimeFormat("cs-CZ", { hour: "2-digit", minute: "2-digit" });
  const weekdayFmt = new Intl.DateTimeFormat("cs-CZ", { weekday: "long" });
  const dateFmt = new Intl.DateTimeFormat("cs-CZ", { day: "numeric", month: "long", year: "numeric" });

  const tick = () => {
    const now = new Date();
    const time = timeFmt.format(now);
    timeEls.forEach((el) => {
      el.textContent = time;
      el.dateTime = time;
    });
    if (dateEl) {
      const weekday = weekdayFmt.format(now);
      dateEl.textContent = `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${dateFmt.format(now)}`;
    }
  };
  tick();
  setInterval(tick, 1000);

  /* ---------- Navigace ---------- */
  const app = $("#app");
  const menuToggle = $("#menu-toggle");
  const backdrop = $("#sidebar-backdrop");

  const setNav = (open) => {
    app.classList.toggle("is-nav-open", open);
    backdrop.hidden = !open;
    menuToggle.setAttribute("aria-expanded", String(open));
  };
  menuToggle.addEventListener("click", () => setNav(!app.classList.contains("is-nav-open")));
  backdrop.addEventListener("click", () => setNav(false));

  /* Levé menu přepíná pohledy: přehled, nebo jedna sekce přes celou plochu. */
  const VIEWS = ["overview", "assistant", "weather", "news", "tasks", "clipboard", "games"];
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
    try { sessionStorage.setItem("dashboard:view", view); } catch { /* bez úložiště */ }
  };

  $$(".nav__link").forEach((link) => {
    link.title = link.textContent.trim();
    link.addEventListener("click", (e) => {
      e.preventDefault();
      showView(link.dataset.view);
      setNav(false);
    });
  });
  try { showView(sessionStorage.getItem("dashboard:view") || "overview"); } catch { showView("overview"); }

  /* ---------- Klávesové zkratky ---------- */
  const search = $("#search");
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      search.focus();
      search.select();
    }
    if (e.key === "Escape") setNav(false);
  });

  /* ---------- Zprávy: Seznam Zprávy, Novinky.cz, iDNES.cz (živě z RSS) ---------- */
  const newsList = $("#news-list");
  const newsRefresh = $("#news-refresh");
  let articles = [];

  const relativeTime = (ms) => {
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return "právě teď";
    if (min === 1) return "před minutou";
    if (min < 60) return `před ${min} minutami`;
    const h = Math.round(min / 60);
    if (h === 1) return "před hodinou";
    if (h < 24) return `před ${h} hodinami`;
    const d = Math.round(h / 24);
    return d === 1 ? "včera" : `před ${d} dny`;
  };

  const newsStatus = (text, retry = false) => {
    newsList.innerHTML = `<li class="news__status"></li>`;
    const li = $("li", newsList);
    li.textContent = text;
    if (retry) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pill-btn";
      btn.textContent = "Zkusit znovu";
      btn.addEventListener("click", loadNews);
      li.append(btn);
    }
  };

  const renderNews = () => {
    newsList.replaceChildren(...articles.map((a) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <a class="news__item" target="_blank" rel="noopener">
          <span class="news__thumb news__thumb--${a.source}"></span>
          <span class="news__body">
            <span class="news__title"></span>
            <span class="news__meta"><span class="news__source"></span><span class="dot-sep" aria-hidden="true">•</span><span class="news__time"></span></span>
          </span>
        </a>`;
      const link = $("a", li);
      link.href = a.link;
      link.title = a.description;
      $(".news__title", li).textContent = a.title;
      $(".news__source", li).textContent = a.sourceName;
      $(".news__time", li).textContent = relativeTime(a.published);
      const thumb = $(".news__thumb", li);
      thumb.textContent = a.sourceName.charAt(0);
      if (a.image) {
        // Obrázek je rovnou v DOM (skrytý), po načtení překryje písmeno zdroje; při chybě zmizí.
        const img = document.createElement("img");
        img.alt = "";
        img.decoding = "async";
        img.referrerPolicy = "no-referrer";
        img.addEventListener("load", () => thumb.classList.add("has-image"));
        img.addEventListener("error", () => img.remove());
        img.src = a.image;
        thumb.append(img);
      }
      return li;
    }));
  };

  async function loadNews() {
    if (!window.desktop?.fetchNews) {
      newsStatus("Zprávy se načítají jen v desktopové aplikaci.");
      return;
    }
    newsRefresh.disabled = true;
    newsRefresh.classList.add("is-spinning");
    newsList.setAttribute("aria-busy", "true");
    if (!articles.length) newsStatus("Načítám zprávy…");
    try {
      ({ articles } = await window.desktop.fetchNews());
      renderNews();
    } catch {
      if (!articles.length) newsStatus("Zprávy se nepodařilo načíst. Zkontroluj připojení k internetu.", true);
    } finally {
      newsRefresh.disabled = false;
      newsRefresh.classList.remove("is-spinning");
      newsList.setAttribute("aria-busy", "false");
    }
  }
  newsRefresh.addEventListener("click", loadNews);
  setInterval(loadNews, 15 * 60 * 1000);           // nové zprávy každých 15 minut
  setInterval(() => { if (articles.length) renderNews(); }, 60 * 1000); // „před X minutami“

  /* ---------- Úkoly: týdenní kalendář ---------- */
  const pad = (n) => String(n).padStart(2, "0");
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
  const todayKey = () => dateKey(new Date());
  const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const dayNameFmt = new Intl.DateTimeFormat("cs-CZ", { weekday: "long" });
  const dayShortFmt = new Intl.DateTimeFormat("cs-CZ", { weekday: "short" });

  const seedTasks = () => {
    const t = new Date();
    const k = (n) => dateKey(addDays(t, n));
    return [
      { title: "Zkontrolovat ceny na Alza.cz (grafická karta)", date: k(0), time: "16:00" },
      { title: "Trénink", date: k(0), time: "17:00", done: true },
      { title: "Dokončit video pro YouTube", date: k(0), time: "19:00" },
      { title: "Diablo IV – Season push", date: k(0), time: "20:00" },
      { title: "Zavolat do banky", date: k(1), time: "10:00" },
      { title: "Napsat poznámky k Diablo IV buildu", date: k(1), time: "21:00" },
      { title: "Plán na víkend – Sapa?", date: k(3), time: "" },
    ].map((task, i) => ({ id: `seed-${i}`, done: false, ...task }));
  };

  let tasks = store.get("week-tasks");
  if (!Array.isArray(tasks)) tasks = seedTasks();
  const saveTasks = () => store.set("week-tasks", tasks);

  let selectedDay = todayKey();
  let weekStart = mondayOf(new Date());

  const taskList = $("#task-list");
  const weekEl = $("#week");
  const byTime = (a, b) => (a.time || "99").localeCompare(b.time || "99") || a.title.localeCompare(b.title, "cs");

  /* Opakování: "none" | "daily" (každý den) | "weekly" (každý týden ve stejný den).
     U opakovaných úkolů se splnění ukládá zvlášť pro každý den (doneDates). */
  const REPEAT_LABEL = { daily: "každý den", weekly: "každý týden" };
  const weekdayOf = (key) => new Date(`${key}T00:00`).getDay();
  const occursOn = (t, key) => {
    if (!t.repeat || t.repeat === "none") return t.date === key;
    if (key < t.date) return false;
    return t.repeat === "daily" || weekdayOf(key) === weekdayOf(t.date);
  };
  const isDone = (t, key) => (t.repeat && t.repeat !== "none" ? (t.doneDates || []).includes(key) : Boolean(t.done));
  const setDone = (t, key, done) => {
    if (t.repeat && t.repeat !== "none") {
      const dates = new Set(t.doneDates || []);
      if (done) dates.add(key); else dates.delete(key);
      t.doneDates = [...dates];
    } else {
      t.done = done;
    }
  };
  const tasksFor = (key) => tasks.filter((t) => occursOn(t, key)).sort(byTime);

  const renderDay = () => {
    const d = new Date(`${selectedDay}T00:00`);
    const label = selectedDay === todayKey() ? "Dnes" : capitalize(dayNameFmt.format(d));
    $("#day-title").textContent = `${label} ${d.getDate()}. ${d.getMonth() + 1}.`;

    const list = tasksFor(selectedDay);
    taskList.replaceChildren(...list.map((task) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <label class="task">
          <input class="checkbox" type="checkbox">
          <span class="task__text">
            <span class="task__title"></span>
            <span class="task__due"></span>
          </span>
        </label>
        <button class="task__delete icon-btn icon-btn--xs" type="button" aria-label="Smazat úkol"><i data-lucide="x"></i></button>`;
      $(".task__title", li).textContent = task.title;
      const due = $(".task__due", li);
      due.textContent = task.time || "Kdykoliv";
      if (REPEAT_LABEL[task.repeat]) {
        const rep = document.createElement("span");
        rep.className = "task__repeat";
        rep.innerHTML = `<i data-lucide="repeat"></i>`;
        rep.append(REPEAT_LABEL[task.repeat]);
        due.append(rep);
      }
      const box = $(".checkbox", li);
      box.checked = isDone(task, selectedDay);
      box.addEventListener("change", () => { setDone(task, selectedDay, box.checked); saveTasks(); renderWeek(); });
      $(".task__delete", li).addEventListener("click", () => {
        if (REPEAT_LABEL[task.repeat]
          && !window.confirm(`Smazat opakovaný úkol „${task.title}“ včetně všech opakování?`)) return;
        tasks = tasks.filter((t) => t !== task);
        saveTasks();
        renderAll();
      });
      return li;
    }));
    if (!list.length) {
      const li = document.createElement("li");
      li.className = "task-list__empty";
      li.textContent = "Na tento den nemáš žádné úkoly.";
      taskList.append(li);
    }
    renderIcons();
  };

  const renderWeek = () => {
    const end = addDays(weekStart, 6);
    const sameMonth = weekStart.getMonth() === end.getMonth();
    $("#week-today").textContent = sameMonth
      ? `${weekStart.getDate()}.–${end.getDate()}. ${end.getMonth() + 1}. ${end.getFullYear()}`
      : `${weekStart.getDate()}. ${weekStart.getMonth() + 1}. – ${end.getDate()}. ${end.getMonth() + 1}. ${end.getFullYear()}`;

    weekEl.replaceChildren(...Array.from({ length: 7 }, (_, i) => {
      const d = addDays(weekStart, i);
      const key = dateKey(d);
      const list = tasksFor(key);
      const open = list.filter((t) => !isDone(t, key));
      const li = document.createElement("li");
      li.innerHTML = `
        <button class="day" type="button">
          <span class="day__date"><span class="day__name"></span><span class="day__num"></span></span>
          <span class="day__tasks"></span>
          <span class="day__count"></span>
        </button>`;
      const btn = $("button", li);
      btn.classList.toggle("is-today", key === todayKey());
      btn.classList.toggle("is-selected", key === selectedDay);
      btn.classList.toggle("is-weekend", i >= 5);
      btn.setAttribute("aria-pressed", String(key === selectedDay));
      $(".day__name", li).textContent = capitalize(dayShortFmt.format(d));
      $(".day__num", li).textContent = `${d.getDate()}.`;
      $(".day__tasks", li).textContent = list.length
        ? list.map((t) => (t.time ? `${t.time} ${t.title}` : t.title)).join("\n")
        : "—";
      $(".day__count", li).textContent = open.length ? open.length : "";
      btn.setAttribute("aria-label", `${capitalize(dayNameFmt.format(d))} ${d.getDate()}. ${d.getMonth() + 1}., úkolů: ${list.length}`);
      btn.addEventListener("click", () => { selectedDay = key; renderWeek(); renderDay(); });
      return li;
    }));
  };

  const renderAll = () => { renderWeek(); renderDay(); };

  $("#week-prev").addEventListener("click", () => { weekStart = addDays(weekStart, -7); renderWeek(); });
  $("#week-next").addEventListener("click", () => { weekStart = addDays(weekStart, 7); renderWeek(); });
  $("#week-today").addEventListener("click", () => {
    weekStart = mondayOf(new Date());
    selectedDay = todayKey();
    renderAll();
  });

  $("#task-add").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#task-input");
    const time = $("#task-time");
    const title = input.value.trim();
    if (!title) return;
    const repeat = $("#task-repeat");
    tasks.push({ id: `${Date.now()}`, title, date: selectedDay, time: time.value, repeat: repeat.value, done: false, doneDates: [] });
    repeat.value = "none";
    saveTasks();
    input.value = "";
    time.value = "";
    renderAll();
  });

  // Po půlnoci se přepne „dnes“.
  let lastToday = todayKey();
  setInterval(() => {
    if (todayKey() === lastToday) return;
    if (selectedDay === lastToday) selectedDay = todayKey();
    lastToday = todayKey();
    weekStart = mondayOf(new Date());
    renderAll();
  }, 60 * 1000);

  renderAll();

  /* ---------- Počasí: Teplice (Open-Meteo) ---------- */
  const forecastDayFmt = new Intl.DateTimeFormat("cs-CZ", { weekday: "short" });
  const setIcon = (use, id) => use.setAttribute("href", `#${id}`);

  const renderWeather = (w) => {
    const c = w.current;
    $("#wx-place").textContent = w.place;
    $("#wx-temp").textContent = c.temperature;
    $("#wx-cond").textContent = c.text;
    $("#wx-meta").innerHTML = "";
    $("#wx-meta").append(
      `Vlhkost: ${c.humidity}%`,
      Object.assign(document.createElement("span"), { className: "dot-sep", textContent: "•", ariaHidden: "true" }),
      `Vítr: ${c.wind} km/h`,
    );
    setIcon($("#wx-icon"), c.icon);

    $("#wx-forecast").replaceChildren(...w.daily.map((d, i) => {
      const li = document.createElement("li");
      li.className = "forecast__day";
      li.title = d.text;
      li.innerHTML = `
        <span class="forecast__name"></span>
        <svg class="forecast__icon" role="img"><use></use></svg>
        <span class="forecast__hi"></span><span class="forecast__lo"></span>`;
      const name = i === 0 ? "Dnes" : i === 1 ? "Zítra" : capitalize(forecastDayFmt.format(new Date(`${d.date}T12:00`)));
      $(".forecast__name", li).textContent = name;
      $("svg", li).setAttribute("aria-label", d.text);
      setIcon($("use", li), d.icon);
      $(".forecast__hi", li).textContent = `${d.max}°`;
      $(".forecast__lo", li).textContent = `${d.min}°`;
      return li;
    }));
  };

  async function loadWeather() {
    if (!window.desktop?.fetchWeather) {
      $("#wx-cond").textContent = "Počasí se načítá jen v desktopové aplikaci.";
      return;
    }
    try {
      renderWeather(await window.desktop.fetchWeather());
    } catch {
      if ($("#wx-temp").textContent === "–") $("#wx-cond").textContent = "Počasí se nepodařilo načíst.";
    }
  }
  setInterval(loadWeather, 30 * 60 * 1000); // každých 30 minut

  /* ---------- AI asistent: Gemini ve webview ---------- */
  const setupGemini = () => {
    const host = $("#gemini");
    const status = $("#gemini-status");
    const setStatus = (text, state) => {
      status.innerHTML = `<span class="status-dot${state ? ` status-dot--${state}` : ""}"></span>`;
      status.append(`Gemini · ${text}`);
    };

    const view = document.createElement("webview");
    view.className = "gemini__view";
    view.setAttribute("partition", "persist:gemini"); // trvalé úložiště → přihlášení vydrží
    view.setAttribute("src", "https://gemini.google.com/app");
    view.setAttribute("allowpopups", "");
    host.replaceChildren(view);

    // Hláška místo prázdné (bílé) plochy, když se Gemini nenačte.
    const error = document.createElement("div");
    error.className = "gemini__error";
    error.hidden = true;
    error.innerHTML = `
      <p>Gemini se nepodařilo načíst. Zkontroluj připojení k internetu.</p>
      <div class="gemini__error-actions">
        <button class="btn btn--primary btn--sm" type="button" data-gemini="retry">Zkusit znovu</button>
        <button class="pill-btn" type="button" data-gemini="external">Otevřít v prohlížeči</button>
      </div>`;
    host.append(error);
    $('[data-gemini="retry"]', error).addEventListener("click", () => view.reload());
    $('[data-gemini="external"]', error).addEventListener("click", () => window.desktop.openGeminiExternal());

    let failed = false;
    view.addEventListener("did-start-loading", () => {
      failed = false;
      error.hidden = true;
      setStatus("načítám…");
    });
    view.addEventListener("did-fail-load", (e) => {
      if (!e.isMainFrame || e.errorCode === -3) return; // -3 = přerušeno přesměrováním, není chyba
      failed = true;
    });
    view.addEventListener("did-stop-loading", () => {
      error.hidden = !failed;
      setStatus(failed ? "nedostupné" : "online", failed ? "" : "green");
    });

    $("#gemini-reload").addEventListener("click", () => view.reload());
    $("#gemini-external").addEventListener("click", () => window.desktop.openGeminiExternal());
  };

  /* ---------- Chytrá schránka ---------- */
  const setupClipboard = () => {
    const api = window.desktop.clipboard;
    const ai = window.desktop.ai;
    const list = $("#clip-list");
    const search = $("#clip-search");
    const textEl = $("#clip-text");
    const status = $("#ai-status");
    const output = $("#ai-output");
    let items = [];
    let selectedId = null;

    const timeFmt2 = new Intl.DateTimeFormat("cs-CZ", { hour: "2-digit", minute: "2-digit" });
    const dateFmt2 = new Intl.DateTimeFormat("cs-CZ", { day: "numeric", month: "numeric" });
    const when = (ms) => {
      const d = new Date(ms);
      return dateKey(d) === todayKey() ? timeFmt2.format(d) : `${dateFmt2.format(d)} ${timeFmt2.format(d)}`;
    };
    const flash = (text, kind = "") => {
      status.textContent = text;
      status.dataset.kind = kind;
    };

    const render = () => {
      const q = search.value.trim().toLowerCase();
      const shown = items
        .filter((it) => !q || it.text.toLowerCase().includes(q))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned)); // připnuté nahoře, jinak od nejnovějších
      if (!shown.length) {
        list.innerHTML = `<li class="clip__empty"></li>`;
        $("li", list).textContent = items.length ? "Nic nenalezeno." : "Zatím prázdné – zkopíruj nějaký text (Ctrl+C).";
        return;
      }
      list.replaceChildren(...shown.map((it) => {
        const li = document.createElement("li");
        li.className = "clip-item";
        li.classList.toggle("is-selected", it.id === selectedId);
        li.classList.toggle("is-pinned", it.pinned);
        li.innerHTML = `
          <button class="clip-item__main" type="button" title="Klik = vybrat a zkopírovat">
            <span class="clip-item__text"></span>
            <span class="clip-item__meta"></span>
          </button>
          <div class="clip-item__tools">
            <button class="icon-btn icon-btn--xs" type="button" data-act="paste" aria-label="Zkopírovat a přepnout zpět (pak Ctrl+V)" title="Zkopírovat a přepnout zpět (pak Ctrl+V)"><i data-lucide="clipboard-paste"></i></button>
            <button class="icon-btn icon-btn--xs" type="button" data-act="pin"><i data-lucide="${it.pinned ? "pin-off" : "pin"}"></i></button>
            <button class="icon-btn icon-btn--xs clip-item__del" type="button" data-act="delete" aria-label="Smazat" title="Smazat"><i data-lucide="trash-2"></i></button>
          </div>`;
        $(".clip-item__text", li).textContent = it.text;
        $(".clip-item__meta", li).textContent = `${when(it.time)} · ${it.text.length} znaků${it.pinned ? " · připnuto" : ""}`;
        const pinBtn = $('[data-act="pin"]', li);
        pinBtn.setAttribute("aria-label", it.pinned ? "Odepnout" : "Připnout");
        pinBtn.title = pinBtn.getAttribute("aria-label");
        $(".clip-item__main", li).addEventListener("click", () => {
          selectedId = it.id;
          textEl.value = it.text;
          api.copy(it.id);
          flash("Zkopírováno do schránky – vlož pomocí Ctrl+V.", "ok");
          render();
        });
        $('[data-act="paste"]', li).addEventListener("click", () => api.paste(it.id));
        pinBtn.addEventListener("click", () => api.pin(it.id));
        $('[data-act="delete"]', li).addEventListener("click", () => api.remove(it.id));
        return li;
      }));
      renderIcons();
    };

    const apply = ({ history, paused }) => {
      items = history;
      $("#clip-pause").checked = paused;
      render();
    };
    api.list().then(apply);
    api.onUpdate(apply);
    search.addEventListener("input", render);
    $("#clip-pause").addEventListener("change", (e) => api.pause(e.target.checked));
    $("#clip-clear").addEventListener("click", () => {
      if (window.confirm("Vymazat historii schránky? Připnuté položky zůstanou.")) api.clear();
    });

    const current = () => textEl.value;
    $("#clip-copy").addEventListener("click", () => {
      if (!current()) return;
      api.copyText(current());
      flash("Zkopírováno do schránky.", "ok");
    });
    $("#clip-paste").addEventListener("click", () => { if (current()) api.pasteText(current()); });

    /* AI úpravy */
    const keyForm = $("#ai-key-form");
    let hasKey = false;
    const refreshKey = async () => {
      hasKey = await ai.hasKey();
      $("#ai-key-btn").classList.toggle("is-set", hasKey);
      $("#ai-key").placeholder = hasKey ? "Klíč je uložený – zadej nový pro změnu" : "Gemini API klíč";
    };
    refreshKey();
    $("#ai-key-btn").addEventListener("click", () => { keyForm.hidden = !keyForm.hidden; if (!keyForm.hidden) $("#ai-key").focus(); });
    keyForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!$("#ai-key").value.trim()) return;
      await ai.setKey($("#ai-key").value);
      $("#ai-key").value = "";
      keyForm.hidden = true;
      await refreshKey();
      flash("API klíč uložen.", "ok");
    });
    $("#ai-key-remove").addEventListener("click", async () => {
      await ai.setKey("");
      await refreshKey();
      flash("API klíč odebrán.");
    });

    const run = async (instruction) => {
      const text = current().trim();
      if (!text) { flash("Nejdřív vyber nebo napiš text.", "error"); textEl.focus(); return; }
      if (!hasKey) {
        // Bez API klíče: připravit zadání do schránky a otevřít Gemini (stačí Ctrl+V a Enter)
        await api.copyText(`${instruction}\n\n${text}`);
        showView("assistant");
        flash("Zadání je ve schránce – v Gemini ho vlož (Ctrl+V) a odešli. Pro úpravy přímo tady nastav API klíč 🔑.");
        return;
      }
      $$("#ai-actions button, #ai-custom button").forEach((b) => { b.disabled = true; });
      flash("Gemini upravuje text…", "busy");
      const res = await ai.transform(text, instruction);
      $$("#ai-actions button, #ai-custom button").forEach((b) => { b.disabled = false; });
      if (!res.ok) {
        flash(res.error === "NO_KEY" ? "Chybí API klíč." : `Chyba: ${res.error}`, "error");
        return;
      }
      output.value = res.text;
      $("#ai-result").hidden = false;
      flash("Hotovo.", "ok");
    };
    $$("#ai-actions [data-ai]").forEach((b) => b.addEventListener("click", () => run(b.dataset.ai)));
    $("#ai-custom").addEventListener("submit", (e) => {
      e.preventDefault();
      const instruction = $("#ai-instruction").value.trim();
      if (instruction) run(instruction);
    });
    $("#ai-use").addEventListener("click", () => { textEl.value = output.value; });
    $("#ai-copy").addEventListener("click", () => { api.copyText(output.value); flash("Výsledek zkopírován.", "ok"); });
    $("#ai-paste").addEventListener("click", () => api.pasteText(output.value));
  };

  /* ---------- Desktop (Electron): ovládání okna ---------- */
  const desktop = window.desktop;
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

  loadNews();
  loadWeather();
  if (desktop) {
    setupGemini();
    setupClipboard();
    desktop.onShowView((view) => showView(view));
  }

  renderIcons();
})();
