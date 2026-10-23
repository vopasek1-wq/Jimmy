// Řízení celého stahování: zdroje → sloučení → povinné filtry → obohacení → výsledek.
//
//   Scores24  (tipy + procenta + kurzy)  ┐
//   Forebet   (pravděpodobnosti 1/X/2)   ├→ combine() → applyFilters() → SofaScore (čas, stav, skóre)
//   SofaScore (detaily zápasů)           ┘
//
// Každý zdroj může selhat samostatně – chyba se zapíše do stavu zdroje a ostatní pokračují. Běh se
// považuje za úspěšný, jen když prošel Scores24 (hlavní zdroj tipů).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("./config");
const { applyFilters, mayPass } = require("./filters");
const { NetworkError, SourceError } = require("./http");
const { BrowserUnavailable } = require("./browser");
const { evaluate, forebetProbability, goalsProbability, resultMarket } = require("./markets");
const {
  UPCOMING, FINISHED, SOURCE_SCORES24, SOURCE_FOREBET, SOURCE_SOFASCORE, newResult, resultOk,
} = require("./models");
const { marketGroup } = require("./analysis");
const { sameMatch, teamSimilarity } = require("./names");
const { Scores24Scraper, classifyStatus, kickoffOf } = require("./scrapers/scores24");
const { ForebetScraper } = require("./scrapers/forebet");
const { SofaScoreClient } = require("./scrapers/sofascore");
const { localDate, todayLocal, addDays } = require("./timeutil");

const FOREBET_TOLERANCE_MS = 3 * 3600 * 1000; // Forebet může mít jiné pásmo/zaokrouhlení času

// --- sloučení zdrojů -------------------------------------------------------------------------------

function findForebet(home, away, leagueKey, kickoff, matches) {
  let best = null;
  let bestScore = 0;
  for (const m of matches) {
    if (m.kickoff && Math.abs(m.kickoff - kickoff) > FOREBET_TOLERANCE_MS) continue;
    if (leagueKey && m.leagueKey && m.leagueKey !== leagueKey) continue;
    const score = sameMatch(home, away, m.home, m.away);
    if (score > bestScore) { best = m; bestScore = score; }
  }
  return best;
}

/** Zápas z Forebetu → řádek Scores24 (z něj víme ligu, přesné názvy a čas). */
function findRow(m, rows, now) {
  let best = null;
  let bestScore = 0;
  for (const r of rows) {
    const ko = kickoffOf(r, now);
    if (ko === null || (m.kickoff && Math.abs(m.kickoff - ko) > FOREBET_TOLERANCE_MS)) continue;
    const score = sameMatch(r.home, r.away, m.home, m.away);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

const iso = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 16).replace("T", " ") : "?");

/**
 * Jak dobře se tipy ze Scores24 párují se zápasy z Forebetu (pro ladění: názvy týmů, čas, liga).
 * U nespárovaných tipů uvede nejpodobnější zápas z Forebetu, aby bylo vidět, jestli chybí zápas, nebo nesedí jméno či čas.
 */
