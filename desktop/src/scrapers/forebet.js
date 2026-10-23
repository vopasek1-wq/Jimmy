// Forebet – statistické pravděpodobnosti výsledku 1 / X / 2.
//
// !!! UPOZORNĚNÍ: tento modul nebyl ověřen na živém webu !!!
// Forebet je chráněn Cloudflare a při vývoji ho nepustil ani skutečný prohlížeč z datacentrové IP.
// Parser proto vychází ze známé struktury stránky (div.rcnt, .homeTeam/.awayTeam, .fprc, .forepr,
// .haodd, time[datetime]) a je otestován jen na ručně sestavené ukázce. Kdyby Forebet značky změnil,
// aplikace to nahlásí („změnila se struktura“) a ostatní zdroje poběží dál.
//
// Postup načtení: 1) obyčejné HTTP (síťový stack Chromia), 2) skryté okno prohlížeče, které počká na
// dokončení kontroly „Just a moment…“, 3) na požádání viditelné okno, kde kontrolu dokončí uživatel.
"use strict";

const config = require("../config");
const { BlockedError, SourceError, looksBlocked } = require("../http");
const { parseOdds } = require("../odds");
const fs = require("node:fs");
const path = require("node:path");
const { load, collapse, strippedStrings } = require("../dom");
const { localToUtc } = require("../timeutil");

const text = ($el) => (($el && $el.length) ? collapse($el.text()) : "");
const toInt = (s) => { const m = /\d{1,3}/.exec(s); return m ? Number(m[0]) : null; };

function teamNames($, row) {
  const home = text(row.find(".homeTeam").first());
  const away = text(row.find(".awayTeam").first());
  if (home && away) return [home, away];
  // záloha: odkaz na zápas má v textu/atributu „Domácí - Hosté“
  for (const el of [row.find("a.tnmscn").first(), row.find("meta[itemprop=name]").first()]) {
    if (!el.length) continue;
    const raw = el.attr("content") || el.attr("title") || text(el);
    const parts = raw.trim().split(/\s+(?:-|–|vs\.?)\s+/);
    if (parts.length >= 2) return [parts[0].trim(), parts.slice(1).join(" ").trim()];
  }
  return ["", ""];
}

function kickoff($, row) {
  const raw = (row.find("time[datetime]").first().attr("datetime") || "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(raw);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  // Forebet píše čas zápasu v pražském čase (u spárovaných zápasů vycházel rozdíl proti Scores24 přesně o 2 hodiny).
  m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(text(row.find(".date_bah").first()));
  if (m) return localToUtc(+m[3], +m[2], +m[1], +m[4], +m[5]);
  return null;
}

const LEAGUE_HREF = /football-tips-and-predictions-for-([a-z0-9-]+)\/([a-z0-9-]+)/i;

/** Zkratka ligy: každý řádek Forebetu nese vlastní `.shortTag`; záloha je nejbližší hlavička nad řádkem. */
function leagueText($, row) {
  const own = row.find(".shortTag").first();
  if (own.length) return text(own);
  let node = row.prev();
  while (node.length) {
    const tag = node.find(".shortTag").first();
    if (tag.length) return text(tag);
    node = node.prev();
  }
  return "";
}

/** „země/liga“ ze všech odkazů v kusu stránky (např. czech-rep/chance-liga), bez duplicit, v pořadí na stránce. */
function leaguePaths($, scope) {
  const out = [];
  const add = (v) => { const p = String(v).toLowerCase(); if (!out.includes(p)) out.push(p); };
  scope.find("a[href]").each((_, a) => { const m = LEAGUE_HREF.exec($(a).attr("href") || ""); if (m) add(`${m[1]}/${m[2]}`); });
  return out;
}

/** „země/liga“ z řádku zápasu: odkaz na ligu, nebo ze znaku ligy `getstag(this,id,'Oman','Professional League','oman/professional-league','om')`. */
function leaguePath($, row) {
  const own = leaguePaths($, row)[0];
  if (own) return own;
  const click = row.find("[onclick*='getstag']").first().attr("onclick") || "";
  const m = /getstag\([^)]*'([a-z0-9-]+\/[a-z0-9-]+)'\s*,\s*'[^']*'\)/i.exec(click);
  return m ? m[1].toLowerCase().replace(/^football-tips-and-predictions-for-/, "") : "";
}

