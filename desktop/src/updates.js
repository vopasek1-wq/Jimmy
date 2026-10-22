// Kontrola nové verze: GitHub vydání „tipy-latest“ (jediné vydání s aktuálním FotbalTipy.exe, každé sestavení ho nahradí).
// Číslo sestavení je poslední část verze aplikace (1.0.37 → 37) a stejné číslo je v názvu vydání („… – sestavení 37“),
// takže stačí porovnat dvě čísla. Aplikace se sama nepřepisuje – jen nabídne stažení; při jakékoli chybě se nic neukáže.
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

/**
 * Zeptá se GitHubu na poslední sestavení. Vrací { current, latest, url, published, available } nebo null, když se to
 * nepodařilo (bez internetu, vydání právě vzniká, soukromý repozitář …) – chyba se nikdy nehlásí.
 */
async function checkForUpdate({ fetchFn, version, timeoutMs = 15000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(config.RELEASE_API, { headers: { Accept: "application/vnd.github+json", "User-Agent": "FotbalTipy" }, signal: ctl.signal });
    if (!resp.ok) return null;
    const latest = parseRelease(await resp.json());
    if (!latest) return null;
    const current = buildOf(version);
    return { current, latest: latest.build, url: latest.url, published: latest.published, available: latest.build > current };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { buildOf, parseRelease, checkForUpdate };
