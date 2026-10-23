// Záložní režim: skutečné okno prohlížeče (vestavěné Chromium z Electronu) místo Selenia.
//
// Používá se tam, kde samotné HTTP nestačí:
//   * Forebet je za kontrolou Cloudflare – okno ji obvykle projde a cookie „cf_clearance“ se uloží
//     do trvalého úložiště, takže další načtení už procházejí. Když ne, jde okno na požádání zobrazit
//     a kontrolu dokončí uživatel,
//   * Scores24 načítá zápasy sbalených lig až po kliknutí na hlavičku ligy.
"use strict";

const { SourceError } = require("./http");

class BrowserUnavailable extends SourceError {
  constructor(message) { super(message); this.name = "BrowserUnavailable"; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PARTITION = "persist:tipsweb";

/** Google/Cloudflare nemají rády klienty, kteří se hlásí jako Electron → běžný Chrome UA. */
const chromeUserAgent = (fallback) => fallback.replace(/\s(?!(?:AppleWebKit|Chrome|Safari)\/)[\w.-]+\/\S+/g, "");

// Skript běžící ve stránce Scores24: klikne na hlavičky sbalených lig a počká, až se pod nimi objeví zápasy.
// Element se hledá při každém pokusu znovu – React ho po načtení může nahradit.
const EXPAND_SCRIPT = (slugs) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ancestorDivs = (el) => { const out = []; while ((el = el.parentElement)) if (el.tagName === "DIV") out.push(el); return out; };
  const result = {};
  for (const slug of ${JSON.stringify(slugs)}) {
    result[slug] = false;
    for (let attempt = 0; attempt < 3 && !result[slug]; attempt++) {
      const link = document.querySelector('a[href*="/soccer/l-' + slug + '"]');
      const divs = link ? ancestorDivs(link) : [];
      if (divs.length < 3) { await sleep(800); continue; }
      const header = divs[1], block = divs[2];
      header.scrollIntoView({ block: "center" });
      header.click();
      for (let i = 0; i < 10; i++) {
        if (block.querySelector('a[href*="-prediction"]')) { result[slug] = true; break; }
        await sleep(500);
      }
    }
  }
  return { html: document.documentElement.outerHTML, result };
})()`;

// Skript běžící ve stránce Forebetu: opakovaně klikne na „Show more“ (a podobná tlačítka) a čeká, až přibývají řádky
// zápasů. Bez toho Forebet vrátí jen první část seznamu (podle zemí od „A“) a sledované ligy v něm nejsou.
// Odkazy vedoucí na jinou stránku se nekliknou, hlavička/menu se přeskakuje.
const EXPAND_MORE_SCRIPT = (rowSelector, maxMs) => String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MORE = /^(show|load|view|see|display)\s+(more|all)\b|^more\s+(matches|games|predictions|results|events)\b|^(zobrazit|načíst|ukázat)\s+(více|další|vše)/i;
  const rows = () => document.querySelectorAll(${JSON.stringify(rowSelector)}).length;
  const label = (el) => ((el.tagName === "INPUT" ? el.value : (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const navigates = (el) => { const a = el.closest("a[href]"); const h = a ? (a.getAttribute("href") || "") : ""; return !!h && !h.startsWith("#") && !/^javascript:/i.test(h); };
  const find = () => {
    const hits = [...document.querySelectorAll("a, button, div, span, p, li, td, input")]
      .filter((el) => !el.closest("nav, header, footer") && label(el).length <= 40 && MORE.test(label(el)) && shown(el) && !navigates(el));
    return hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
  };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : "") + " «" + label(el) + "»";
  const start = Date.now(), before = rows(), log = [];
  let last = before, idle = 0;
  while (Date.now() - start < ${Number(maxMs)} && idle < 3) {
    window.scrollTo(0, document.body.scrollHeight);
    const hits = find();
    if (hits.length) {
      const el = hits[hits.length - 1];
      el.scrollIntoView({ block: "center" });
      el.click();
      if (log.length < 6) log.push(name(el));
    }
    await sleep(1500);
    const n = rows();
    if (n > last) { last = n; idle = 0; } else idle += 1;
  }
  return { html: document.documentElement.outerHTML, before, after: rows(), clickLog: log, ms: Date.now() - start };
})()`;