function leagueKeyOf(tagText, pathText = "") {
  const tag = (tagText || "").trim();
  const lg = config.LEAGUES.find((l) => l.enabled
    && ((tag && l.forebetTags.includes(tag)) || (pathText && (l.forebetPaths || []).some((re) => re.test(pathText)))));
  return lg ? lg.key : null;
}

/** Odkaz na stránku zápasu (tam jsou i pravděpodobnosti gólů). */
function matchUrl($, row) {
  const a = row.find("a.tnmscn[href], a[href*='/football/matches/']").first();
  const href = (a.attr("href") || "").trim();
  if (!href) return "";
  try {
    return new URL(href, config.FOREBET_URL).toString();
  } catch {
    return "";
  }
}

function parseRow($, row) {
  const [home, away] = teamNames($, row);
  const probs = row.find(".fprc span").toArray().map((s) => toInt(text($(s)))).filter((p) => p !== null);
  if (!home || !away || probs.length !== 3) return null;
  const [p1, px, p2] = probs;

  let pick = text(row.find(".forepr").first()).toUpperCase();
  if (!["1", "X", "2"].includes(pick)) pick = ["1", "X", "2"][[p1, px, p2].indexOf(Math.max(p1, px, p2))];

  const oddsVals = row.find(".haodd span").toArray().map((s) => parseOdds(text($(s))));
  const odds = oddsVals.length === 3 ? { 1: oddsVals[0], X: oddsVals[1], 2: oddsVals[2] } : {};

  const lt = leagueText($, row);
  const lp = leaguePath($, row);
  return {
    url: matchUrl($, row), home, away, kickoff: kickoff($, row), p1, px, p2, pick, odds, leagueKey: leagueKeyOf(lt, lp), leagueText: lt || lp,
    pickProbability: { 1: p1, X: px, 2: p2 }[pick],
  };
}

function parsePage(html) {
  const $ = load(html);
  let rows = $("div.rcnt").toArray();
  if (!rows.length) rows = $(".fprc").toArray().map((fp) => $(fp).parent()[0]); // záloha: nadřazený blok pravděpodobností
  const out = [];
  for (const el of rows) {
    try {
      const m = parseRow($, $(el));
      if (m) out.push(m);
    } catch {
      /* jeden vadný řádek nesmí shodit celý zdroj */
    }
  }
  return out;
}

// --- stránka zápasu: pravděpodobnosti gólů -------------------------------------------------------------------
// Ověřeno na skutečné stránce zápasu (z diagnostiky): text obsahuje tabulky s hlavičkou a řádkem zápasu, např.
//   „… Prob. % Under/Over 2.5 Pred … Round 10 Es1 Racing Santander Espanyol 24/10/2026 16:15 44 56 Over …“  (Under 44 %, Over 56 %)
//   „… Prob. % No Yes Pred … 24/10/2026 16:15 41 59 Yes …“                                              (BTTS ne 41 %, ano 59 %)
// Pro případ, že Forebet tabulky změní, zůstává záloha podle viditelného textu („Over 2.5 … 55 %“, „Both teams to score … Yes 52 %“).

const num = (s) => Number(String(s).replace(",", "."));

const PLAIN = String.raw`(?<![\d.,])(\d{1,3})(?![\d]|[.,]\d)`; // celé číslo (ne část kurzu 1.85)
const near100 = (a, b) => a + b >= 97 && a + b <= 103;

const DATE_TIME = String.raw`\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}`;
const TABLE_OU = new RegExp(String.raw`Prob\.\s*%\s*Under\/Over\s*(\d(?:[.,]\d)?)\b[^]*?${DATE_TIME}\s+(\d{1,3})\s+(\d{1,3})\s+(?:Over|Under)\b`, "i");
const TABLE_BTTS = new RegExp(String.raw`Prob\.\s*%\s*No\s+Yes\b[^]*?${DATE_TIME}\s+(\d{1,3})\s+(\d{1,3})\s+(?:Yes|No)\b`, "i");

