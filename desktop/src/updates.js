// Kontrola nové verze: GitHub vydání „tipy-latest“ (jediné vydání s aktuálním FotbalTipy.exe, každé sestavení ho nahradí).
// Číslo sestavení je poslední část verze aplikace (1.0.37 → 37) a stejné číslo je v názvu vydání („… – sestavení 37“),
// takže stačí porovnat dvě čísla. Zjišťuje se přes GitHub API, a když to nejde (limit dotazů, blokace), přes Atom kanál
// vydání na github.com. Aplikace se sama nepřepisuje – jen nabídne stažení.
"use strict";

const config = require("./config");

/** Číslo sestavení z verze aplikace (1.0.37 → 37); vývojová verze 1.0.0 → 0. */
function buildOf(version) {
  const m = /^\d+\.\d+\.(\d+)/.exec(String(version || ""));
  return m ? Number(m[1]) : 0;
}

/** Z vydání GitHubu vytáhne číslo sestavení („sestavení 37“ v názvu, záložně „běh č. 37“ v popisu) a odkaz na stažení. */
function parseRelease(data) {
  if (!data || typeof data !== "object") return null;
  const m = /sestavení\s+(\d+)/i.exec(String(data.name || "")) || /běh č\.\s*(\d+)/i.exec(String(data.body || ""));
  if (!m) return null;
  const asset = (Array.isArray(data.assets) ? data.assets : []).find((a) => a && /\.exe$/i.test(a.name || "") && a.browser_download_url);
  return { build: Number(m[1]), url: (asset && asset.browser_download_url) || config.DOWNLOAD_URL, published: data.published_at || null };
}

const unescapeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");

/** Z Atom kanálu vydání (github.com/…/releases.atom) vezme nejvyšší číslo sestavení z názvů vydání. */
function parseFeed(xml) {
  let best = null;
  for (const m of String(xml || "").matchAll(/<title[^>]*>([^<]*)<\/title>/gi)) {
    const n = /sestavení\s+(\d+)/i.exec(unescapeXml(m[1]));
    if (n && (best === null || Number(n[1]) > best)) best = Number(n[1]);
  }
  return best === null ? null : { build: best, url: config.DOWNLOAD_URL, published: null };
}

/** fetch s časovým limitem. */
async function request(fetchFn, url, headers, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { headers: { "User-Agent": "FotbalTipy", ...headers }, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const httpReason = (status) => (status === 404 ? "HTTP 404 (vydání se právě nahrává, nebo neexistuje)"
  : status === 403 || status === 429 ? `HTTP ${status} (GitHub dočasně odmítá dotazy z tvé sítě)` : `HTTP ${status}`);
const netReason = (err) => (err && err.name === "AbortError" ? "vypršel časový limit" : String((err && err.message) || err).slice(0, 120));

/**
 * Zjistí poslední sestavení. Vrací { current, latest, url, published, available }, nebo { error } s důvodem,
 * proč se to nepodařilo (u obou cest: stav HTTP, nebo chyba spojení) – nikdy nevyhazuje výjimku.
 */
async function checkForUpdate({ fetchFn, version, timeoutMs = 15000 }) {
  const current = buildOf(version);
  const done = (latest) => ({ current, latest: latest.build, url: latest.url, published: latest.published, available: latest.build > current });
  const problems = [];

  try {
    const resp = await request(fetchFn, config.RELEASE_API, { Accept: "application/vnd.github+json" }, timeoutMs);
    if (resp.ok) {
      const latest = parseRelease(await resp.json());
      if (latest) return done(latest);
      problems.push("GitHub API: v odpovědi není číslo sestavení");
    } else {
      problems.push(`GitHub API: ${httpReason(resp.status)}`);
    }
  } catch (err) {
    problems.push(`GitHub API: ${netReason(err)}`);
  }

  try {
    const resp = await request(fetchFn, config.RELEASE_FEED, { Accept: "application/atom+xml" }, timeoutMs);
    if (resp.ok) {
      const latest = parseFeed(await resp.text());
      if (latest) return done(latest);
      problems.push("github.com: v seznamu vydání není sestavení");
    } else {
      problems.push(`github.com: ${httpReason(resp.status)}`);
    }
  } catch (err) {
    problems.push(`github.com: ${netReason(err)}`);
  }
  return { error: `Kontrola nové verze se nepodařila (${problems.join("; ")}).` };
}

module.exports = { buildOf, parseRelease, parseFeed, checkForUpdate };
