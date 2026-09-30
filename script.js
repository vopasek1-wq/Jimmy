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

  /* ---------- Novinky: filtr ČR / Svět ---------- */
  $("#news-region").addEventListener("change", (e) => {
    const region = e.target.value;
    $$(".news__item").forEach((item) => {
      item.parentElement.hidden = region !== "all" && item.dataset.region !== region;
    });
  });

  /* ---------- Záložky úkolů ---------- */
  $$(".tabs__tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tabs__tab").forEach((t) => {
        t.classList.toggle("is-active", t === tab);
        t.setAttribute("aria-pressed", String(t === tab));
      });
    });
  });

  /* ---------- Přidání úkolu ---------- */
  const taskForm = $("#task-add");
  const taskField = $(".task-add__field", taskForm);
  const taskInput = $("#task-input");
  const taskList = $("#task-list");

  const openTaskField = () => {
    taskField.hidden = false;
    taskInput.focus();
  };
  $("#task-add-toggle").addEventListener("click", openTaskField);
  $("[data-add-task]").addEventListener("click", openTaskField);

  taskInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      taskInput.value = "";
      taskField.hidden = true;
    }
  });

  const createTask = ({ title, due = "Dnes", done = false }) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <label class="task">
        <input class="checkbox" type="checkbox">
        <span class="task__text">
          <span class="task__title"></span>
          <span class="task__due"></span>
        </span>
      </label>`;
    $(".task__title", li).textContent = title;
    $(".task__due", li).textContent = due;
    $(".checkbox", li).checked = done;
    taskList.append(li);
    return li;
  };

  const saveTasks = () => store.set("tasks", $$("li", taskList).map((li) => ({
    title: $(".task__title", li).textContent,
    due: $(".task__due", li).textContent,
    done: $(".checkbox", li).checked,
  })));

  const savedTasks = store.get("tasks");
  if (Array.isArray(savedTasks)) {
    taskList.replaceChildren();
    savedTasks.forEach(createTask);
  }
  taskList.addEventListener("change", saveTasks);

  taskForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = taskInput.value.trim();
    if (!title) return;

    createTask({ title }).scrollIntoView({ block: "nearest" });
    saveTasks();
    taskInput.value = "";
    taskField.hidden = true;
  });

  /* ---------- Rychlé poznámky (editace přímo v seznamu) ---------- */
  const notesList = $("#notes-list");
  const notesEdit = $("#notes-edit");
  const savedNotes = store.get("notes");
  if (Array.isArray(savedNotes)) {
    notesList.replaceChildren(...savedNotes.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }));
  }
  const saveNotes = () => store.set("notes", $$("li", notesList).map((li) => li.textContent.trim()).filter(Boolean));

  const setNotesEditing = (editing) => {
    notesList.contentEditable = String(editing);
    notesEdit.setAttribute("aria-pressed", String(editing));
    if (editing) {
      notesList.focus();
    } else {
      saveNotes();
    }
  };
  notesEdit.addEventListener("click", () => setNotesEditing(!notesList.isContentEditable));
  notesList.addEventListener("focusout", () => { if (notesList.isContentEditable) saveNotes(); });

  /* ---------- AI automatizace: stav přepínačů ---------- */
  const switches = $$(".automations .switch input");
  const savedSwitches = store.get("automations");
  if (Array.isArray(savedSwitches)) switches.forEach((input, i) => { input.checked = Boolean(savedSwitches[i]); });
  switches.forEach((input) => input.addEventListener("change", () => store.set("automations", switches.map((s) => s.checked))));

  /* ---------- AI chat (simulované odpovědi) ---------- */
  const chat = $("#chat");
  const composer = $("#composer");
  const composerInput = $("#composer-input");

  const replies = {
    "novinky": "Dnes nejvíc rezonuje obrana (nákup techniky), přechod EU na čistou energii a nový update pro Diablo IV. Chceš k některé zprávě delší shrnutí?",
    "počasí": "Zítra v Praze polojasno, přes den kolem 16 °C, v noci 8 °C. Deštník zatím není potřeba – déšť přijde až v pátek.",
    "hry": "Ve 20:00 máš v kalendáři Diablo IV – Season push. League of Legends naposledy před 2 dny (Gold II, 45 LP).",
    "úkol": "Dnes máš 4 nesplněné úkoly. Nejdřív tě čeká kontrola cen na Alza.cz (16:00), pak video pro YouTube (19:00).",
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
      addBubble(key ? replies[key] : fallback, "bot");
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

  /* ---------- Desktop (Electron): okno, systém, rychlé akce ---------- */
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

  const actions = {
    "open-web": () => (desktop ? desktop.openWeb() : window.open("https://www.google.com/", "_blank", "noopener")),
    "open-folder": () => desktop?.openFolder(),
    "launch-app": () => desktop?.launchApp(),
    "save-note": () => setNotesEditing(true),
  };
  $$("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => actions[btn.dataset.action]?.());
  });

  renderIcons();
})();
