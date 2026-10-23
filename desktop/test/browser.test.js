// WindowBrowser: jedno sdílené skryté okno pro všechny zdroje (zkouší se s falešným BrowserWindow).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WindowBrowser } = require("../src/browser");

function fake() {
  const log = { created: 0, destroyed: 0, shown: 0, hidden: 0, urls: [], titles: [], concurrent: 0, peak: 0 };
  class FakeWindow {
    constructor(opts) {
      log.created += 1;
      this.opts = opts;
      this.url = "";
      this.dead = false;
      this.webContents = {
        setUserAgent() {}, setWindowOpenHandler() {},
        executeJavaScript: async (script) => {
          if (script === "document.readyState") return "complete";
          if (script.includes("scrollIntoView")) return { html: `<html>expanded ${this.url}</html>`, result: {} };
          return `<html>${this.url} ${"x".repeat(300)}</html>`;
        },
      };
    }
    async loadURL(url) { log.concurrent += 1; log.peak = Math.max(log.peak, log.concurrent); await new Promise((r) => setTimeout(r, 2)); log.concurrent -= 1; this.url = url; log.urls.push(url); }
    show() { log.shown += 1; }
    hide() { log.hidden += 1; }
    focus() {}
    setTitle(t) { log.titles.push(t); }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; log.destroyed += 1; }
  }
  const browser = new WindowBrowser({ BrowserWindow: FakeWindow, session: {}, app: { userAgentFallback: "Mozilla/5.0 Chrome/1 Electron/2" }, idleMs: 30 });
  return { browser, log };
}

const always = () => true;

test("WindowBrowser: Forebet i Scores24 sdílejí jedno okno, mezi použitími se skrývá a vyprazdňuje", async () => {
  const { browser, log } = fake();
  const a = await browser.loadHtml("https://www.forebet.com/a", { ready: always });
  const pages = await browser.loadPages(["https://www.forebet.com/b", "https://www.forebet.com/c"], { ready: always, waitMs: 10 });
  const s24 = await browser.expandScores24("https://scores24.live/x", ["england-premier-league"]);
  assert.equal(log.created, 1);
  assert.match(a, /forebet\.com\/a/);
  assert.equal(pages.length, 2);
  assert.match(pages[1], /forebet\.com\/c/);
  assert.match(s24, /expanded https:\/\/scores24\.live\/x/);
  assert.equal(log.hidden, 3);                                  // po každém použití
  assert.equal(log.urls.filter((u) => u === "about:blank").length, 3);
  browser.close();
  assert.equal(log.destroyed, 1);
});

test("WindowBrowser: souběžná volání se řadí za sebou a okno se po nečinnosti zavře a znovu vytvoří", async () => {
  const { browser, log } = fake();
  await Promise.all([1, 2, 3].map((i) => browser.loadHtml(`https://x/${i}`, { ready: always })));
  assert.equal(log.created, 1);
  assert.equal(log.peak, 1);                                    // nikdy dvě načítání naráz
  await new Promise((r) => setTimeout(r, 80));                  // idleMs = 30
  assert.equal(log.destroyed, 1);
  await browser.loadHtml("https://x/again", { ready: always });
  assert.equal(log.created, 2);
  browser.close();
});

test("WindowBrowser: zavřené uživatelem se vytvoří znovu; chyba jednoho volání neblokuje frontu; interaktivní okno se po použití skryje", async () => {
  const { browser, log } = fake();
  await browser.loadHtml("https://x/1", { ready: always });
  browser.win.destroy();                                        // uživatel okno zavřel
  await browser.loadHtml("https://x/2", { ready: always });
  assert.equal(log.created, 2);
  await assert.rejects(() => browser._use(async () => { throw new Error("chyba"); }), /chyba/);
  assert.match(await browser.loadHtml("https://x/3", { ready: always }), /x\/3/);
  await browser.loadHtml("https://x/cf", { ready: () => log.shown > 0, waitMs: 0, interactive: true, interactiveMs: 5000 }); // ověření „projde“ až po zobrazení okna
  assert.equal(log.shown, 1);
  assert.ok(log.hidden >= 1);
  browser.close();
});
