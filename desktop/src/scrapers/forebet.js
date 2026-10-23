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
const { EXPAND_MORE_SCRIPT } = require("../browser");

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
  m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(text(row.find(".date_bah").first()));
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]));
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

/** „země/liga“ z odkazu na ligu v řádku (např. czech-rep/chance-liga), když tam nějaký je. */
function leaguePath($, row) {
  for (const a of row.find("a[href]").toArray()) {
    const m = LEAGUE_HREF.exec($(a).attr("href") || "");
    if (m) return `${m[1]}/${m[2]}`.toLowerCase();
  }
  return "";
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
// !!! Neověřeno na živé stránce (Cloudflare mě nepustil): hledá se podle viditelného textu („Over 2.5 … 55 %“,
// „Both teams to score … Yes 52 % No 48 %“), ne podle názvů tříd, aby to přežilo změny značek.

const num = (s) => Number(String(s).replace(",", "."));

const PLAIN = String.raw`(?<![\d.,])(\d{1,3})(?![\d]|[.,]\d)`; // celé číslo (ne část kurzu 1.85)
const near100 = (a, b) => a + b >= 97 && a + b <= 103;

function parseGoals(html) {
  const $ = load(html);
  const text = strippedStrings($.root()).join(" ");
  const goals = { over: {}, under: {}, btts: {} };

  // 1) s procentem: „Over 2.5 … 57 %“
  const ou = /\b(over|under)\s*(\d(?:[.,]\d)?)\b/gi;
  const lines = new Map(); // linie → { over: [pozice], under: [pozice] }
  for (let m = ou.exec(text); m; m = ou.exec(text)) {
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

  const label = /both teams to score|\bbtts\b/i.exec(text);
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

const MORE_RE = /^(show|load|view|see|display)\s+(more|all)\b|^more\s+(matches|games|predictions|results|events)\b/i;
const MORE_LOOSE = /\b(more|load|show|next|další|více|předchoz)/i;
const describe = ($, el) => `${el.tagName}${$(el).attr("id") ? `#${$(el).attr("id")}` : ""}${$(el).attr("class") ? `.${String($(el).attr("class")).trim().split(/\s+/).join(".")}` : ""}`;

/** Má stránka tlačítko „Show more“ (seznam se po jeho kliknutí prodlužuje)? */
function hasMoreControl(html) {
  const $ = load(html);
  return $("a, button, span, div, p, li, td, input").toArray().some((el) => {
    const t = el.tagName === "input" ? ($(el).attr("value") || "") : collapse($(el).text());
    return t.length <= 40 && MORE_RE.test(t);
  });
}

/** Přehled struktury stránky se seznamem zápasů (značky lig, tlačítka „více“, odkazy na jiné dny/ligy, nejčastější třídy). */
function listDiagnostics(html, { brief = false } = {}) {
  const $ = load(html);
  const count = (sel) => $(sel).length;
  const classes = new Map();
  $("[class]").each((_, el) => { for (const c of String($(el).attr("class")).split(/\s+/)) if (c) classes.set(c, (classes.get(c) || 0) + 1); });
  const top = [...classes].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([c, n]) => `${c}:${n}`).join(" ");
  const body = strippedStrings($.root()).join(" ");

  const tags = new Map();
  $(".shortTag").each((_, el) => { const t = text($(el)); if (t) tags.set(t, (tags.get(t) || 0) + 1); });
  const more = new Set();
  $("a, button, span, div, p, li, td, input").each((_, el) => {
    const t = el.tagName === "input" ? ($(el).attr("value") || "") : collapse($(el).text());
    if (t && t.length <= 30 && MORE_LOOSE.test(t) && ![...$(el).children()].some((c) => MORE_LOOSE.test(collapse($(c).text())))) more.add(`${describe($, el)} «${t}»`);
  });
  const links = new Set();
  $("a[href]").each((_, el) => {
    const h = String($(el).attr("href"));
    if (/predictions|tips-and-predictions|\d{4}-\d{2}-\d{2}|tomorrow|yesterday|today/i.test(h) && links.size < 40) links.add(h.slice(0, 110));
  });
  const sample = $("div.rcnt").toArray().slice(0, 2).map((el) => collapse($.html(el)).slice(0, 1400));
  const head = [
    `Délka HTML: ${html.length}`, `Zablokováno: ${looksBlocked(200, html)}`,
    `div.rcnt: ${count("div.rcnt")}, .fprc: ${count(".fprc")}, .homeTeam: ${count(".homeTeam")}, .awayTeam: ${count(".awayTeam")}, `
      + `time[datetime]: ${count("time[datetime]")}, .shortTag: ${count(".shortTag")}, a.tnmscn: ${count("a.tnmscn")}`,
    `Značky lig na stránce (${tags.size}): ${[...tags].slice(0, 70).map(([t, n]) => `${t}:${n}`).join(" ")}`,
  ];
  if (brief) return head.join("\n");
  return [
    ...head,
    `Tlačítka „více/další“: ${[...more].slice(0, 15).join(" | ") || "žádná"}`,
    `Odkazy na dny/ligy: ${[...links].slice(0, 30).join(" | ") || "žádné"}`,
    ...sample.map((h, i) => `HTML řádku ${i + 1}: ${h}`),
    `Nejčastější třídy: ${top}`, `Začátek textu: ${body.slice(0, 300)}`,
  ].join("\n");
}

/** Textový přehled jednoho načteného seznamu pro ladicí soubor (první stránka podrobně, další stručně). */
function listReport({ url, html, matches, via, info, error }, detailed) {
  const tracked = matches.filter((m) => m.leagueKey).length;
  const out = [`=== ${url} ===`];
  if (error) out.push(`Chyba: ${error}`);
  out.push(`Načteno přes: ${via || "?"}; zápasů ${matches.length}, ze sledovaných lig ${tracked}`);
  if (info) {
    out.push(info.error ? `Rozbalení „Show more“ selhalo: ${info.error}`
      : `Rozbalení „Show more“: řádků ${info.before} → ${info.after}, ${info.ms} ms, kliknuto na: ${(info.clickLog || []).join(" | ") || "nic (tlačítko nenalezeno)"}`);
  }
  if (html && !looksBlocked(200, html)) out.push(listDiagnostics(html, { brief: !detailed }));
  return out.join("\n");
}

/** Uloží přehledy (vždy) a HTML první stránky, ze které se nepodařilo přečíst žádnou sledovanou ligu. */
function dumpLists(debugDir, lists) {
  if (!debugDir || !lists.length) return;
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    const bad = lists.find((l) => l.html && !looksBlocked(200, l.html) && !l.matches.some((m) => m.leagueKey));
    if (bad) fs.writeFileSync(path.join(debugDir, "forebet-seznam.html"), bad.html.slice(0, 500000));
    const body = lists.map((l, i) => listReport(l, i === 0 || l === bad)).join("\n\n");
    fs.writeFileSync(path.join(debugDir, "forebet-seznam-diagnostika.txt"), `${new Date().toISOString()}\n${body}\n`);
  } catch { /* ladicí soubor je jen bonus */ }
}

const pageReady = (html) => !looksBlocked(200, html) && (html.includes("rcnt") || html.includes("fprc"));

class ForebetScraper {
  constructor(http, browser) {
    this.http = http;
    this.browser = browser;
  }

  /**
   * Jeden seznam zápasů. Obyčejné HTTP vrátí jen první část seznamu, tak se při chybějící sledované lize nebo tlačítku
   * „Show more“ otevře okno prohlížeče, které seznam rozbalí. Vrací { matches, html, via, info }.
   */
  async _list(url, { interactive, progress }) {
    let plain = [];
    let plainHtml = "";
    if (!interactive) {
      try {
        plainHtml = await this.http.getText(url);
        plain = parsePage(plainHtml);
      } catch (err) {
        if (!(err instanceof BlockedError)) throw err;
      }
      if (plain.length && plain.some((m) => m.leagueKey) && !hasMoreControl(plainHtml)) return { url, matches: plain, html: plainHtml, via: "HTTP", info: null };
    }

    progress(interactive ? "Forebet: čekám na dokončení ověření v okně…"
      : plain.length ? "Forebet: načítám celý seznam zápasů…" : "Forebet: zkouším prohlížeč (ochrana Cloudflare)…");
    let info = null;
    let html = "";
    try {
      html = await this.browser.loadHtml(url, {
        ready: pageReady, waitMs: interactive ? 8000 : 15000, interactive, title: "Forebet – dokončete ověření",
        expand: EXPAND_MORE_SCRIPT("div.rcnt", 45000), onExpand: (i) => { info = i; },
      });
    } catch (err) {
      if (!plain.length) throw err;
      return { url, matches: plain, html: plainHtml, via: "HTTP (okno prohlížeče selhalo)", info: { error: err.message } };
    }
    if (looksBlocked(200, html)) {
      if (plain.length) return { url, matches: plain, html: plainHtml, via: "HTTP (okno prohlížeče zablokoval Cloudflare)", info };
      throw new BlockedError("Forebet: Cloudflare kontrola neprošla. Klikněte na „Ověřit Forebet“ – otevře se okno, kde ji dokončíte. "
        + "Tipy ze Scores24 se zobrazují i bez Forebetu.");
    }
    const matches = parsePage(html);
    if (matches.length < plain.length) return { url, matches: plain, html: plainHtml, via: "HTTP (v okně je zápasů méně)", info };
    return { url, matches, html, via: "okno prohlížeče", info };
  }

  /**
   * Zápasy z přehledů „dnes“ a „zítra“ (sloučené bez duplicit). Starý přehled /football-predictions se bere jen tehdy,
   * když z nich nic nevyšlo. @param {object} [opts] { interactive: zobrazit okno, když kontrola nepřejde sama; debugDir: složka pro ladicí soubory }
   */
  async fetch(progress = () => {}, { interactive = false, debugDir = null } = {}) {
    progress("Forebet: stahuji pravděpodobnosti…");
    const urls = [...config.FOREBET_LIST_URLS, config.FOREBET_URL];
    const merged = [];
    const seen = new Set();
    const lists = [];
    let firstError = null;
    for (const [i, url] of urls.entries()) {
      if (i === urls.length - 1 && merged.length) break; // záložní starý přehled jen když nic jiného nevyšlo
      progress(`Forebet: ${i === 0 ? "dnešní" : i === 1 ? "zítřejší" : "všeobecný"} přehled…`);
      try {
        const list = await this._list(url, { interactive: interactive && i === 0, progress });
        lists.push(list);
        for (const m of list.matches) {
          const key = m.url || `${m.home}|${m.away}|${m.kickoff ? m.kickoff.getTime() : ""}`;
          if (!seen.has(key)) { seen.add(key); merged.push(m); }
        }
      } catch (err) {
        if (err instanceof BlockedError && !merged.length) { dumpLists(debugDir, lists); throw err; } // zbylé stránky by dopadly stejně
        firstError ??= err;
        lists.push({ url, html: "", matches: [], via: "", error: err.message || String(err) });
      }
    }
    dumpLists(debugDir, lists);
    if (!merged.length) {
      throw firstError || new SourceError("Forebet: na stránce nejsou rozpoznatelné zápasy (změnila se struktura webu?).");
    }
    return merged;
  }

  /**
   * Doplní `goals` k zápasům ze seznamu načtením jejich stránek (max. `limit`).
   * Vrací { wanted, parsed, errors } – chyby jednotlivých stránek nic neshodí.
   */
  async fetchGoals(matches, progress = () => {}, { limit = 25, debugDir = null } = {}) {
    const todo = [...new Set(matches.filter((m) => m && m.url))].slice(0, limit);
    const summary = { wanted: todo.length, parsed: 0, errors: [] };
    let useBrowser = false;
    let dumped = false;
    for (const [i, m] of todo.entries()) {
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
        if (m.goals) summary.parsed += 1;
        else if (debugDir && !dumped) {
          dumped = true;
          try {
            fs.mkdirSync(debugDir, { recursive: true });
            fs.writeFileSync(path.join(debugDir, "forebet-zapas.html"), html);
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

module.exports = { ForebetScraper, parsePage, parseGoals, pageReady, listDiagnostics, hasMoreControl };
