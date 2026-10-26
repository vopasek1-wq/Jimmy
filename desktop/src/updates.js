// Kontrola nové verze: GitHub vydání „tipy-latest“ (jediné vydání s aktuálním FotbalTipy.exe, každé sestavení ho nahradí).
// Číslo sestavení je poslední část verze aplikace (1.0.37 → 37) a stejné číslo je v názvu vydání („… – sestavení 37“),
// takže stačí porovnat dvě čísla. Zjišťuje se jedním dotazem na GitHub API; aplikace se sama nepřepisuje – jen nabídne stažení.
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
 * Zjistí poslední sestavení. Vrací { current, latest, url, published, available }, nebo { error, current } s důvodem,
 * proč se to nepodařilo (stav HTTP, nebo chyba spojení) – nikdy nevyhazuje výjimku.
 */
async function checkForUpdate({ fetchFn, version, timeoutMs = 15000 }) {
  const current = buildOf(version);
  const fail = (reason) => ({ error: `Kontrola nové verze se nepodařila (${reason}).`, current });
  try {
    const resp = await request(fetchFn, config.RELEASE_API, { Accept: "application/vnd.github+json" }, timeoutMs);
    if (!resp.ok) return fail(httpReason(resp.status));
    const latest = parseRelease(await resp.json());
    if (!latest) return fail("v odpovědi GitHubu není číslo sestavení");
    return { current, latest: latest.build, url: latest.url, published: latest.published, available: latest.build > current };
  } catch (err) {
    return fail(netReason(err));
  }
}

module.exports = { buildOf, parseRelease, checkForUpdate };
