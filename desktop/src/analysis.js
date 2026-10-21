// Analýza úspěšnosti tipů: kalibrace pravděpodobnosti (odhad vs. skutečnost), slabá místa a podklad pro AI.
"use strict";

const BANDS = [[60, 70], [70, 80], [80, 90], [90, 101]];
const MIN_BAND = 5;       // pod tímto počtem tipů pásmo nehodnotíme
const GAP_LIMIT = 10;     // rozdíl v p. b., od kterého se upozorňuje

/** Skupina trhů pro přehled (české názvy). */
function marketGroup(code) {
  if (/^[12X]$/.test(code)) return "Výsledek zápasu (1X2)";
  if (/^(1X|X2|12)$/.test(code)) return "Dvojitá šance";
  if (code === "BTTS" || code === "NOBTTS") return "Oba týmy skórují";
  if (/^[OU]\d/.test(code)) return "Góly celkem";
  if (/^[HA][OU]\d/.test(code)) return "Góly jednoho týmu";
  if (/^AH/.test(code)) return "Handicap";
  return "Ostatní trhy";
}

const pct = (x) => Math.round(x * 10) / 10;

/** Souhrn jedné skupiny tipů: počet, průměrná předpokládaná pravděpodobnost, skutečná úspěšnost, rozdíl, ROI. */
function summarize(tips) {
  const n = tips.length;
  if (!n) return { n: 0, wins: 0, predicted: null, actual: null, gap: null, roi: null };
  const wins = tips.filter((t) => t.outcome === "win").length;
  const predicted = tips.reduce((s, t) => s + t.probability, 0) / n;
  const actual = (100 * wins) / n;
  const real = tips.filter((t) => t.odds && !t.oddsEstimated);
  const roi = real.length ? (100 * real.reduce((s, t) => s + (t.outcome === "win" ? t.odds - 1 : -1), 0)) / real.length : null;
  return { n, wins, predicted: pct(predicted), actual: pct(actual), gap: pct(actual - predicted), roi: roi === null ? null : pct(roi) };
}