function parseGoals(html) {
  const $ = load(html);
  const text = strippedStrings($.root()).join(" ");
  const goals = { over: {}, under: {}, btts: {} };

  // 0) tabulky zápasu: první dvě čísla za datem jsou pravděpodobnosti (Under, Over) resp. (Ne, Ano) a dávají dohromady ≈ 100
  const tou = TABLE_OU.exec(text);
  const tableOu = Boolean(tou && near100(+tou[2], +tou[3]));
  if (tableOu) { const line = String(num(tou[1])); goals.under[line] = +tou[2]; goals.over[line] = +tou[3]; }
  const tb = TABLE_BTTS.exec(text);
  const tableBtts = Boolean(tb && near100(+tb[1], +tb[2]));
  if (tableBtts) { goals.btts.no = +tb[1]; goals.btts.yes = +tb[2]; }

  // 1) záloha podle textu s procentem: „Over 2.5 … 57 %“
  const ou = /\b(over|under)\s*(\d(?:[.,]\d)?)\b/gi;
  const lines = new Map(); // linie → { over: [pozice], under: [pozice] }
  for (let m = tableOu ? null : ou.exec(text); m; m = ou.exec(text)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 45);
    const pct = /(\d{1,3}(?:[.,]\d+)?)\s*%/.exec(after);
    const bucket = m[1].toLowerCase() === "over" ? goals.over : goals.under;
    const line = String(num(m[2]));
    if (pct && num(pct[1]) <= 100) { if (!(line in bucket)) bucket[line] = num(pct[1]); continue; }
    const plain = new RegExp(PLAIN).exec(after); // 2) bez značky %: platí jen když se dvojice Over/Under sečte na ≈100
    const entry = lines.get(line) || {};
    if (plain && !entry[m[1].toLowerCase()]) entry[m[1].toLowerCase()] = Number(plain[1]);
    lines.set(line, entry);
  }
  for (const [line, e] of lines) {
    if (e.over !== undefined && e.under !== undefined && near100(e.over, e.under)) {
      goals.over[line] ??= e.over;
      goals.under[line] ??= e.under;
    }
  }

  const label = tableBtts ? null : /both teams to score|\bbtts\b/i.exec(text);
  if (label) {
    const win = text.slice(label.index, label.index + 170);
    const yes = /\byes\b\D{0,15}?(\d{1,3}(?:[.,]\d+)?)\s*%/i.exec(win) || new RegExp(String.raw`\byes\b\D{0,15}?${PLAIN}`, "i").exec(win);
    const no = /\bno\b\D{0,15}?(\d{1,3}(?:[.,]\d+)?)\s*%/i.exec(win) || new RegExp(String.raw`\bno\b\D{0,15}?${PLAIN}`, "i").exec(win);
    if (yes && no && near100(num(yes[1]), num(no[1])) || (yes && /%/.test(yes[0]))) goals.btts.yes = num(yes[1]);
    if (yes && no && near100(num(yes[1]), num(no[1])) || (no && /%/.test(no[0]))) goals.btts.no = num(no[1]);
    if (goals.btts.yes === undefined) delete goals.btts.yes;
    if (goals.btts.no === undefined) delete goals.btts.no;
  }
  const found = Object.keys(goals.over).length + Object.keys(goals.under).length + Object.keys(goals.btts).length;
  return found ? goals : null;
}

const hasBtts = (goals) => Boolean(goals && goals.btts && (goals.btts.yes !== undefined || goals.btts.no !== undefined));

/** Krátká diagnostika pro případ, že se stránka zápasu nepodařilo přečíst (jde ji poslat vývojáři). */
function goalsDiagnostics(url, html) {
  const text = strippedStrings(load(html).root()).join(" ");
  const windows = [];
  const re = /over|under|both teams|btts|goals?\b|yes\b/gi;
  let last = -999;
  for (let m = re.exec(text); m && windows.length < 40; m = re.exec(text)) {
    if (m.index - last < 120) continue;
    last = m.index;
    windows.push(text.slice(Math.max(0, m.index - 60), m.index + 160));
  }
  return [`URL: ${url}`, `Délka HTML: ${html.length}`, `Zablokováno: ${looksBlocked(200, html)}`, `Délka textu: ${text.length}`, "--- úryvky kolem „over/under/goals/yes“ ---", ...windows].join("\n");
}

