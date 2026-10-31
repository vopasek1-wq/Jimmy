// Scores24 – hlavní zdroj tipů (tip, procenta shody, kurz).
//
// Jak stránka vypadá (ověřeno na živém HTML):
//  * /en/predictions/soccer je vykreslená na serveru. Zápasy jsou v blocích podle lig; každý blok má
//    hlavičku s odkazem /en/soccer/l-<slug> a počtem zápasů „( 5 )“.
//  * Prvních pár lig je rozbalených (zápasy rovnou v HTML), ostatní jsou sbalené – jejich zápasy se
//    načtou až po kliknutí na hlavičku (proto okno prohlížeče).
//  * Řádek zápasu je odkaz .../soccer/m-…-prediction. Číslo vedle času je buď „today“/„tomorrow“,
//    „Ended“, nebo MINUTA právě hraného zápasu (ne datum!). Datum ve slugu odkazu (m-17-10-2026-…) je
//    datum vzniku tipu, ne zápasu.
//  * Časy v HTML jsou v UTC. Kurzy jsou desetinné (cookie userOddFormat=EU), jinak americké (-143).
//  * Názvy CSS tříd jsou hashované (sc-z1hstd-14…) a mění se, proto se parser opírá o strukturu
//    (odkazy, pořadí textů), ne o třídy.
"use strict";

const config = require("../config");
const { BrowserUnavailable } = require("../browser");
const { SourceError, BlockedError } = require("../http");
const { normalizePick } = require("../markets");
const { UPCOMING, LIVE, FINISHED, SOURCE_SCORES24 } = require("../models");
const { parseOdds } = require("../odds");
const { utcDateOf, addDays, utcDateTime } = require("../timeutil");
const { load, strippedStrings, textOf } = require("../dom");