function forebetCoverage(tips, forebet, { sample = 12 } = {}) {
  const lines = [`Forebet: zápasů ve zdroji ${forebet.length}, z toho se sledovanou ligou ${forebet.filter((m) => m.leagueKey).length}`];
  const times = forebet.map((m) => m.kickoff).filter(Boolean).sort((a, b) => a - b);
  if (times.length) lines.push(`Časový rozsah zápasů (UTC): ${iso(times[0])} až ${iso(times[times.length - 1])}`);
  const tags = new Map();
  for (const m of forebet) tags.set(m.leagueText || "?", (tags.get(m.leagueText || "?") || 0) + 1);
  lines.push(`Značky lig: ${[...tags].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t, n]) => `${t}:${n}`).join(" ")}`);
  const miss = [];
  let matched = 0;
  const offsets = [];
  for (const t of tips) {
    const m = findForebet(t.home, t.away, t.leagueKey, t.kickoff, forebet);
    if (m) { matched += 1; if (m.kickoff) offsets.push(Math.round((m.kickoff - t.kickoff) / 60000)); } else miss.push(t);
  }
  lines.push(`Tipů ze Scores24: ${tips.length}, spárováno s Forebetem: ${matched}`);
  if (offsets.length) lines.push(`Rozdíl času Forebet − Scores24 u spárovaných (minuty): ${offsets.slice(0, 12).join(" ")}`);
  for (const t of miss.slice(0, sample)) {
    let best = null;
    let bestScore = 0;
    for (const m of forebet) {
      const score = (teamSimilarity(t.home, m.home) + teamSimilarity(t.away, m.away)) / 2;
      if (score > bestScore) { best = m; bestScore = score; }
    }
    lines.push(`  nespárováno: ${t.home} – ${t.away} [${t.leagueKey}] ${iso(t.kickoff)} → nejbližší ve Forebetu: ${best ? `${best.home} – ${best.away} [${best.leagueText || "?"}] ${iso(best.kickoff)}, podobnost jmen ${bestScore.toFixed(2)}` : "nic"}`);
  }
  for (const m of forebet.slice(0, 3)) lines.push(`  ukázka řádku: ${m.home} – ${m.away} | ${iso(m.kickoff)} | ${m.leagueText || "?"} | ${m.p1}/${m.px}/${m.p2} | ${m.url || "bez odkazu"}`);
  return lines;
}

/** Spojí tipy ze Scores24 s pravděpodobnostmi z Forebetu a přidá vlastní tipy Forebetu. */
function combine(s24, forebet, now) {
  const tips = s24 ? [...s24.tips] : [];
  const rows = s24 ? s24.rows : [];
  if (!forebet || !forebet.length) return tips;

  const used = new Set(); // zápasy Forebetu, které už některý tip vyřešil
  for (const t of tips) {
    const m = findForebet(t.home, t.away, t.leagueKey, t.kickoff, forebet);
    if (!m) continue;
    t.forebetUrl = m.url || "";
    t.probForebet = forebetProbability(t.tipCode, m.p1, m.px, m.p2) ?? goalsProbability(t.tipCode, m.goals);
    if (t.probability === null && t.probForebet !== null) { // Scores24 procento neuvedl → bere se z Forebetu
      t.probability = t.probForebet;
      t.probSource = SOURCE_FOREBET;
      t.sources = [SOURCE_SCORES24, SOURCE_FOREBET];
    }
    if (m.pick === t.tipCode) { // oba zdroje doporučují totéž
      t.sources = [SOURCE_SCORES24, SOURCE_FOREBET];
      used.add(m);
    }
  }

  // Vlastní tipy Forebetu: nejpravděpodobnější výsledek, který překročí práh.
  const have = new Set(tips.map((t) => `${t.home}|${t.away}|${t.tipCode}`));
  for (const m of forebet) {
    if (used.has(m) || m.pickProbability <= config.MIN_PROBABILITY) continue;
    const row = findRow(m, rows, now);
    const leagueKey = row ? row.leagueKey : m.leagueKey;
    const league = leagueKey ? config.leagueByKey(leagueKey) : null;
    const kickoff = (row ? kickoffOf(row, now) : null) || m.kickoff;
    if (!league || !kickoff) continue; // neznáme ligu/čas – nevíme, zda je zápas sledovaný
    const [home, away] = row ? [row.home, row.away] : [m.home, m.away];
    if (have.has(`${home}|${away}|${m.pick}`)) continue;
    const market = resultMarket(m.pick, home, away);
    tips.push({
      home, away, leagueKey: league.key, league: league.nameCs, kickoff, tipCode: market.code, tipLabel: market.labelCs,
      rawLabel: "Forebet", probability: m.pickProbability, odds: m.odds[m.pick] ?? null, oddsEstimated: false,
      sources: [SOURCE_FOREBET], probForebet: m.pickProbability, forebetUrl: m.url || "",
      status: (row ? classifyStatus(row.statusToken) : null) || UPCOMING, homeScore: null, awayScore: null,
      url: row ? row.url : "", sofascoreUrl: "", sofascoreId: null, id: null, outcome: null, outcomeSource: null,
    });
  }
  return tips;
}