const LEAGUE_LINK = /\/football-tips-and-predictions-for-([a-z0-9-]+)\/([a-z0-9-]+)\/?$/i;

/** Odkazy na stránky lig z nabídky Forebetu: [{ path: "england/premier-league", url }] v pořadí na stránce, bez duplicit. */
function leagueLinks(html) {
  const $ = load(html);
  const out = [];
  const seen = new Set();
  $("a[href]").each((_, a) => {
    const href = String($(a).attr("href") || "").split(/[?#]/)[0];
    const m = LEAGUE_LINK.exec(href);
    if (!m) return;
    const p = `${m[1]}/${m[2]}`.toLowerCase();
    if (seen.has(p)) return;
    seen.add(p);
    try { out.push({ path: p, url: new URL(href, config.FOREBET_URL).toString() }); } catch { /* vadný odkaz */ }
  });
  return out;
}

/**
 * Které stránky lig načíst. Pro každou požadovanou sledovanou ligu seznam adres, které se zkoušejí popořadě, dokud některá
 * nevrátí zápasy: odkaz z nabídky Forebetu (podle `forebetPaths`), jinak odhady adresy (`forebetGuess`) a nakonec stránka celé
 * země (`forebetCountry`), ze které se vezmou jen zápasy dané ligy. Vrací [{ key, candidates: [{ url, path, from, force }] }];
 * `force` = všechny zápasy na stránce patří do ligy.
 */
function leagueTargets(links, keys) {
  const out = [];
  for (const key of keys) {
    const lg = config.LEAGUES.find((l) => l.key === key && l.enabled);
    if (!lg) continue;
    const hit = links.find((l) => (lg.forebetPaths || []).some((re) => re.test(l.path)));
    const candidates = [];
    if (hit) candidates.push({ url: hit.url, path: hit.path, from: "nabídka", force: true });
    else {
      for (const g of [].concat(lg.forebetGuess || [])) candidates.push({ url: config.forebetLeagueUrl(g), path: g, from: "odhad", force: true });
      if (lg.forebetCountry) candidates.push({ url: config.forebetLeagueUrl(lg.forebetCountry), path: lg.forebetCountry, from: "země", force: false });
    }
    if (candidates.length) out.push({ key, candidates });
  }
  return out;
}

/** Přehled struktury stránky se seznamem zápasů (značky lig, odkazy na ligy, ukázka řádků, nejčastější třídy). */
function listDiagnostics(html, { brief = false } = {}) {
  const $ = load(html);
  const count = (sel) => $(sel).length;
  const tags = new Map();
  $(".shortTag").each((_, el) => { const t = text($(el)); if (t) tags.set(t, (tags.get(t) || 0) + 1); });
  const head = [
    `Délka HTML: ${html.length}`, `Zablokováno: ${looksBlocked(200, html)}`,
    `div.rcnt: ${count("div.rcnt")}, .fprc: ${count(".fprc")}, .homeTeam: ${count(".homeTeam")}, .awayTeam: ${count(".awayTeam")}, `
      + `time[datetime]: ${count("time[datetime]")}, .shortTag: ${count(".shortTag")}, a.tnmscn: ${count("a.tnmscn")}`,
    `Značky lig na stránce (${tags.size}): ${[...tags].slice(0, 40).map(([t, n]) => `${t}:${n}`).join(" ")}`,
  ];
  if (brief) return head.join("\n");
  const links = leagueLinks(html);
  const tracked = config.LEAGUES.filter((l) => l.enabled).map((lg) => {
    const hit = links.find((l) => (lg.forebetPaths || []).some((re) => re.test(l.path)));
    return `${lg.key}=${hit ? hit.path : "NENALEZENO"}`;
  });
  const classes = new Map();
  $("[class]").each((_, el) => { for (const c of String($(el).attr("class")).split(/\s+/)) if (c) classes.set(c, (classes.get(c) || 0) + 1); });
  const top = [...classes].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([c, n]) => `${c}:${n}`).join(" ");
  const sample = $("div.rcnt").toArray().slice(0, 1).map((el) => collapse($.html(el)).slice(0, 1200));
  // ukázka nabídky: země s ligami podle odkazů (pro případ, že se sledovaná liga nenašla)
  const countries = new Map();
  for (const l of links) { const [c, lg] = l.path.split("/"); countries.set(c, [...(countries.get(c) || []), lg]); }
  const menu = [...countries].filter(([c]) => /^(england|spain|italy|germany|france|netherlands|portugal|belgium|turkey|scotland|czech|europe|world|international|uefa)/.test(c))
    .map(([c, l]) => `${c}: ${l.slice(0, 6).join(", ")}`).join(" | ");
  return [
    ...head,
    `Odkazy na ligy v nabídce: ${links.length}; sledované ligy: ${tracked.join(" ")}`,
    `Nabídka sledovaných zemí: ${menu || "–"}`,
    ...sample.map((h) => `HTML řádku: ${h}`),
    `Nejčastější třídy: ${top}`, `Začátek textu: ${strippedStrings($.root()).join(" ").slice(0, 200)}`,
  ].join("\n");
}

/** Textový přehled jednoho načteného seznamu pro ladicí soubor (první stránka podrobně, ostatní stručně). */
function listReport({ url, html, matches, via, error }, detailed) {
  const tracked = matches.filter((m) => m.leagueKey).length;
  const out = [`=== ${url} ===`];
  if (error) out.push(`Chyba: ${error}`);
  out.push(`Načteno přes: ${via || "?"}; zápasů ${matches.length}, ze sledovaných lig ${tracked}`);
  if (html && !looksBlocked(200, html)) out.push(listDiagnostics(html, { brief: !detailed }));
  return out.join("\n");
}

/** Uloží přehledy (vždy) a HTML první stránky, ze které se nepodařilo přečíst žádný zápas. */
function dumpLists(debugDir, lists) {
  if (!debugDir || !lists.length) return;
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    const first = lists[0];
    if (first.html && !looksBlocked(200, first.html) && !first.matches.length) fs.writeFileSync(path.join(debugDir, "forebet-seznam.html"), first.html.slice(0, 200000));
    const body = lists.map((l, i) => listReport(l, i === 0)).join("\n\n");
    fs.writeFileSync(path.join(debugDir, "forebet-seznam-diagnostika.txt"), `${new Date().toISOString()}\n${body}\n`);
  } catch { /* ladicí soubor je jen bonus */ }
}