const ROW_HREF = /\/soccer\/m-[^/]+-prediction\/?$/;
const LEAGUE_HREF = /\/soccer\/l-([^/?#]+)\/?$/;
const COUNT = /\(\s*(\d+)\s*\)/g;
const TIME = /^\d{1,2}:\d{2}$/;
const INT = /^\d{1,3}$/;

const SKIP_STATUS = new Set(["postponed", "cancelled", "canceled", "suspended", "abandoned", "walkover", "interrupted"]);
const FINISHED_STATUS = new Set(["ended", "ft", "finished", "aet", "pen", "after pen."]);
const LIVE_STATUS = new Set(["ht", "halftime", "half time", "live", "1h", "2h", "et", "break", "pause", "penalties"]);

// --- parsování HTML --------------------------------------------------------------------------------

/** Pokud je odkaz hlavičkou ligového bloku, vrátí {country, name, slug, declaredCount}. */
function headerOf($, a) {
  const m = LEAGUE_HREF.exec($(a).attr("href") || "");
  if (!m) return null;
  // Hlavička je malý prvek „Země Liga ( N )“. Odkazy na ligy v menu počet nemají, a protože se
  // kontroluje jen krátký text nejbližšího okolí (ne celé stránky), nelze je zaměnit.
  const parent = $(a).parent();
  for (const anc of [parent, parent.parent()]) {
    if (!anc.length) continue;
    const text = textOf(anc);
    const counts = [...text.matchAll(COUNT)];
    if (text.length <= 120 && counts.length === 1) {
      const name = textOf($(a));
      const strings = strippedStrings(anc);
      return { country: strings.length && strings[0] !== name ? strings[0] : "", name, slug: m[1], declaredCount: Number(counts[0][1]) };
    }
  }
  return null;
}

function blockSlugOfRow($, a, blocks) {
  // Najde ligový blok řádku: nejbližší předek, který obsahuje hlavičku ligy.
  const ancestors = $(a).parents().toArray().slice(0, 8);
  for (const anc of ancestors) {
    for (const link of $(anc).find("a[href]").toArray()) {
      const m = LEAGUE_HREF.exec($(link).attr("href") || "");
      if (m && blocks.has(m[1])) return m[1];
    }
  }
  return null;
}

/** Rozparsuje hlavní stránku na ligové bloky se zápasy. */
function parsePage(html, now) {
  const $ = load(html);
  const blocks = new Map();
  const anchors = $("a[href]").toArray();

  for (const a of anchors) {
    const info = headerOf($, a);
    if (info && !blocks.has(info.slug)) blocks.set(info.slug, { ...info, rows: [] });
  }
  for (const a of anchors) {
    if (!ROW_HREF.test($(a).attr("href") || "")) continue;
    const slug = blockSlugOfRow($, a, blocks);
    if (slug === null) continue;
    const row = parseRow($, a);
    if (row) {
      const block = blocks.get(slug);
      const league = config.findLeague(block.country, block.name, block.slug);
      row.leagueKey = league ? league.key : null;
      row.leagueText = `${block.country} ${block.name}`.trim();
      block.rows.push(row);
    }
  }
  return [...blocks.values()].map((b) => ({ ...b, league: config.findLeague(b.country, b.name, b.slug) }));
}

function parseRow($, a) {
  const main = $(a).children("div").first();
  if (!main.length) return null;
  const tokens = strippedStrings(main);
  if (!tokens.length) return null;

  // čas a stav (první dva texty řádku)
  const ti = tokens.findIndex((t) => TIME.test(t));
  if (ti < 0) return null;
  const timeStr = tokens[ti];
  const statusToken = ti + 1 < tokens.length ? tokens[ti + 1] : "";

  // týmy: spolehlivě z alt textu log, jinak z dalších dvou textů
  const alts = [];
  main.find("img").each((_, img) => {
    const alt = ($(img).attr("alt") || "").trim();
    if (alt && !alts.includes(alt)) alts.push(alt);
  });
  let home, away, afterTeams;
  if (alts.length >= 2) {
    [home, away] = alts;
    afterTeams = tokens.slice(ti + 2);
    while (afterTeams.length && (afterTeams[0] === home || afterTeams[0] === away)) afterTeams = afterTeams.slice(1);
  } else if (tokens.length >= ti + 4) {
    home = tokens[ti + 2];
    away = tokens[ti + 3];
    afterTeams = tokens.slice(ti + 4);
  } else {
    return null;
  }

  const row = {
    href: $(a).attr("href"), home, away, timeStr, statusToken, pickLabel: "", percent: null, odds: null,
    homeScore: null, awayScore: null, leagueKey: null, leagueText: "",
  };
  // ikona ohně (#fire) místo „palce“ (#finger-up): číslo vedle ní je čítač „hot“ tipu, ne procento shody
  const hot = main.find("use").toArray().some((u) => /#fire$/.test(u.attribs["xlink:href"] || u.attribs.href || ""));
  parseRightPart(row, afterTeams, { hot });
  row.url = config.SCORES24_BASE + row.href;
  return row;
}

/**
 * Pravá část řádku: [procenta] [%] tip, skóre domácích, skóre hostů, kurz. Procenta mohou chybět
 * (tip bez shody – takový řádek pak nesplní filtr) a znak „%“ se někdy vykresluje jen přes CSS,
 * proto se bere číslo ve struktuře.
 */
function parseRightPart(row, tokensIn, { hot = false } = {}) {
  let toks = tokensIn.filter((t) => t !== "%");
  if (!toks.length) return;
  const odds = parseOdds(toks[toks.length - 1]);
  if (odds !== null) {
    row.odds = odds;
    toks = toks.slice(0, -1);
  }
  // skóre: dva texty (číslice nebo „-“) těsně před kurzem
  if (toks.length >= 2 && toks.slice(-2).every((t) => /^(\d{1,2}|-)$/.test(t))) {
    const [s1, s2] = toks.slice(-2);
    row.homeScore = /^\d+$/.test(s1) ? Number(s1) : null;
    row.awayScore = /^\d+$/.test(s2) ? Number(s2) : null;
    toks = toks.slice(0, -2);
  }
  // procenta: číslo před popisem tipu
  if (toks.length >= 2 && INT.test(toks[0])) {
    // Scores24 občas ukáže víc než 100 (naměřeno: 101) – je to míra shody, ne pravděpodobnost.
    // Jako procento nad 100 by to byl nesmysl, proto se omezí na 100.
    // Číslo u ikony ohně bez znaku „%“ (naměřeno: 13, 36, 82) procento není – řádek zůstane bez procent.
    if (!(hot && !tokensIn.includes("%"))) row.percent = Math.min(Number(toks[0]), 100.0);
    toks = toks.slice(1);
  }
  row.pickLabel = toks.length ? toks[0] : "";
}

// --- stav a čas zápasu ---------------------------------------------------------------------------------

/** today/tomorrow → UPCOMING, minuta → LIVE, Ended → FINISHED; null = řádek ignorovat. */
function classifyStatus(token) {
  const t = token.trim().toLowerCase();
  if (SKIP_STATUS.has(t)) return null;
  if (t === "today" || t === "tomorrow") return UPCOMING;
  if (FINISHED_STATUS.has(t)) return FINISHED;
  if (LIVE_STATUS.has(t) || /^\d{1,3}(\+\d+)?'?$/.test(t)) return LIVE;
  return null;
}

/**
 * Začátek zápasu v UTC. Z řádku známe jen čas (UTC) a slovo today/tomorrow – datum tedy odvodíme od
 * dnešního UTC data. U probíhajících/odehraných zápasů je to „dnes“. Přesný čas později upřesní SofaScore.
 */
function kickoffOf(row, now) {
  if (classifyStatus(row.statusToken) === null) return null;
  const [hh, mm] = row.timeStr.split(":").map(Number);
  let day = utcDateOf(now);
  if (row.statusToken.trim().toLowerCase() === "tomorrow") day = addDays(day, 1);
  return utcDateTime(day, hh, mm);
}

/**
 * Převede řádek na tip; null, pokud nejde o použitelný tip. Řádek bez procent (Scores24 je u zítřejších zápasů
 * neuvádí) zůstane kandidátem s `probability: null` – procenta mu může doplnit Forebet, jinak ho odfiltrují filtry.
 */
function rowToTip(row, now) {
  if (row.leagueKey === null || !row.pickLabel) return null;
  const kickoff = kickoffOf(row, now);
  if (kickoff === null) return null;
  const league = config.leagueByKey(row.leagueKey);
  const market = normalizePick(row.pickLabel, row.home, row.away);
  return {
    home: row.home, away: row.away, leagueKey: league.key, league: league.nameCs, kickoff,
    tipCode: market.code, tipLabel: market.labelCs, rawLabel: row.pickLabel,
    probability: row.percent, probSource: row.percent === null ? null : SOURCE_SCORES24, odds: row.odds, oddsEstimated: false, sources: [SOURCE_SCORES24],
    probForebet: null, status: classifyStatus(row.statusToken) || UPCOMING,
    homeScore: row.homeScore, awayScore: row.awayScore, url: row.url, sofascoreUrl: "", sofascoreId: null,
    id: null, outcome: null, outcomeSource: null,
  };
}

// --- scraper ---------------------------------------------------------------------------------------------

function mergeBlocks(base, expanded) {
  const bySlug = new Map(expanded.map((b) => [b.slug, b]));
  for (const b of base) {
    if (!b.rows.length && bySlug.has(b.slug)) b.rows = bySlug.get(b.slug).rows;
  }
  return base;
}

class Scores24Scraper {
  constructor(http, browser) {
    this.http = http;
    this.browser = browser;
  }

  async fetch(now, progress = () => {}) {
    progress("Scores24: stahuji tipy…");
    const cookie = Object.entries(config.SCORES24_COOKIES).map(([k, v]) => `${k}=${v}`).join("; ");
    const html = await this.http.getText(config.SCORES24_URL, { headers: { Cookie: cookie } });
    let blocks = parsePage(html, now);
    if (!blocks.length) throw new SourceError("Scores24: na stránce se nepodařilo najít žádné ligy (změnila se struktura webu?).");

    const warnings = [];
    const collapsed = blocks.filter((b) => b.league && b.declaredCount > 0 && b.rows.length === 0);
    if (collapsed.length) {
      const names = collapsed.map((b) => b.league.nameCs).join(", ");
      progress("Scores24: rozbaluji sbalené ligy…");
      try {
        const expanded = await this.browser.expandScores24(config.SCORES24_URL, collapsed.map((b) => b.slug));
        blocks = mergeBlocks(blocks, parsePage(expanded, now));
      } catch (err) {
        if (!(err instanceof BrowserUnavailable || err instanceof BlockedError || err instanceof SourceError)) throw err;
        warnings.push(`Scores24: sbalené ligy (${names}) nejsou načtené – ${err.message}`);
      }
      const info = this.browser.lastExpand || {};
      // liga, která se otevřela, ale její zápasy nemají tip, chybou není; bez informace z okna platí stará podmínka
      const still = blocks.filter((b) => b.league && b.declaredCount > 0 && b.rows.length === 0 && info[b.slug] !== true);
      if (still.length && !warnings.length) {
        warnings.push(`Scores24: nepodařilo se rozbalit ligy: ${still.map((b) => `${b.league.nameCs}${typeof info[b.slug] === "string" ? ` (${info[b.slug]})` : ""}`).join(", ")}`);
      }
    }

    const rows = blocks.filter((b) => b.league).flatMap((b) => b.rows);
    const tips = rows.map((r) => rowToTip(r, now)).filter(Boolean);
    return { tips, rows, warnings };
  }
}

module.exports = { Scores24Scraper, parsePage, parseRow, classifyStatus, kickoffOf, rowToTip };