// --- celý běh ------------------------------------------------------------------------------------------------

const setStatus = (result, name, state, message = "") => { result.statuses[name] = { name, state, message }; };

/** Trhy, které Forebet z přehledu nepokryje, ale jeho stránka zápasu ano: góly celého zápasu a BTTS. */
const needsGoalsPage = (code) => code === "BTTS" || code === "NOBTTS" || /^[OU]\d+(?:\.\d+)?$/.test(code);

class Pipeline {
  constructor({ http, browser, debugDir = null, goalsCache = null }) {
    this.http = http;
    this.browser = browser;
    this.debugDir = debugDir;
    this.goalsCache = goalsCache;
  }

  /** @param {object} [opts] { progress, now, interactiveForebet } */
  async run({ progress = () => {}, now = new Date(), interactiveForebet = false } = {}) {
    const result = newResult(now);
    for (const name of [SOURCE_SCORES24, SOURCE_FOREBET, SOURCE_SOFASCORE]) setStatus(result, name, "pending");
    let s24 = null;
    let forebet = null;
    let goalsInfo = null;
    const stages = {}; // doba jednotlivých kroků v sekundách (do diagnostiky)
    let lapAt = Date.now();
    const lap = (name) => { stages[name] = Math.round((Date.now() - lapAt) / 100) / 10; lapAt = Date.now(); };

    // 1) Scores24 – hlavní zdroj
    try {
      s24 = await new Scores24Scraper(this.http, this.browser).fetch(now, progress);
      setStatus(result, SOURCE_SCORES24, s24.warnings.length ? "partial" : "ok",
        s24.warnings.length ? s24.warnings.join(" ") : `${s24.tips.length} tipů`);
    } catch (err) {
      if (err instanceof NetworkError) result.offline = Boolean(err.offline);
      const known = err instanceof SourceError || err instanceof BrowserUnavailable;
      setStatus(result, SOURCE_SCORES24, "failed", known ? err.message : `Neočekávaná chyba: ${err.message}`);
    }
    lap("Scores24");

    if (!resultOk(result)) {
      for (const name of [SOURCE_FOREBET, SOURCE_SOFASCORE]) setStatus(result, name, "skipped", "Přeskočeno – hlavní zdroj tipů není dostupný.");
      return this._finish(result);
    }

    // 2) Forebet – pravděpodobnosti (volitelný zdroj)
    try {
      const scraper = new ForebetScraper(this.http, this.browser);
      // Stránky lig na Forebetu se načítají jen pro ligy, které Scores24 právě nabízí.
      const leagues = new Set([...s24.rows, ...s24.tips].map((x) => x.leagueKey).filter(Boolean));
      forebet = await scraper.fetch(progress, { interactive: interactiveForebet, debugDir: this.debugDir, leagues });
      let message = `${forebet.length} zápasů`;
      let state = "ok";

      // Pravděpodobnosti gólů (Over/Under, oba týmy skórují) jsou jen na stránce zápasu.
      const wanted = new Set();
      const byNeed = [...s24.tips].sort((a, b) => (a.probability === null ? 0 : 1) - (b.probability === null ? 0 : 1));
      for (const t of byNeed) {
        if (!needsGoalsPage(t.tipCode) || t.status !== UPCOMING || !mayPass(t)) continue; // jen tipy, které filtry nezahodí
        const m = findForebet(t.home, t.away, t.leagueKey, t.kickoff, forebet);
        if (m && m.url) wanted.add(m);
      }
      if (wanted.size) {
        const g = await scraper.fetchGoals([...wanted], progress, { debugDir: this.debugDir, cache: this.goalsCache });
        if (this.goalsCache) this.goalsCache.save();
        goalsInfo = g;
        message += `, góly u ${g.parsed} z ${g.wanted} zápasů${g.cached ? ` (${g.cached} z mezipaměti)` : ""}`;
        if (g.parsed < g.wanted) {
          state = "partial";
          message += g.parsed === 0 && !g.errors.length
            ? " – na stránkách zápasů nejsou rozpoznatelné pravděpodobnosti gólů (změnila se struktura?)"
            : g.errors.length ? ` – chyby: ${g.errors[0]}` : "";
        }
      }
      setStatus(result, SOURCE_FOREBET, state, message);
    } catch (err) {
      const known = err instanceof SourceError || err instanceof BrowserUnavailable;
      setStatus(result, SOURCE_FOREBET, "failed", known ? err.message : `Neočekávaná chyba: ${err.message}`);
    }

    lap("Forebet");

    // 3) sloučení + povinné filtry
    let tips = applyFilters(combine(s24, forebet, now));

    // 4) SofaScore – přesný čas, stav, skóre
    const sofa = new SofaScoreClient(this.http);
    try {
      tips = await sofa.enrich(tips, progress);
      if (sofa.requestsOk === 0 && sofa.errors.length) setStatus(result, SOURCE_SOFASCORE, "failed", sofa.errors[0]);
      else setStatus(result, SOURCE_SOFASCORE, sofa.errors.length ? "partial" : "ok", sofa.errors[0] || `${sofa.requestsOk} dotazů`);
    } catch (err) {
      setStatus(result, SOURCE_SOFASCORE, "failed", `Neočekávaná chyba: ${err.message}`);
    }

    lap("SofaScore");
    result.tips = tips.sort((a, b) => a.kickoff - b.kickoff || b.probability - a.probability);
    this._writeDiagnostics(result, { s24, forebet, goalsInfo, sofa, stages });
    return this._finish(result);
  }