const LEAGUE_CONCURRENCY = 3;
const LEAGUE_DELAY_MS = [300, 700]; // stránky lig jsou drobné dotazy na tentýž server – kratší pauza než u ostatních zdrojů
const pageReady = (html) => !looksBlocked(200, html) && (html.includes("rcnt") || html.includes("fprc"));
/** Stránka ligy je hotová i bez zápasů (velká stránka s nabídkou), jen ji nesmí zastavit Cloudflare. */
const leaguePageReady = (html) => pageReady(html) || (!looksBlocked(200, html) && html.length > 100000);

class ForebetScraper {
  constructor(http, browser) {
    this.http = http;
    this.browser = browser;
  }

  /** Přehled „dnes“ (a záložní starý přehled): obyčejné HTTP, jinak okno prohlížeče. Vrací { url, matches, html, via }. */
  async _list(url, { interactive, progress }) {
    let plainHtml = "";
    if (!interactive) {
      try {
        plainHtml = await this.http.getText(url);
        const matches = parsePage(plainHtml);
        if (matches.length) return { url, matches, html: plainHtml, via: "HTTP" };
      } catch (err) {
        if (!(err instanceof BlockedError)) throw err;
      }
    }
    progress(interactive ? "Forebet: čekám na dokončení ověření v okně…" : "Forebet: zkouším prohlížeč (ochrana Cloudflare)…");
    const html = await this.browser.loadHtml(url, { ready: pageReady, waitMs: interactive ? 8000 : 15000, interactive, title: "Forebet – dokončete ověření" });
    if (looksBlocked(200, html)) {
      throw new BlockedError("Forebet: Cloudflare kontrola neprošla. Klikněte na „Ověřit Forebet“ – otevře se okno, kde ji dokončíte. "
        + "Tipy ze Scores24 se zobrazují i bez Forebetu.");
    }
    return { url, matches: parsePage(html), html, via: "okno prohlížeče" };
  }

