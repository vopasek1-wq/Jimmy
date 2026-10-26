// Ladicí výpisy: párování Forebetu, soubory po stahování a po neúspěšném čtení Forebetu, souhrn pro vývojáře.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Pipeline, forebetCoverage } = require("../src/pipeline");
const { ForebetScraper } = require("../src/scrapers/forebet");
const { buildDiagnostics } = require("../src/diagnostics");
const { SourceError } = require("../src/http");
const { s24Row, s24Block, s24Page, forebetRow, forebetPage, sofaEvent } = require("./helpers/html");

const KO = new Date(Date.UTC(2026, 9, 18, 15, 30));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "diag-"));
const tip = (home, away, o = {}) => ({ home, away, leagueKey: "EPL", kickoff: KO, ...o });
const fb = (home, away, o = {}) => ({ home, away, kickoff: KO, leagueKey: "EPL", leagueText: "Eng1", p1: 10, px: 20, p2: 70, url: "https://x/y", ...o });

test("forebetCoverage: spárované a nespárované tipy s nejbližším zápasem, časový rozsah a značky lig", () => {
  const lines = forebetCoverage(
    [tip("Nottingham Forest", "Arsenal"), tip("Brentford", "Fulham"), tip("Everton", "Wolves", { kickoff: new Date(KO.getTime() + 10 * 3600e3) })],
    [fb("Nottingham Forest", "Arsenal"), fb("Brentford FC", "Fulham", { kickoff: new Date(KO.getTime() + 9 * 3600e3) }), fb("Everton", "Wolverhampton", { leagueKey: null, leagueText: "" })],
  );
  const text = lines.join("\n");
  assert.match(text, /zápasů ve zdroji 3, z toho se sledovanou ligou 2/);
  assert.match(text, /Časový rozsah zápasů \(UTC\): 2026-10-18 15:30 až 2026-10-19 00:30/);
  assert.match(text, /Značky lig: Eng1:2 \?:1/);
  assert.match(text, /Tipů ze Scores24: 3, spárováno s Forebetem: 1/);
  // Brentford má jiný čas (o 9 h), Everton chybí liga i čas nesedí → nespárováno, ale ukáže se nejbližší zápas a podobnost jmen
  assert.match(text, /nespárováno: Brentford – Fulham \[EPL\] 2026-10-18 15:30 → nejbližší ve Forebetu: Brentford FC – Fulham \[Eng1\] 2026-10-19 00:30, podobnost jmen 1\.00/);
  assert.match(text, /nespárováno: Everton – Wolves/);
  assert.match(text, /ukázka řádku: Nottingham Forest – Arsenal \| 2026-10-18 15:30 \| Eng1 \| 10\/20\/70/);
});

const epl = (rows) => s24Page([s24Block("England", "Premier League", "england-premier-league", rows.length, rows)]);

test("Pipeline: po stažení vznikne zdroje-diagnostika.txt se stavem zdrojů, párováním a pokrytím SofaScore", async () => {
  const dir = tmp();
  const TS = Math.floor(KO.getTime() / 1000);
  const web = {
    http: {
      async getText(url) {
        if (url.includes("scores24")) return epl([s24Row({ home: "Nottingham Forest", away: "Arsenal", pick: "Arsenal to Win", percent: "80", odds: "1.7" })]);
        return forebetPage([forebetRow({ home: "Nottingham Forest", away: "Arsenal", p: [10, 20, 70], pick: "2" })]);
      },
      async getJson() { return { events: [sofaEvent(7, "Nottingham Forest", "Arsenal", TS, "notstarted")] }; },
    },
    browser: { expandScores24: async () => { throw new Error("nemělo být potřeba"); }, loadHtml: async () => "<html></html>" },
  };
  await new Pipeline({ ...web, debugDir: dir }).run({ now: new Date(Date.UTC(2026, 9, 18, 12)) });
  const text = fs.readFileSync(path.join(dir, "zdroje-diagnostika.txt"), "utf8");
  assert.match(text, /Stav zdrojů:\n  Scores24: ok – 1 tipů\n  Forebet: ok – 1 zápasů/);
  assert.match(text, /Scores24: 1 tipů před filtry; po filtrech 1/);
  assert.match(text, /Tipů ze Scores24: 1, spárováno s Forebetem: 1/);
  assert.match(text, /Stránky Forebetu:\n.*sledované ligy: /);
  assert.match(text, /Výsledek zápasu \(1X2\): 1 \(Forebet 1\)/);
  assert.match(text, /SofaScore: zápas nalezen u 1 z 1 tipů/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Forebet: když se na stránce nenajde žádný zápas, skončí chybou a nic se neukládá; stránka kontroly robota je Cloudflare", async () => {
  const html = '<html><body><div class="novyZapas"><span class="tym">A</span> <span class="tym">B</span></div><time datetime="2026-10-18 15:30">x</time></body></html>';
  const scraper = new ForebetScraper({ getText: async () => html }, { loadHtml: async () => html });
  await assert.rejects(() => scraper.fetch(() => {}), (e) => e instanceof SourceError && /nejsou rozpoznatelné zápasy/.test(e.message));

  const cf = "<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>";
  await assert.rejects(() => new ForebetScraper({ getText: async () => cf }, { loadHtml: async () => cf }).fetch(() => {}), /Cloudflare/);
});

test("buildDiagnostics: verze, stav zdrojů, obsah ladicích souborů (zkrácený) a chybějící soubory", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "zdroje-diagnostika.txt"), "Stav zdrojů:\n  Forebet: failed\n");
  fs.writeFileSync(path.join(dir, "tikety-statistiky.txt"), `${"x".repeat(7000)}`);
  const text = buildDiagnostics({
    version: "1.0.38", electron: "44.9.0", platform: "win32 10.0.22631", dir, now: new Date("2026-10-23T08:00:00Z"),
    run: { finishedAt: new Date("2026-10-23T07:50:00Z"), statuses: { Forebet: { name: "Forebet", state: "failed", message: "Cloudflare" } }, warnings: ["Forebet: Cloudflare"] },
    tips: [{ probSource: "Scores24", probForebet: 60, sofascoreId: 5 }, { probSource: "Forebet", probForebet: null, sofascoreId: null }],
  });
  assert.match(text, /^FOTBALOVÉ TIPY – DIAGNOSTIKA \(2026-10-23T08:00:00.000Z\)\nVerze 1\.0\.38, Electron 44\.9\.0, win32 10\.0\.22631\n/);
  assert.match(text, /Forebet: failed – Cloudflare\n  upozornění: Forebet: Cloudflare/);
  assert.match(text, /tipů v posledním stažení: 2 \(zdroj pravděpodobnosti: Scores24 1, Forebet 1\), s Forebetem 1, se SofaScore 1/);
  assert.match(text, /===== zdroje-diagnostika\.txt =====\nStav zdrojů:\n  Forebet: failed/);
  assert.match(text, /===== tikety-statistiky\.txt =====\n/);
  assert.doesNotMatch(text, /forebet-diagnostika/);
  assert.match(text, /… \(zkráceno, celkem 7000 znaků\)/);                  // tikety-statistiky.txt má 7000 znaků, limit 6000
  assert.match(buildDiagnostics({ version: "1", electron: "1", platform: "x", run: null, dir }), /Zatím žádné stažení tipů\./);
  fs.rmSync(dir, { recursive: true, force: true });
});
