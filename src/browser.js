// Záložní režim: skutečné okno prohlížeče (vestavěné Chromium z Electronu). Všechny zdroje sdílejí jedno skryté
// okno (`_use`), které se po nečinnosti zavře.
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
const DEFAULT_TITLE = "Fotbalové tipy – ověření";
const IDLE_MS = 45000; // sdílené okno se po této době bez použití zavře (paměť se uvolní)

/** Google/Cloudflare nemají rády klienty, kteří se hlásí jako Electron → běžný Chrome UA. */
const chromeUserAgent = (fallback) => fallback.replace(/\s(?!(?:AppleWebKit|Chrome|Safari)\/)[\w.-]+\/\S+/g, "");

// Skript běžící ve stránce Scores24: klikne na hlavičky sbalených lig a počká, až se pod nimi objeví zápasy.
// Element se hledá při každém pokusu znovu – React ho po načtení může nahradit.
const EXPAND_SCRIPT = (slugs) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ancestorDivs = (el) => { const out = []; while ((el = el.parentElement)) if (el.tagName === "DIV") out.push(el); return out; };
  const hasTips = (block) => Boolean(block.querySelector('a[href*="-prediction"]'));
  const hasMatches = (block) => Boolean(block.querySelector('a[href*="/soccer/m-"]'));
  const result = {};
  for (const slug of ${JSON.stringify(slugs)}) {
    let ok = false;
    let reason = "odkaz na ligu nenalezen";
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const link = document.querySelector('a[href*="/soccer/l-' + slug + '"]');
      const divs = link ? ancestorDivs(link) : [];
      if (divs.length < 3) { await sleep(800); continue; }
      const header = divs[1], block = divs[2];
      if (hasTips(block)) { ok = true; break; }       // už rozbaleno: další klik by blok zase sbalil
      reason = "po kliknutí se zápasy neukázaly";
      const before = hasMatches(block);
      header.scrollIntoView({ block: "center" });
      header.click();
      for (let i = 0; i < 12; i++) {
        // Liga se otevřela i tehdy, když její zápasy nemají tip (odkaz bez „-prediction“); to není chyba.
        if (hasTips(block) || (!before && hasMatches(block))) { ok = true; break; }
        await sleep(500);
      }
    }
    result[slug] = ok ? true : reason;
  }
  return { html: document.documentElement.outerHTML, result };
})()`;

class WindowBrowser {
  /**
   * @param {object} electron  { BrowserWindow, session, app } – předává se zvenku kvůli testům
   */
  constructor({ BrowserWindow, session, app, idleMs = IDLE_MS }) {
    this.BrowserWindow = BrowserWindow;
    this.session = session;
    this.userAgent = chromeUserAgent(app.userAgentFallback);
    this.partition = PARTITION;
    this.idleMs = idleMs;
    this.win = null;                  // jediné skryté okno, které sdílí Forebet i Scores24
    this.queue = Promise.resolve();   // použití okna se řadí za sebou
    this.idleTimer = null;
  }

  /**
   * Spustí `fn(win)` na sdíleném skrytém okně. Okno se vytvoří při prvním použití a znovu používá, dokud se nepoužívá
   * (po `idleMs` nebo `close()` se zavře); souběžná volání čekají ve frontě. Po každém použití se okno skryje a stránka
   * vyprázdní, aby nezabírala paměť.
   */
  _use(fn, { title } = {}) {
    const run = this.queue.then(async () => {
      clearTimeout(this.idleTimer);
      if (!this.win || this.win.isDestroyed()) this.win = this._createWindow(false, title);
      else this.win.setTitle(title || DEFAULT_TITLE);
      const win = this.win;
      try {
        return await fn(win);
      } finally {
        await this._rest(win);
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async _rest(win) {
    if (win.isDestroyed()) { if (this.win === win) this.win = null; return; }
    try { win.hide(); } catch { /* okno už není */ }
    try { await win.loadURL("about:blank"); } catch { /* vyprázdnění stránky je jen úklid */ }
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  /** Zavře sdílené okno (volá se po nečinnosti; další použití ho vytvoří znovu). */
  close() {
    clearTimeout(this.idleTimer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  _createWindow(show, title) {
    const win = new this.BrowserWindow({
      show, width: 1180, height: 860, title: title || DEFAULT_TITLE, autoHideMenuBar: true,
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
    let timer;
    try {
      await Promise.race([win.loadURL(url), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 45000); })]);
    } catch (err) {
      // Kontrola Cloudflare často přesměruje a první načtení skončí jako ERR_ABORTED – obsah ale už je.
      const html = await this._html(win);
      if (!html || html.length < 200) {
        throw new BrowserUnavailable(`Prohlížeč nedokázal načíst ${new URL(url).host}: ${String(err.message).split("\n")[0]}`);
      }
    } finally {
      clearTimeout(timer);
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
  async loadHtml(url, { ready, waitMs = 15000, interactive = false, interactiveMs = 90000, title } = {}) {
    return this._use(async (win) => {
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
      return html;
    }, { title });
  }

  /**
   * Načte víc stránek jednu po druhé v jednom skrytém okně (ověření Cloudflare stačí projít jednou, okno se neotevírá znovu).
   * Vrací pole HTML ve stejném pořadí; stránka, která se nenačetla, je prázdný řetězec. Mezi stránkami je krátká pauza.
   */
  async loadPages(urls, { ready, waitMs = 10000 } = {}) {
    return this._use(async (win) => {
      const out = [];
      for (const [i, url] of urls.entries()) {
        let html = "";
        try {
          await this._load(win, url);
          html = await this._html(win);
          const deadline = Date.now() + waitMs;
          while (!ready(html) && Date.now() < deadline && !win.isDestroyed()) {
            await sleep(700);
            html = await this._html(win);
          }
        } catch {
          html = "";
        }
        out.push(html);
        if (i < urls.length - 1) await sleep(350 + Math.random() * 450);
      }
      return out;
    });
  }

  /** Rozbalí sbalené ligy na Scores24 a vrátí výsledné HTML. */
  async expandScores24(url, slugs) {
    return this._use(async (win) => {
      await this._load(win, url);
      for (let i = 0; i < 15; i++) {            // stránka se musí „oživit“, jinak se klik ztratí
        if (await win.webContents.executeJavaScript("document.readyState") === "complete") break;
        await sleep(400);
      }
      await sleep(1500);
      const { html, result } = await win.webContents.executeJavaScript(EXPAND_SCRIPT(slugs), true);
      this.lastExpand = result || {};          // slug → true, nebo důvod, proč se liga nerozbalila (pro varování ve Scores24)
      return html;
    });
  }

  /** Předvyplní preferenční cookie Scores24 (desetinné kurzy a pražské časové pásmo). */
  async setScores24Cookies(base, cookies) {
    const ses = this.session.fromPartition(this.partition);
    for (const [name, value] of Object.entries(cookies)) {
      await ses.cookies.set({ url: base, name, value, expirationDate: Math.floor(Date.now() / 1000) + 86400 * 365 });
    }
  }
}

module.exports = { WindowBrowser, BrowserUnavailable, chromeUserAgent };