  /** Stáhne seznam stránek: obyčejné HTTP; když Forebet žádá ověření, zbylé stránky projdou jedním skrytým oknem. Vrací [{ html, via, error }]. */
  async _fetchPages(items, state, progress) {
    const out = items.map(() => null);
    const rest = [];
    const queue = items.map((_, i) => i);
    const worker = async () => { // tři stránky najednou; po prvním požadavku na ověření se zbylé předají oknu prohlížeče
      while (queue.length) {
        const i = queue.shift();
        if (state.useBrowser) { rest.push(i); continue; }
        try {
          out[i] = { html: await this.http.getText(items[i].url, { delayMs: LEAGUE_DELAY_MS }), via: "HTTP" };
        } catch (err) {
          if (err instanceof BlockedError) { state.useBrowser = true; rest.push(i); } else out[i] = { html: "", via: "", error: err.message || String(err) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LEAGUE_CONCURRENCY, items.length) }, worker));
    rest.sort((x, y) => x - y);
    if (rest.length) {
      progress(`Forebet: ${rest.length} stránek lig v okně prohlížeče…`);
      let pages = [];
      let failure = "stránka se nenačetla";
      try { pages = await this.browser.loadPages(rest.map((i) => items[i].url), { ready: leaguePageReady, waitMs: 9000 }); } catch (err) { failure = err.message || failure; }
      rest.forEach((i, k) => { out[i] = { html: pages[k] || "", via: "okno prohlížeče", ...(pages[k] ? {} : { error: failure }) }; });
    }
    return out;
  }

  /**
   * Stránky sledovaných lig. V každém kole se zkusí další adresa u lig, které zatím nevrátily žádný zápas (nabídka → odhady → stránka země).
   * Vrací všechny pokusy: [{ key, url, path, from, html, via, error, matches }]; zápasům se nastaví liga podle stránky (u stránky země podle značky).
   */
  async _leaguePages(targets, progress) {
    const attempts = [];
    const state = { useBrowser: false };
    let pending = targets.map((t) => ({ key: t.key, candidates: t.candidates, i: 0 }));
    let done = 0;
    while (pending.length) {
      const items = pending.map((t) => ({ key: t.key, ...t.candidates[t.i] }));
      progress(`Forebet: ligy (${Math.min(done + 1, targets.length)}–${Math.min(done + items.length, targets.length)} z ${targets.length})…`);
      const pages = await this._fetchPages(items, state, progress);
      const next = [];
      items.forEach((it, k) => {
        const page = pages[k];
        let matches = page.html && !looksBlocked(200, page.html) ? parsePage(page.html) : [];
        if (it.force) for (const m of matches) { m.leagueKey = it.key; m.leagueText = m.leagueText || it.path; }
        else matches = matches.filter((m) => m.leagueKey === it.key);
        attempts.push({ ...it, ...page, matches });
        const t = pending[k];
        if (!matches.length && t.i + 1 < t.candidates.length) next.push({ ...t, i: t.i + 1 });
      });
      done += items.length - next.length;
      pending = next;
    }
    return attempts;
  }

  /**
   * Zápasy z Forebetu: přehled „dnes“ slouží hlavně jako zdroj odkazů na stránky lig; pak se načtou stránky sledovaných lig
   * (`leagues` = klíče lig, které Scores24 teď nabízí), jejich zápasy mají jistě správnou ligu. Starý přehled se bere, jen když
   * nevyšlo nic jiného. @param {object} [opts] { interactive, debugDir, leagues }
   */
  async fetch(progress = () => {}, { interactive = false, debugDir = null, leagues = null } = {}) {
    progress("Forebet: stahuji pravděpodobnosti…");
    const merged = [];
    const seen = new Set();
    const add = (list) => {
      for (const m of list) {
        const key = m.url || `${m.home}|${m.away}|${m.kickoff ? m.kickoff.getTime() : ""}`;
        if (!seen.has(key)) { seen.add(key); merged.push(m); }
      }
    };
    const reports = [];
    let firstError = null;
    let links = [];

    try {
      const today = await this._list(config.FOREBET_TODAY_URL, { interactive, progress });
      reports.push(today);
      links = leagueLinks(today.html);
      add(today.matches);
    } catch (err) {
      if (err instanceof BlockedError) { dumpLists(debugDir, reports); throw err; } // ověření je třeba u všech stránek stejně
      firstError = err;
      reports.push({ url: config.FOREBET_TODAY_URL, html: "", matches: [], via: "", error: err.message || String(err) });
    }

    const keys = leagues ? [...leagues] : config.LEAGUES.filter((l) => l.enabled).map((l) => l.key);
    const targets = leagueTargets(links, keys);
    if (targets.length) {
      for (const page of await this._leaguePages(targets, progress)) {
        reports.push({ url: `${page.url}  [${page.key}, ${page.from}]`, html: page.html, matches: page.matches, via: page.via, error: page.error });
        add(page.matches);
      }
    }

    if (!merged.length) { // nic z lig ani z přehledu → starý přehled
      try {
        const old = await this._list(config.FOREBET_URL, { interactive: false, progress });
        reports.push(old);
        add(old.matches);
      } catch (err) {
        firstError ??= err;
        reports.push({ url: config.FOREBET_URL, html: "", matches: [], via: "", error: err.message || String(err) });
      }
    }
    dumpLists(debugDir, reports);
    if (!merged.length) throw firstError || new SourceError("Forebet: na stránce nejsou rozpoznatelné zápasy (změnila se struktura webu?).");
    return merged;
  }