function groupBy(tips, keyOf) {
  const map = new Map();
  for (const t of tips) {
    const k = keyOf(t);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return map;
}

/** Hlavní funkce: z uložených tipů (jen výhry a prohry) spočítá přehledy a textová zjištění. */
function analyze(allTips) {
  const tips = allTips.filter((t) => (t.outcome === "win" || t.outcome === "loss") && Number.isFinite(t.probability));
  const overall = summarize(tips);

  const bands = BANDS.map(([lo, hi]) => ({ label: hi > 100 ? `${lo}–100 %` : `${lo}–${hi} %`, ...summarize(tips.filter((t) => t.probability >= lo && t.probability < hi)) }));
  const byGroup = (keyOf, minN = 1) => [...groupBy(tips, keyOf)].map(([name, list]) => ({ name, ...summarize(list) })).filter((g) => g.n >= minN).sort((a, b) => b.n - a.n);
  const markets = byGroup((t) => marketGroup(t.tipCode));
  const leagues = byGroup((t) => t.league || t.leagueKey || "?");
  const sources = byGroup((t) => t.probSource || "Scores24");

  const insights = [];
  if (overall.n < 30) insights.push(`Zatím je vyhodnoceno jen ${overall.n} tipů – závěry jsou orientační, smysluplnější budou od několika desítek tipů.`);
  if (overall.n >= 10 && Math.abs(overall.gap) >= 5) {
    insights.push(overall.gap < 0
      ? `Celkově tipy vycházejí hůř, než udává jejich pravděpodobnost: průměrně ${overall.predicted} % předpokládáno, ${overall.actual} % skutečně (${overall.gap} p. b.).`
      : `Celkově tipy vycházejí lépe, než udává jejich pravděpodobnost: ${overall.predicted} % předpokládáno, ${overall.actual} % skutečně (+${overall.gap} p. b.).`);
  }
  for (const b of bands) {
    if (b.n >= MIN_BAND && Math.abs(b.gap) >= GAP_LIMIT) {
      insights.push(b.gap < 0
        ? `Tipy s pravděpodobností ${b.label} vycházejí jen v ${b.actual} % případů (předpoklad ${b.predicted} %, rozdíl ${b.gap} p. b., ${b.n} tipů) – pravděpodobnost je tady nadhodnocená.`
        : `Tipy s pravděpodobností ${b.label} vycházejí v ${b.actual} % případů (předpoklad ${b.predicted} %, +${b.gap} p. b., ${b.n} tipů) – pravděpodobnost je tady spíš podhodnocená.`);
    }
  }
  for (const g of markets) {
    if (g.n >= MIN_BAND && g.gap <= -GAP_LIMIT) insights.push(`Trh „${g.name}“ dlouhodobě zaostává: ${g.actual} % úspěšnost při průměrné pravděpodobnosti ${g.predicted} % (${g.n} tipů).`);
  }
  for (const g of leagues) {
    if (g.n >= MIN_BAND && g.gap <= -GAP_LIMIT) insights.push(`Soutěž „${g.name}“ vychází hůř, než se čeká: ${g.actual} % místo ${g.predicted} % (${g.n} tipů).`);
  }
  const bad = bands.filter((b) => b.n >= MIN_BAND && b.roi !== null && b.roi < -10);
  for (const b of bad) insights.push(`Pásmo ${b.label} je při skutečných kurzech ztrátové (ROI ${b.roi} %, ${b.n} tipů).`);
  if (!insights.length && overall.n >= 30) insights.push("Žádný výrazný rozdíl mezi předpokládanou a skutečnou úspěšností se nenašel.");

  return { overall, bands, markets, leagues, sources, insights, pending: allTips.filter((t) => !t.outcome).length };
}

/** Poslední prohrané tipy (podklad pro hledání opakujících se chyb). */
function recentLosses(allTips, limit = 40) {
  return allTips.filter((t) => t.outcome === "loss").slice(0, limit).map((t) => ({
    zapas: t.matchName, soutez: t.league, tip: t.tipLabel, pravdepodobnost: t.probability, kurz: t.odds, kurzOdhad: t.oddsEstimated,
    skore: t.homeScore !== null && t.awayScore !== null ? `${t.homeScore}:${t.awayScore}` : null,
  }));
}

const SYSTEM = "Jsi analytik sázkových tipů. Odpovídáš česky, stručně a věcně, bez emoji. Nic si nevymýšlíš – opíráš se jen o dodaná data, "
  + "u malých vzorků výslovně upozorni, že závěry jsou nejisté. Nikdy nesliboj zisk a nepodporuj sázení nad možnosti uživatele.";

function buildPrompt(summary, losses) {
  const data = JSON.stringify({ celkem: summary.overall, pasma_pravdepodobnosti: summary.bands, typy_tipu: summary.markets, souteze: summary.leagues, zdroj_pravdepodobnosti: summary.sources, posledni_prohry: losses });
  return `Tady jsou statistiky mých vyhodnocených fotbalových tipů (pravděpodobnost = odhad zdroje, actual = skutečná úspěšnost v %, gap = actual − predicted v procentních bodech, roi v %).\n\n${data}\n\n`
    + "Napiš: 1) hlavní zjištění o kalibraci pravděpodobnosti (kde odhad nesedí se skutečností), 2) opakující se chyby (typy tipů, soutěže, pásma, vzorce v posledních prohrách), "
    + "3) 2–4 konkrétní doporučení, jak s tipy zacházet. Použij krátké odstavce nebo odrážky začínající „- “.";
}

const MODEL = "claude-sonnet-5-5";

/** Dotaz na Claude API (klíč má uživatel uložený v aplikaci); `fetchFn` je net.fetch z Electronu. */
async function askClaude({ fetchFn, apiKey, prompt, timeoutMs = 90000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctl.signal,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.status === 401) throw new Error("API klíč není platný.");
    if (resp.status === 429) throw new Error("Překročený limit požadavků – zkus to za chvíli.");
    if (!resp.ok) throw new Error((body.error && body.error.message) || `Chyba služby (HTTP ${resp.status}).`);
    const text = (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!text) throw new Error("AI nevrátila žádný text.");
    return text;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("AI neodpověděla včas.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { analyze, recentLosses, buildPrompt, askClaude, marketGroup, summarize, MODEL };
