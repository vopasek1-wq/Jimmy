/* AI Dashboard – lehká interaktivita (UI je plně funkční i bez dat z backendu). */
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

  $$(".nav__link").forEach((link) => {
    link.title = link.textContent.trim();
    link.addEventListener("click", (e) => {
      e.preventDefault();
      $$(".nav__link").forEach((l) => {
        l.classList.remove("is-active");
        l.removeAttribute("aria-current");
      });
      link.classList.add("is-active");
      link.setAttribute("aria-current", "page");
      setNav(false);
    });
  });

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

  /* ---------- Novinky: Seznam Zprávy, Novinky.cz, iDNES.cz (živě z RSS) ---------- */
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
  const tasksFor = (key) => tasks.filter((t) => t.date === key).sort(byTime);

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
      $(".task__due", li).textContent = task.time || "Kdykoliv";
      const box = $(".checkbox", li);
      box.checked = task.done;
      box.addEventListener("change", () => { task.done = box.checked; saveTasks(); renderWeek(); });
      $(".task__delete", li).addEventListener("click", () => {
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
      const open = list.filter((t) => !t.done);
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
    tasks.push({ id: `${Date.now()}`, title, date: selectedDay, time: time.value, done: false });
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

  /* ---------- AI chat (simulované odpovědi) ---------- */
  const chat = $("#chat");
  const composer = $("#composer");
  const composerInput = $("#composer-input");

  const replies = {
    "novinky": () => (articles.length
      ? `Nejnovější zprávy: ${articles.slice(0, 3).map((a) => `„${a.title}“ (${a.sourceName})`).join(", ")}.`
      : "Zprávy se zatím nenačetly – zkus to za chvilku."),
    "počasí": "Zítra v Praze polojasno, přes den kolem 16 °C, v noci 8 °C. Deštník zatím není potřeba – déšť přijde až v pátek.",
    "hry": "Ve 20:00 máš v kalendáři Diablo IV – Season push. League of Legends naposledy před 2 dny (Gold II, 45 LP).",
    "úkol": () => {
      const open = tasksFor(todayKey()).filter((t) => !t.done);
      if (!open.length) return "Na dnes nemáš žádné nesplněné úkoly. 🎉";
      return `Dnes máš ${open.length} nesplněné úkoly: ${open.map((t) => (t.time ? `${t.title} (${t.time})` : t.title)).join(", ")}.`;
    },
    "připomín": "Jasně! Napiš, co ti mám připomenout a kdy – třeba „Zavolat do banky zítra v 10:00“.",
  };
  const fallback = "Rozumím. Tohle je ukázkové UI – po napojení na AI backend tu uvidíš skutečnou odpověď.";

  const addBubble = (text, who) => {
    const div = document.createElement("div");
    div.className = who === "user" ? "bubble bubble--user" : "bubble bubble--bot bubble--reply";
    div.textContent = text;
    chat.append(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  };

  const send = (text) => {
    const message = text.trim();
    if (!message) return;
    addBubble(message, "user");
    composerInput.value = "";

    const typing = document.createElement("div");
    typing.className = "bubble bubble--bot bubble--typing";
    typing.setAttribute("aria-label", "Asistent píše…");
    typing.innerHTML = "<span></span><span></span><span></span>";
    chat.append(typing);
    chat.scrollTop = chat.scrollHeight;

    const lower = message.toLowerCase();
    const key = Object.keys(replies).find((k) => lower.includes(k));
    setTimeout(() => {
      typing.remove();
      const reply = typeof replies[key] === "function" ? replies[key]() : replies[key];
      addBubble(reply || fallback, "bot");
    }, 700);
  };

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    send(composerInput.value);
  });
  // Ctrl + Enter (dle nápovědy pod polem) – Enter funguje také
  composerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send(composerInput.value);
    }
  });

  $$("#suggestions .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const text = chip.textContent.trim();
      if (text.endsWith("...")) {
        composerInput.value = text.replace(/\.\.\.$/, " ");
        composerInput.focus();
      } else {
        send(text);
      }
    });
  });

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

  renderIcons();
})();
