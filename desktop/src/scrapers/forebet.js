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
const { load, collapse } = require("../dom");

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

function leagueText($, row) {
  // Zkratka/název ligy z nejbližší hlavičky nad řádkem (nejistá část – Forebet značky mění).
  let node = row.prev();
  while (node.length) {
    const tag = node.find(".shortTag").first();
    if (tag.length) return text(tag);
    node = node.prev();
  }
  return "";
}

function leagueKeyOf(tagText) {
  if (!tagText) return null;
  const lg = config.LEAGUES.find((l) => l.enabled && l.forebetTags.includes(tagText.trim()));
  return lg ? lg.key : null;
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
  return {
    home, away, kickoff: kickoff($, row), p1, px, p2, pick, odds, leagueKey: leagueKeyOf(lt), leagueText: lt,
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

const pageReady = (html) => !looksBlocked(200, html) && (html.includes("rcnt") || html.includes("fprc"));

class ForebetScraper {
  constructor(http, browser) {
    this.http = http;
    this.browser = browser;
  }

  /** @param {object} [opts] { interactive: zobrazit okno, když kontrola nepřejde sama } */
  async fetch(progress = () => {}, { interactive = false } = {}) {
    progress("Forebet: stahuji pravděpodobnosti…");
    let matches = [];
    if (!interactive) {
      try {
        matches = parsePage(await this.http.getText(config.FOREBET_URL));
      } catch (err) {
        if (!(err instanceof BlockedError)) throw err;
      }
      if (matches.length) return matches;
    }

    progress(interactive ? "Forebet: čekám na dokončení ověření v okně…" : "Forebet: zkouším prohlížeč (ochrana Cloudflare)…");
    const html = await this.browser.loadHtml(config.FOREBET_URL, {
      ready: pageReady, waitMs: interactive ? 8000 : 15000, interactive, title: "Forebet – dokončete ověření",
    });
    if (looksBlocked(200, html)) {
      throw new BlockedError("Forebet: Cloudflare kontrola neprošla. Klikněte na „Ověřit Forebet“ – otevře se okno, kde ji dokončíte. "
        + "Tipy ze Scores24 se zobrazují i bez Forebetu.");
    }
    matches = parsePage(html);
    if (!matches.length) throw new SourceError("Forebet: na stránce nejsou rozpoznatelné zápasy (změnila se struktura webu?).");
    return matches;
  }
}

module.exports = { ForebetScraper, parsePage, pageReady };