  /** Souhrn posledního stahování do `ladeni/zdroje-diagnostika.txt` (přepisuje se): stav zdrojů, párování Forebetu, pokrytí SofaScore. */
  _writeDiagnostics(result, { s24, forebet, goalsInfo, sofa, stages = {} }) {
    if (!this.debugDir) return;
    try {
      const lines = [`Stahování tipů – ${new Date().toISOString()}`, "", "Stav zdrojů:"];
      for (const st of Object.values(result.statuses)) lines.push(`  ${st.name}: ${st.state}${st.message ? ` – ${st.message}` : ""}`);
      const total = Object.values(stages).reduce((a, b) => a + b, 0);
      lines.push(`Doba kroků: ${Object.entries(stages).map(([k, v]) => `${k} ${v} s`).join(" · ")} · celkem ${Math.round(total * 10) / 10} s`);
      lines.push("", `Scores24: ${s24 ? s24.tips.length : 0} tipů před filtry; po filtrech ${result.tips.length}`);
      if (forebet) {
        lines.push(...forebetCoverage(s24 ? s24.tips : [], forebet));
        if (goalsInfo) lines.push(`Stránky zápasů (góly): přečteno ${goalsInfo.parsed} z ${goalsInfo.wanted}${goalsInfo.cached ? `, z toho ${goalsInfo.cached} z mezipaměti` : ""}${goalsInfo.errors.length ? `; chyby: ${goalsInfo.errors.slice(0, 3).join(" | ")}` : ""}`);
      } else {
        lines.push("Forebet: žádná data");
      }
      const groups = new Map();
      for (const t of result.tips) {
        const g = groups.get(marketGroup(t.tipCode)) || { n: 0, fb: 0 };
        g.n += 1;
        if (t.probForebet !== null && t.probForebet !== undefined) g.fb += 1;
        groups.set(marketGroup(t.tipCode), g);
      }
      lines.push("", "Tipy po filtrech podle typu (kolik z nich má pravděpodobnost z Forebetu):");
      for (const [name, g] of groups) lines.push(`  ${name}: ${g.n} (Forebet ${g.fb})`);
      const withId = result.tips.filter((t) => t.sofascoreId).length;
      lines.push("", `SofaScore: zápas nalezen u ${withId} z ${result.tips.length} tipů${sofa && sofa.errors.length ? `; chyby: ${sofa.errors.slice(0, 3).join(" | ")}` : ""}`);
      fs.mkdirSync(this.debugDir, { recursive: true });
      fs.writeFileSync(path.join(this.debugDir, "zdroje-diagnostika.txt"), `${lines.join("\n")}\n`, "utf8");
    } catch {
      /* ladicí soubor není nutný */
    }
  }