class WindowBrowser {
  /**
   * @param {object} electron  { BrowserWindow, session, app } – předává se zvenku kvůli testům
   */
  constructor({ BrowserWindow, session, app }) {
    this.BrowserWindow = BrowserWindow;
    this.session = session;
    this.userAgent = chromeUserAgent(app.userAgentFallback);
    this.partition = PARTITION;
  }

  _createWindow(show, title) {
    const win = new this.BrowserWindow({
      show, width: 1180, height: 860, title: title || "Fotbalové tipy – ověření", autoHideMenuBar: true,
      backgroundColor: "#080f17",
      webPreferences: {
        partition: this.partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false, spellcheck: false,
      },
    });
    win.webContents.setUserAgent(this.userAgent);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    return win;
  }

  async _load(win, url) {
    try {
      await Promise.race([win.loadURL(url), sleep(45000).then(() => { throw new Error("timeout"); })]);
    } catch (err) {
      // Kontrola Cloudflare často přesměruje a první načtení skončí jako ERR_ABORTED – obsah ale už je.
      const html = await this._html(win);
      if (!html || html.length < 200) {
        throw new BrowserUnavailable(`Prohlížeč nedokázal načíst ${new URL(url).host}: ${String(err.message).split("\n")[0]}`);
      }
    }
  }

  async _html(win) {
    try {
      return await win.webContents.executeJavaScript("document.documentElement.outerHTML");
    } catch {
      return "";
    }
  }

  /**
   * Otevře URL a čeká, až `ready(html)` vrátí true (např. zmizí „Just a moment…“).
   * Pokud podmínka do limitu nenastala, vrací i tak poslední HTML a volající rozhodne.
   * S `interactive` se po `waitMs` okno zobrazí a dává se uživateli až `interactiveMs` na ruční ověření.
   */
  async loadHtml(url, { ready, waitMs = 15000, interactive = false, interactiveMs = 90000, title, expand = null, onExpand = null } = {}) {
    const win = this._createWindow(false, title);
    try {
      await this._load(win, url);
      let html = await this._html(win);
      let deadline = Date.now() + waitMs;
      while (!ready(html) && Date.now() < deadline) {
        await sleep(1000);
        html = await this._html(win);
      }
      if (!ready(html) && interactive) {
        win.show();
        win.focus();
        deadline = Date.now() + interactiveMs;
        while (!ready(html) && Date.now() < deadline && !win.isDestroyed()) {
          await sleep(1000);
          html = await this._html(win);
        }
      }
      if (expand && ready(html) && !win.isDestroyed()) html = await this._expand(win, expand, html, onExpand);
      return html;
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  /** Spustí na hotové stránce skript `{ html, ... }` (např. „Show more“); při chybě zůstane původní HTML. */
  async _expand(win, script, html, onExpand) {
    try {
      const info = await Promise.race([
        win.webContents.executeJavaScript(script, true),
        sleep(60000).then(() => { throw new Error("rozbalení trvalo příliš dlouho"); }),
      ]);
      if (onExpand) onExpand({ ...info, html: undefined });
      return info && info.html ? info.html : html;
    } catch (err) {
      if (onExpand) onExpand({ error: String(err.message || err).split("\n")[0] });
      return html;
    }
  }

  /** Rozbalí sbalené ligy na Scores24 a vrátí výsledné HTML. */
  async expandScores24(url, slugs) {
    const win = this._createWindow(false);
    try {
      await this._load(win, url);
      for (let i = 0; i < 15; i++) {            // stránka se musí „oživit“, jinak se klik ztratí
        if (await win.webContents.executeJavaScript("document.readyState") === "complete") break;
        await sleep(400);
      }
      await sleep(1500);
      const { html } = await win.webContents.executeJavaScript(EXPAND_SCRIPT(slugs), true);
      return html;
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  /** Předvyplní preferenční cookie Scores24 (desetinné kurzy a pražské časové pásmo). */
  async setScores24Cookies(base, cookies) {
    const ses = this.session.fromPartition(this.partition);
    for (const [name, value] of Object.entries(cookies)) {
      await ses.cookies.set({ url: base, name, value, expirationDate: Math.floor(Date.now() / 1000) + 86400 * 365 });
    }
  }
}

module.exports = { WindowBrowser, BrowserUnavailable, chromeUserAgent, EXPAND_SCRIPT, EXPAND_MORE_SCRIPT };