  /**
   * Doplní `goals` k zápasům ze seznamu načtením jejich stránek (max. `limit`).
   * Vrací { wanted, parsed, errors } – chyby jednotlivých stránek nic neshodí.
   */
  async fetchGoals(matches, progress = () => {}, { limit = 25, debugDir = null, cache = null } = {}) {
    const todo = [...new Set(matches.filter((m) => m && m.url))].slice(0, limit);
    const summary = { wanted: todo.length, parsed: 0, cached: 0, errors: [] };
    let useBrowser = false;
    let dumped = false;
    for (const [i, m] of todo.entries()) {
      const hit = cache && cache.get(m.url);
      // nedávno staženo → bez dotazu; tip „oba týmy skórují“ ale potřebuje i BTTS, bez něj se stránka stáhne znovu
      if (hit && !(m.needBtts && !hasBtts(hit))) { m.goals = hit; summary.parsed += 1; summary.cached += 1; continue; }
      progress(`Forebet: pravděpodobnosti gólů (${i + 1}/${todo.length})…`);
      try {
        let html = "";
        if (!useBrowser) {
          try {
            html = await this.http.getText(m.url);
          } catch (err) {
            if (!(err instanceof BlockedError)) throw err;
            useBrowser = true;
          }
        }
        if (useBrowser) html = await this.browser.loadHtml(m.url, { ready: (h) => !looksBlocked(200, h) && h.length > 20000, waitMs: 12000 });
        if (looksBlocked(200, html)) throw new BlockedError("Cloudflare");
        m.goals = parseGoals(html);
        if (!m.goals && !useBrowser) { // část stránky se může doplňovat skriptem – zkusit vykreslené okno
          const rendered = await this.browser.loadHtml(m.url, { ready: (h) => !looksBlocked(200, h) && h.length > 20000, waitMs: 12000 });
          const again = parseGoals(rendered);
          if (again) { m.goals = again; useBrowser = true; } else html = rendered;
        }
        if (m.goals) { summary.parsed += 1; if (cache) cache.set(m.url, m.goals); }
        if ((!m.goals || (m.needBtts && !hasBtts(m.goals))) && debugDir && !dumped) { // ladicí soubor: stránka, ze které se nepodařilo přečíst góly / BTTS
          dumped = true;
          try {
            fs.mkdirSync(debugDir, { recursive: true });
            fs.writeFileSync(path.join(debugDir, "forebet-zapas.html"), html.slice(0, 200000));
            fs.writeFileSync(path.join(debugDir, "forebet-diagnostika.txt"), goalsDiagnostics(m.url, html));
          } catch { /* ladicí soubor je jen bonus */ }
        }
      } catch (err) {
        summary.errors.push(err.message || String(err));
        if (summary.errors.length >= 3 && !summary.parsed) break; // zjevně to nejde – nezdržovat
      }
    }
    return summary;
  }
}

module.exports = { ForebetScraper, parsePage, parseGoals, pageReady, listDiagnostics, leagueLinks, leagueTargets };
