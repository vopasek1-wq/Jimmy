// Řízení celého stahování: zdroje → sloučení → povinné filtry → obohacení → výsledek.
//
//   Scores24  (tipy + procenta + kurzy)  ┐
//   Forebet   (pravděpodobnosti 1/X/2)   ├→ combine() → applyFilters() → SofaScore (čas, stav, skóre)
//   SofaScore (detaily zápasů)           ┘
//
// Každý zdroj může selhat samostatně – chyba se zapíše do stavu zdroje a ostatní pokračují. Běh se
// považuje za úspěšný, jen když prošel Scores24 (hlavní zdroj tipů).
"use strict";

const config = require("./config");
const { applyFilters } = require("./filters");
const { NetworkError, SourceError } = require("./http");
const { BrowserUnavailable } = require("./browser");
const { evaluate, forebetProbability, goalsProbability, resultMarket } = require("./markets");
const {
  UPCOMING, FINISHED, SOURCE_SCORES24, SOURCE_FOREBET, SOURCE_SOFASCORE, newResult, resultOk,
} = require("./models");
const { sameMatch } = require("./names");
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
  constructor({ http, browser, debugDir = null }) {
    this.http = http;
    this.browser = browser;
    this.debugDir = debugDir;
  }

  /** @param {object} [opts] { progress, now, interactiveForebet } */
  async run({ progress = () => {}, now = new Date(), interactiveForebet = false } = {}) {
    const result = newResult(now);
    for (const name of [SOURCE_SCORES24, SOURCE_FOREBET, SOURCE_SOFASCORE]) setStatus(result, name, "pending");
    let s24 = null;
    let forebet = null;

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

    if (!resultOk(result)) {
      for (const name of [SOURCE_FOREBET, SOURCE_SOFASCORE]) setStatus(result, name, "skipped", "Přeskočeno – hlavní zdroj tipů není dostupný.");
      return this._finish(result);
    }

    // 2) Forebet – pravděpodobnosti (volitelný zdroj)
    try {
      const scraper = new ForebetScraper(this.http, this.browser);
      forebet = await scraper.fetch(progress, { interactive: interactiveForebet });
      let message = `${forebet.length} zápasů`;
      let state = "ok";

      // Pravděpodobnosti gólů (Over/Under, oba týmy skórují) jsou jen na stránce zápasu.
      const wanted = new Set();
      const byNeed = [...s24.tips].sort((a, b) => (a.probability === null ? 0 : 1) - (b.probability === null ? 0 : 1));
      for (const t of byNeed) {
        if (!needsGoalsPage(t.tipCode)) continue;
        const m = findForebet(t.home, t.away, t.leagueKey, t.kickoff, forebet);
        if (m && m.url) wanted.add(m);
      }
      if (wanted.size) {
        const g = await scraper.fetchGoals([...wanted], progress, { debugDir: this.debugDir });
        message += `, góly u ${g.parsed} z ${g.wanted} zápasů`;
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

    result.tips = tips.sort((a, b) => a.kickoff - b.kickoff || b.probability - a.probability);
    return this._finish(result);
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
    if (t.homeScore === null) db.setScore(t.id, ev.homeScore, ev.awayScore); // skóre se doplní i u ručně vyhodnocených
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

module.exports = { Pipeline, combine, updateResults, settleFinished, findForebet, findRow };
