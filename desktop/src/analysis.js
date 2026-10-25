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

// „latest“ aliasy sledují aktuální modely Gemini; při nedostupnosti nebo přetížení se zkusí další (lehčí) model.
const MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"];
const SERVER_ERRORS = new Set([500, 502, 503, 504]);
const MAX_TOKENS_CAP = 32768; // strop limitu odpovědi, když ji model useklo (do limitu se počítá i „přemýšlení“ modelu)
const ATTEMPTS = 2;        // pokusů na model při chybě serveru (přetížení)
const MAX_QUOTA_WAIT = 20; // s: na minutový limit se počká jen krátce, jinak se zkusí další model
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Z chybové odpovědi Google API vytáhne důvod (stav, text, druh limitu, doporučenou pauzu). */
function errorInfo(model, status, error) {
  const err = error || {};
  const details = Array.isArray(err.details) ? err.details : [];
  const failure = details.find((d) => /QuotaFailure/.test((d && d["@type"]) || ""));
  const violation = ((failure && failure.violations) || [])[0] || {};
  const retry = details.find((d) => /RetryInfo/.test((d && d["@type"]) || ""));
  const delay = /^(\d+(?:\.\d+)?)s$/.exec((retry && retry.retryDelay) || "");
  const text = String(err.message || "").replace(/\s+/g, " ").trim();
  return {
    model, status, code: err.status || "", text,
    retrySec: delay ? Number(delay[1]) : null,
    zero: String(violation.quotaValue) === "0" || /limit:\s*0\b/i.test(text),     // model na tomto klíči (účtu zdarma) nemá žádný limit
    daily: /PerDay/i.test(String(violation.quotaId || "")) || /per day|daily/i.test(text),
  };
}

/** Srozumitelné vysvětlení, proč selhaly všechny modely (včetně původního textu od Googlu). */
function failureMessage(failures) {
  const quota = failures.filter((f) => f.status === 429);
  const server = failures.filter((f) => SERVER_ERRORS.has(f.status));
  const main = quota.find((f) => f.zero) || quota.find((f) => f.daily) || quota[0] || server[0] || failures[failures.length - 1];
  let head;
  if (quota.length) {
    head = main.zero ? `Tvůj Gemini klíč nemá pro model ${main.model} žádný dostupný limit (tohle zdarma nejde).`
      : main.daily ? `Vyčerpaný denní limit Gemini API (model ${main.model}); u bezplatného klíče se obnoví po půlnoci pacifického času, u nás ráno.`
        : `Překročený limit Gemini API (model ${main.model}). Zkus to za minutu, u bezplatného klíče platí minutové i denní limity.`;
  } else if (server.length) {
    head = "Gemini je teď přetížené (zkoušel jsem i záložní modely). Zkus to za pár minut.";
  } else {
    head = main ? main.text || "Model Gemini není dostupný." : "Model Gemini není dostupný.";
  }
  const detail = main && main.text && head !== main.text ? ` [Google: HTTP ${main.status}${main.code ? ` ${main.code}` : ""}: ${main.text.slice(0, 220)}]` : "";
  return `${head}${detail}`;
}

/**
 * Dotaz na Google Gemini API (klíč má uživatel uložený v aplikaci); `fetchFn` je net.fetch z Electronu.
 *  - `json`: odpověď jako JSON,
 *  - `temperature: null` nechá výchozí hodnotu modelu (u nových modelů Gemini ji Google doporučuje neměnit).
 * Při chybě zkouší další modely; když selžou všechny, vyhodí chybu se skutečným důvodem (limit, přetížení …).
 * Vrací { text, model }.
 */
async function generate({ fetchFn, apiKey, prompt, system = SYSTEM, json = false, temperature = 0.4, maxTokens, thinkingBudget, timeoutMs = 120000, sleep = wait }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const failures = [];
    let tokens = maxTokens || (json ? 8000 : 4000);
    const noThinking = new Set(); // modely, které omezení „přemýšlení“ odmítly
    for (const model of MODELS) {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const resp = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST", signal: ctl.signal,
          headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: tokens,
              ...(temperature === null ? {} : { temperature }),
              ...(json ? { responseMimeType: "application/json" } : {}),
              ...(thinkingBudget !== undefined && !noThinking.has(model) ? { thinkingConfig: { thinkingBudget } } : {}),
            },
          }),
        });
        const body = await resp.json().catch(() => ({}));
        const err = body.error || {};
        if (resp.status === 400 && /API key not valid|API_KEY_INVALID/i.test(JSON.stringify(err))) throw new Error("API klíč není platný.");
        if (resp.status === 401 || resp.status === 403) throw new Error(`Klíč nemá přístup ke Gemini API (${err.message || `HTTP ${resp.status}`}).`);
        if (resp.status === 400 && thinkingBudget !== undefined && !noThinking.has(model) && /thinking/i.test(JSON.stringify(err))) { // model omezení nezná: bez něj
          noThinking.add(model);
          attempt -= 1;
          continue;
        }
        if (resp.status === 404) { failures.push(errorInfo(model, 404, { ...err, message: err.message || "Model nenalezen." })); break; }
        if (resp.status === 429) {                       // limit: krátká pauza jen když ji Google doporučí, jinak další model
          const info = errorInfo(model, 429, err);
          failures.push(info);
          if (!info.zero && !info.daily && info.retrySec !== null && info.retrySec <= MAX_QUOTA_WAIT && attempt < ATTEMPTS - 1) { await sleep((info.retrySec + 1) * 1000); continue; }
          break;
        }
        if (SERVER_ERRORS.has(resp.status)) {            // přetížení / chyba serveru: chvíli počkat a zkusit znovu, pak jiný model
          failures.push(errorInfo(model, resp.status, err));
          if (attempt < ATTEMPTS - 1) await sleep(1500 * (attempt + 1));
          continue;
        }
        if (!resp.ok) throw new Error(err.message || `Chyba služby (HTTP ${resp.status}).`);
        const cand = (body.candidates || [])[0] || {};
        const parts = (cand.content || {}).parts || [];
        const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("\n").trim();
        if (!text) throw new Error("AI nevrátila žádný text (odpověď mohla být zablokovaná).");
        if (json && cand.finishReason === "MAX_TOKENS") {
          if (tokens < MAX_TOKENS_CAP) { tokens = Math.min(tokens * 2, MAX_TOKENS_CAP); attempt -= 1; continue; }   // useklá odpověď: znovu s dvojnásobným limitem
          throw new Error("Odpověď AI byla příliš dlouhá a useklá – zkus to znovu.");
        }
        return { text, model };
      }
    }
    throw new Error(failureMessage(failures));
  } catch (err) {
    if (err.name === "AbortError") throw new Error("AI neodpověděla včas.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Totéž co `generate`, vrací jen text. */
async function askGemini(options) {
  return (await generate(options)).text;
}

module.exports = { analyze, recentLosses, buildPrompt, askGemini, generate, marketGroup };
