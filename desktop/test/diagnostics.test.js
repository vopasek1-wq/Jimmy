// Ladicí výpisy: párování Forebetu, soubory po stahování a po neúspěšném čtení Forebetu, souhrn pro vývojáře.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Pipeline, forebetCoverage, droppedReport } = require("../src/pipeline");
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

test("Pipeline: handicap 0 bez procent ze Scores24 dostane pravděpodobnost z Forebetu (sázka bez remízy)", async () => {
  const web = {
    http: {
      async getText(url) {
        if (url.includes("scores24")) return epl([s24Row({ home: "Nottingham Forest", away: "Arsenal", pick: "Arsenal Handicap (0)", percent: null, odds: "1.72", status: "tomorrow" })]);
        return forebetPage([forebetRow({ home: "Nottingham Forest", away: "Arsenal", when: "2026-10-19 15:30:00", p: [10, 20, 70], pick: "2" })]);
      },
      async getJson() { return { events: [] }; },
    },
    browser: { expandScores24: async () => { throw new Error("nemělo být potřeba"); }, loadHtml: async () => "<html></html>" },
  };
  const result = await new Pipeline(web).run({ now: new Date(Date.UTC(2026, 9, 18, 12)) });
  const t = result.tips.find((x) => x.tipCode === "AH2:0");
  assert.ok(t, "tip s handicapem 0 prošel filtry");
  assert.equal(t.probability, 87.5); // 70 / (10 + 70)
  assert.equal(t.probSource, "Forebet");
  assert.equal(t.probForebet, 87.5);
});

test("Pipeline: zdroje-diagnostika.txt vypíše zahozené tipy s důvodem a souhrnem", async () => {
  const dir = tmp();
  const page = epl([
    s24Row({ home: "Nottingham Forest", away: "Arsenal", pick: "Arsenal to Win", percent: "80", odds: "1.7" }), // projde
    s24Row({ home: "Chelsea", away: "Everton", slug: "c-e", pick: "Chelsea to Win", percent: "45", odds: "1.8" }), // pravděpodobnost
    s24Row({ home: "Brentford", away: "Fulham", slug: "b-f", pick: "Brentford to Win", percent: null, odds: "1.8", status: "tomorrow" }), // Forebet zápas nezná
    s24Row({ home: "Wolves", away: "Leeds", slug: "w-l", pick: "Wolves to Win", percent: "70", odds: "1.3" }), // kurz
  ]);
  const web = {
    http: {
      async getText(url) { return url.includes("scores24") ? page : forebetPage([forebetRow({ home: "Nottingham Forest", away: "Arsenal", p: [10, 20, 70], pick: "2" })]); },
      async getJson() { return { events: [] }; },
    },
    browser: { expandScores24: async () => { throw new Error("nemělo být potřeba"); }, loadHtml: async () => "<html></html>" },
  };
  await new Pipeline({ ...web, debugDir: dir }).run({ now: new Date(Date.UTC(2026, 9, 18, 12)) });
  const text = fs.readFileSync(path.join(dir, "zdroje-diagnostika.txt"), "utf8");
  assert.match(text, /Scores24: 4 tipů před filtry; po filtrech 1\nZahozené tipy podle filtrů: celkem 3 \(pravděpodobnost do 60 % 1, bez pravděpodobnosti 1, kurz pod 1,50 1\)/);
  assert.match(text, /Chelsea – Everton \[EPL\] .* \| 1 – výhra Chelsea \| kurz 1,8 \| pravděpodobnost 45 % \(Scores24\) není nad 60 %/);
  assert.match(text, /Brentford – Fulham \[EPL\] .* \| bez pravděpodobnosti \(Forebet: zápas nenalezen\)/);
  assert.match(text, /Wolves – Leeds \[EPL\] .* \| kurz 1,3 je pod 1,50/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("droppedReport: skončené zápasy jen v souhrnu, výpis se omezí na limit a seřadí podle začátku", () => {
  const r = (tip, reason) => ({ tip: { tipLabel: "x", odds: 1.8, oddsEstimated: false, status: "upcoming", ...tip }, reason });
  const rejected = [
    r({ home: "B", away: "b", leagueKey: "EPL", kickoff: new Date(KO.getTime() + 3600e3) }, { code: "lowprob", text: "nízká" }),
    r({ home: "A", away: "a", leagueKey: "EPL", kickoff: KO }, { code: "lowprob", text: "nízká" }),
    r({ home: "C", away: "c", leagueKey: "EPL", kickoff: KO, status: "finished" }, { code: "lowodds", text: "nízký" }),
    r({ home: "D", away: "d", leagueKey: "EPL", kickoff: new Date(KO.getTime() + 7200e3) }, { code: "lowprob", text: "nízká" }),
  ];
  const lines = droppedReport(rejected, [], { limit: 2 });
  assert.equal(lines[0], "Zahozené tipy podle filtrů: celkem 4 (pravděpodobnost do 60 % 3, kurz pod 1,50 1)");
  assert.match(lines[1], /^ {2}A – a /); // nejbližší první
  assert.match(lines[2], /^ {2}B – b /);
  assert.equal(lines[3], "  … a dalších 1 (nezobrazeno)");
  assert.equal(lines.some((l) => /C – c/.test(l)), false);
  assert.deepEqual(droppedReport([], []), []);
});

test("Pipeline: kvůli ženské Lize mistrů se stránka ligy na Forebetu nestahuje", async () => {
  const dir = tmp();
  const asked = [];
  const page = s24Page([
    s24Block("England", "Premier League", "england-premier-league", 1, [s24Row({ home: "Nottingham Forest", away: "Arsenal", pick: "Arsenal to Win", percent: "80", odds: "1.7" })]),
    s24Block("Europe", "UEFA Champions League", "uefa-champions-league", 1, [s24Row({ home: "Chelsea (W)", away: "Roma (W)", pick: "Chelsea (W) to Win", percent: "80", odds: "1.7" })]),
  ]);
  const web = {
    http: {
      async getText(url) { asked.push(url); return url.includes("scores24") ? page : forebetPage([forebetRow({ home: "Nottingham Forest", away: "Arsenal", p: [10, 20, 70], pick: "2" })]); },
      async getJson() { return { events: [] }; },
    },
    browser: { expandScores24: async () => { throw new Error("nemělo být potřeba"); }, loadHtml: async () => "<html></html>" },
  };
  await new Pipeline({ ...web, debugDir: dir }).run({ now: new Date(Date.UTC(2026, 9, 18, 12)) });
  assert.ok(asked.some((u) => u.includes("forebet")));
  assert.equal(asked.some((u) => /champions-league/.test(u) && u.includes("forebet")), false);
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
