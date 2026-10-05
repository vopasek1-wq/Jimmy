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
  const VIEWS = ["overview", "assistant", "chatgpt", "weather", "news", "tasks", "clipboard", "games"];
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
      if (app.classList.contains("is-editing")) return; // v režimu úprav se položky jen přesouvají
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

  /* Opakování: "none" | "daily" (každý den) | "weekdays" (Po–Pá) | "weekly" (každý týden ve stejný den).
     U opakovaných úkolů se splnění ukládá zvlášť pro každý den (doneDates),
     přesunuté/vynechané výskyty jsou ve skipDates. */
  const REPEAT_LABEL = { daily: "každý den", weekdays: "každý pracovní den", weekly: "každý týden" };
  const weekdayOf = (key) => new Date(`${key}T00:00`).getDay();
  const occursOn = (t, key) => {
    if (!t.repeat || t.repeat === "none") return t.date === key;
    if (key < t.date || (t.skipDates || []).includes(key)) return false;
    if (t.repeat === "daily") return true;
    if (t.repeat === "weekdays") { const wd = weekdayOf(key); return wd >= 1 && wd <= 5; }
    return weekdayOf(key) === weekdayOf(t.date);
  };

  /* Přesun úkolu na jiný den (přetažením na den v týdnu).
     Jednorázový úkol se přesune; u opakovaného se přesune jen tento výskyt. */
  const moveTask = (task, fromKey, toKey) => {
    if (!task || fromKey === toKey) return;
    if (REPEAT_LABEL[task.repeat]) {
      task.skipDates = [...new Set([...(task.skipDates || []), fromKey])];
      tasks.push({
        id: `${Date.now()}`, title: task.title, date: toKey, time: task.time, repeat: "none",
        done: isDone(task, fromKey), doneDates: [],
      });
    } else {
      task.date = toKey;
    }
    saveTasks();
    selectedDay = toKey;
    renderAll();
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
      li.draggable = true;
      li.title = "Přetáhni na jiný den v týdnu";
      li.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("application/x-jimmy-task", JSON.stringify({ id: task.id, from: selectedDay }));
        e.dataTransfer.effectAllowed = "move";
        li.classList.add("is-dragging");
        weekEl.classList.add("is-drop-target");
      });
      li.addEventListener("dragend", () => {
        li.classList.remove("is-dragging");
        weekEl.classList.remove("is-drop-target");
      });
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
      // Cíl přetažení úkolu
      btn.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes("application/x-jimmy-task")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        btn.classList.add("is-drop");
      });
      btn.addEventListener("dragleave", () => btn.classList.remove("is-drop"));
      btn.addEventListener("drop", (e) => {
        e.preventDefault();
        btn.classList.remove("is-drop");
        try {
          const { id, from } = JSON.parse(e.dataTransfer.getData("application/x-jimmy-task"));
          moveTask(tasks.find((t) => t.id === id), from, key);
        } catch { /* neplatná data */ }
      });
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

  /* Hodinový graf (Chart.js): teplota = křivka, pravděpodobnost srážek = sloupce */
  let wxChart = null;
  const renderWeatherChart = (hourly) => {
    const canvas = $("#wx-chart");
    if (!window.Chart || !canvas) return;
    const labels = hourly.map((h) => `${h.hour}h`);
    const temps = hourly.map((h) => h.temp);
    const pops = hourly.map((h) => h.pop);
    if (wxChart) {
      wxChart.data.labels = labels;
      wxChart.data.datasets[0].data = temps;
      wxChart.data.datasets[1].data = pops;
      wxChart.update();
      return;
    }
    const grid = "rgba(148, 176, 214, 0.08)";
    wxChart = new window.Chart(canvas, {
      data: {
        labels,
        datasets: [
          {
            type: "line", label: "Teplota (°C)", data: temps, yAxisID: "y",
            borderColor: "#56cbff", backgroundColor: "rgba(86, 203, 255, 0.12)", fill: true,
            tension: 0.35, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
          },
          {
            type: "bar", label: "Srážky (%)", data: pops, yAxisID: "y1",
            backgroundColor: "rgba(59, 143, 240, 0.45)", borderRadius: 3, barPercentage: 0.8,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => `${items[0].label.replace("h", "")}:00`,
              label: (ctx) => (ctx.dataset.yAxisID === "y" ? ` ${ctx.parsed.y} °C` : ` srážky ${ctx.parsed.y} %`),
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: "#8d9cae", font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
          y: { position: "left", grid: { color: grid }, ticks: { color: "#8d9cae", font: { size: 10 }, maxTicksLimit: 5, callback: (v) => `${v}°` } },
          y1: { position: "right", min: 0, max: 100, grid: { display: false }, ticks: { color: "#5f7ea8", font: { size: 10 }, stepSize: 50, callback: (v) => `${v}%` } },
        },
      },
    });
  };

  /* Doporučení: Gemini (s API klíčem), jinak pravidla z hodinových dat */
  const ruleTip = (w) => {
    const today = w.hourly.slice(0, 16); // příštích 16 hodin
    const wet = today.filter((h) => h.pop >= 50 || h.precip >= 0.3);
    const maybe = today.filter((h) => h.pop >= 30);
    const temps = today.map((h) => h.temp);
    const min = Math.round(Math.min(...temps));
    const max = Math.round(Math.max(...temps));
    const range = (list) => (list.length === 1 ? `kolem ${list[0].hour} h` : `mezi ${list[0].hour} a ${list[list.length - 1].hour + 1} h`);
    const parts = [];
    if (wet.length) {
      const peak = Math.max(...wet.map((h) => h.pop));
      const snow = wet.some((h) => h.icon === "wx-snow");
      parts.push(`${snow ? "Bude sněžit" : "Zmokneš"} ${range(wet)} (až ${peak} %) – ${snow ? "obleč se tepleji a počítej s náledím" : "vezmi si deštník"}.`);
    } else if (maybe.length) {
      parts.push(`Možná přeháňka ${range(maybe)} – deštník se může hodit.`);
    } else {
      parts.push("Srážky se nečekají, deštník můžeš nechat doma.");
    }
    if (today.some((h) => h.icon === "wx-storm")) parts.push("Pozor na bouřky.");
    else if (max >= 28) parts.push(`Bude horko (až ${max} °C) – pij dost vody.`);
    else if (w.current.feelsLike <= 3) parts.push(`Je chladno (pocitově ${w.current.feelsLike} °C) – obleč se teple.`);
    else parts.push(`Teploty ${min}–${max} °C.`);
    if (w.current.wind >= 40) parts.push("Fouká silný vítr.");
    return parts.join(" ");
  };

  let tipKey = "";
  const renderWeatherTip = async (w) => {
    const tip = $("#wx-tip");
    const badge = $("#wx-tip-badge");
    const text = $("#wx-tip-text");
    tip.hidden = false;
    // Nejdřív hned tip z pravidel, pak (pokud je klíč) přepsat textem od Gemini – max. jednou za hodinu.
    const key = `${w.place}-${w.hourly[0]?.time}`;
    if (tipKey === key) return;
    tipKey = key;
    badge.textContent = "Tip";
    badge.classList.remove("is-ai");
    text.textContent = ruleTip(w);
    if (!window.desktop?.weatherSummary) return;
    const brief = [
      `Místo: ${w.place}. Teď: ${w.current.temperature} °C (pocitově ${w.current.feelsLike} °C), ${w.current.text}, vítr ${w.current.wind} km/h.`,
      "Hodinová předpověď (hodina: teplota, pravděpodobnost srážek, srážky mm, stav):",
      ...w.hourly.map((h) => `${h.hour}:00: ${h.temp} °C, ${h.pop} %, ${h.precip} mm, ${h.text}`),
    ].join("\n");
    const res = await window.desktop.weatherSummary(brief);
    if (res?.ok && tipKey === key) {
      badge.textContent = "AI";
      badge.classList.add("is-ai");
      text.textContent = res.text;
    }
  };

  async function loadWeather() {
    if (!window.desktop?.fetchWeather) {
      $("#wx-cond").textContent = "Počasí se načítá jen v desktopové aplikaci.";
      return;
    }
    try {
      const w = await window.desktop.fetchWeather();
      renderWeather(w);
      if (w.hourly?.length) {
        renderWeatherChart(w.hourly);
        renderWeatherTip(w);
      }
    } catch {
      if ($("#wx-temp").textContent === "–") $("#wx-cond").textContent = "Počasí se nepodařilo načíst.";
    }
  }
  setInterval(loadWeather, 30 * 60 * 1000); // každých 30 minut

  /* ---------- AI asistenti ve webview: Gemini a ChatGPT ---------- */
  const setupWebAssistant = ({ name, host, status, reload, external, src, partition, openExternal }) => {
    const setStatus = (text, state) => {
      status.innerHTML = `<span class="status-dot${state ? ` status-dot--${state}` : ""}"></span>`;
      status.append(text);
    };

    const view = document.createElement("webview");
    view.className = "gemini__view";
    view.setAttribute("partition", partition); // trvalé úložiště → přihlášení vydrží
    view.setAttribute("src", src);
    view.setAttribute("allowpopups", "");
    host.replaceChildren(view);

    // Hláška místo prázdné (bílé) plochy, když se stránka nenačte.
    const error = document.createElement("div");
    error.className = "gemini__error";
    error.hidden = true;
    error.innerHTML = `
      <p>${name} se nepodařilo načíst. Zkontroluj připojení k internetu.</p>
      <div class="gemini__error-actions">
        <button class="btn btn--primary btn--sm" type="button" data-web="retry">Zkusit znovu</button>
        <button class="pill-btn" type="button" data-web="external">Otevřít v prohlížeči</button>
      </div>`;
    host.append(error);
    $('[data-web="retry"]', error).addEventListener("click", () => view.reload());
    $('[data-web="external"]', error).addEventListener("click", openExternal);

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

    reload.addEventListener("click", () => view.reload());
    external.addEventListener("click", openExternal);
  };

  const setupGemini = () => setupWebAssistant({
    name: "Gemini",
    host: $("#gemini"), status: $("#gemini-status"), reload: $("#gemini-reload"), external: $("#gemini-external"),
    src: "https://gemini.google.com/app", partition: "persist:gemini",
    openExternal: () => window.desktop.openGeminiExternal(),
  });

  // ChatGPT se načte až při prvním otevření záložky (šetří paměť i síť).
  const setupChatGPT = () => {
    let started = false;
    const start = () => {
      if (started || app.dataset.view !== "chatgpt") return;
      started = true;
      setupWebAssistant({
        name: "ChatGPT",
        host: $("#chatgpt"), status: $("#chatgpt-status"), reload: $("#chatgpt-reload"), external: $("#chatgpt-external"),
        src: "https://chatgpt.com/", partition: "persist:chatgpt",
        openExternal: () => window.desktop.openChatGPTExternal(),
      });
    };
    new MutationObserver(start).observe(app, { attributes: true, attributeFilter: ["data-view"] });
    start();
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

  /* ---------- Přizpůsobitelná mřížka Přehledu (GridStack) ---------- */
  const setupBoard = () => {
    const GS = window.GridStack?.GridStack || window.GridStack;
    const boardEl = $("#board");
    if (!GS || !boardEl) return;

    const ROWS = 12;
    const DEFAULT_LAYOUT = $$(".grid-stack-item", boardEl).map((el) => ({
      id: el.getAttribute("gs-id"),
      x: +el.getAttribute("gs-x"), y: +el.getAttribute("gs-y"),
      w: +el.getAttribute("gs-w"), h: +el.getAttribute("gs-h"),
    }));

    // Výška řádku tak, aby 12 řádků vyplnilo okno pod horní lištou.
    const rowHeight = () => {
      const top = $(".topbar").getBoundingClientRect().height;
      return Math.max(40, Math.floor((window.innerHeight - top - 8) / ROWS));
    };

    const grid = GS.init({
      column: 12,
      cellHeight: rowHeight(),
      margin: 4,                     // 8 px mezi bloky
      float: false,
      animate: true,
      staticGrid: true,              // mimo režim úprav je mřížka zamčená
      handle: ".card__title, .assistant__who",
      resizable: { handles: "e, se, s, sw, w" },
      draggable: { cancel: "button, input, textarea, select, a, webview" },
    }, boardEl);

    const saved = store.get("board-layout");
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
    if (Array.isArray(saved)) applyLayout(saved);

    // Pozice brát přímo z GridStacku (grid.save() vynechává hodnoty rovné minimu).
    const saveLayout = () => store.set("board-layout",
      grid.engine.nodes.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })));
    grid.on("change", saveLayout);
    $$(".nav__link").forEach((l) => { l.draggable = false; });

    window.addEventListener("resize", () => grid.cellHeight(rowHeight()));

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
      e.dataTransfer.setData("application/x-jimmy-nav", viewOf(li));
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
    setupChatGPT();
    setupClipboard();
    desktop.onShowView((view) => showView(view));
  }

  renderIcons();
})();