  _finish(result) {
    result.finishedAt = new Date();
    // Do bannerů ve UI jdou jen zdroje, které selhaly nebo se načetly částečně.
    result.warnings = Object.values(result.statuses)
      .filter((s) => (s.state === "failed" || s.state === "partial") && s.message)
      .map((s) => (s.message.startsWith(`${s.name}:`) ? s.message : `${s.name}: ${s.message}`));
    return result;
  }
}

// --- automatické vyhodnocení výsledků ----------------------------------------------------------------------

/** Vyhodnotí tipy skončených zápasů, jejichž skóre už v databázi je (bez sítě). Vrací počet vyhodnocených. */
function settleFinished(db) {
  let done = 0;
  for (const t of db.finishedUnsettled()) {
    const outcome = evaluate(t.tipCode, t.homeScore, t.awayScore);
    if (outcome === null) continue;
    db.setOutcome(t.id, outcome, "auto");
    done += 1;
  }
  return done;
}

/**
 * Doplní výsledky skončených zápasů podle SofaScore. Vrací {done, message}. Vyhodnocují se jen tipy bez
 * výsledku, jejichž zápas začal před více než 3 hodinami a nejsou starší než `maxAgeDays`. Ručně zadané
 * výsledky se nikdy nepřepisují (ty už výsledek mají). Neznámé trhy a čtvrtinové linie zůstávají ručně.
 */
async function updateResults(db, http, { progress = () => {}, maxAgeDays = 14, now = new Date() } = {}) {
  const cutoff = addDays(todayLocal(now), -maxAgeDays);
  const settled = settleFinished(db); // co už je skončené a má skóre, se vyhodnotí hned
  const before = new Date(now.getTime() - 100 * 60 * 1000); // zápas netrvá míň než ~100 min; skončení potvrdí SofaScore
  const byId = new Map();
  for (const t of [...db.pendingResults(before), ...db.needScores(before)]) byId.set(t.id, t); // bez výsledku, nebo bez skóre
  const pending = [...byId.values()].filter((t) => localDate(t.kickoff) >= cutoff);
  if (!pending.length) return settled ? { done: settled, message: `Vyhodnoceno ${settled} tipů.` } : { done: 0, message: "Žádné tipy nečekají na vyhodnocení." };

  progress("SofaScore: zjišťuji výsledky zápasů…");
  const client = new SofaScoreClient(http);
  let done = settled;
  let skipped = 0;
  for (const t of pending) {
    const league = config.leagueByKey(t.leagueKey);
    const needsOutcome = t.outcome === null;
    if (!league || !league.sofascoreId) { if (needsOutcome) skipped += 1; continue; }
    const ev = await client.find(league.sofascoreId, t.home, t.away, t.kickoff);
    if (!ev || ev.status !== FINISHED || ev.homeScore === null || ev.awayScore === null) { if (needsOutcome) skipped += 1; continue; }
    if (t.homeScore !== ev.homeScore || t.awayScore !== ev.awayScore || t.status !== FINISHED) db.setScore(t.id, ev.homeScore, ev.awayScore); // konečné skóre přepíše i zastaralé průběžné
    if (!needsOutcome) continue;
    const outcome = evaluate(t.tipCode, ev.homeScore, ev.awayScore);
    if (outcome === null) { skipped += 1; continue; }
    db.setOutcome(t.id, outcome, "auto");
    done += 1;
  }

  let message = `Vyhodnoceno ${done} tipů`;
  if (skipped) message += `, ${skipped} zůstává bez výsledku (zápas neskončil, nenalezen nebo trh nelze vyhodnotit automaticky)`;
  if (client.errors.length && !client.requestsOk) message = `SofaScore je nedostupný: ${client.errors[0]}`;
  return { done, message: `${message}.` };
}

module.exports = { Pipeline, combine, updateResults, settleFinished, findForebet, findRow, forebetCoverage };
