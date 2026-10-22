// Centrální konfigurace: prahy filtrů (ze zadání), seznam sledovaných lig a adresy zdrojů.
"use strict";

const MIN_PROBABILITY = 60.0; // tip musí mít pravděpodobnost STRIKTNĚ větší než 60 %
const MIN_ODDS = 1.5; //          a kurz alespoň 1,50
const HIGH_PROBABILITY = 75.0; //  nad touto hranicí je řádek zelený, jinak žlutý
// Když zdroj kurz neuvádí, odhadne se z pravděpodobnosti (férový kurz 100/p zmenšený o marži).
const ESTIMATED_MARGIN = 0.06;

const DISPLAY_TZ = "Europe/Prague";

const SCORES24_BASE = "https://scores24.live";
const SCORES24_URL = `${SCORES24_BASE}/en/predictions/soccer`;
const FOREBET_URL = "https://www.forebet.com/en/football-predictions";
const SOFASCORE_API = "https://www.sofascore.com/api/v1";
const SOFASCORE_WEB = "https://www.sofascore.com";
// Průběžné vydání s hotovou aplikací (vytváří ho workflow .github/workflows/tipy-windows.yml): kontrola nové verze a stažení.
const RELEASE_API = "https://api.github.com/repos/vopasek1-wq/Jimmy/releases/tags/tipy-latest";
const DOWNLOAD_URL = "https://github.com/vopasek1-wq/Jimmy/releases/download/tipy-latest/FotbalTipy.exe";
const RELEASE_PAGE = "https://github.com/vopasek1-wq/Jimmy/releases/tag/tipy-latest"; // stránka vydání (v prohlížeči přihlášeném na GitHub funguje i u soukromého repozitáře)
const RELEASE_FEED = "https://github.com/vopasek1-wq/Jimmy/releases.atom"; // záloha, když GitHub API nejde (limit dotazů, blokace)

// Obyčejné preferenční cookie webu Scores24 (jako by si je uživatel nastavil v nastavení):
// desetinné kurzy místo amerických a pražské časové pásmo.
const SCORES24_COOKIES = { userOddFormat: "EU", userTimezone: "Europe/Prague" };

const REQUEST_TIMEOUT_MS = 25000;
const REQUEST_DELAY_MS = [800, 1600]; // pauza mezi požadavky na stejný server
const REQUEST_RETRIES = 2;

const EUROPE = /^(Europe|International|UEFA|World)?$/i;

// Rozpoznání probíhá podle slugu odkazu na Scores24 (nejstabilnější), případně podle
// dvojice (země, název ligy) z hlavičky bloku. Ligu vypnete `enabled: false`.
const LEAGUES = [
  { key: "EPL", nameCs: "Anglie – Premier League", short: "Premier League", sofascoreId: 17,
    slugRe: /^england-premier-league$/i, countryRe: /^England$/i, nameRe: /^Premier League$/i, forebetTags: ["Eng1"] },
  { key: "LALIGA", nameCs: "Španělsko – La Liga", short: "La Liga", sofascoreId: 8,
    slugRe: /^spain-laliga$/i, countryRe: /^Spain$/i, nameRe: /^La ?Liga$/i, forebetTags: ["Spa1"] },
  { key: "SERIEA", nameCs: "Itálie – Serie A", short: "Serie A", sofascoreId: 23,
    slugRe: /^italy-serie-a$/i, countryRe: /^Italy$/i, nameRe: /^Serie A$/i, forebetTags: ["Ita1"] },
  { key: "BUNDESLIGA", nameCs: "Německo – Bundesliga", short: "Bundesliga", sofascoreId: 35,
    slugRe: /^germany-bundesliga$/i, countryRe: /^Germany$/i, nameRe: /^Bundesliga$/i, forebetTags: ["Ger1"] },
  { key: "LIGUE1", nameCs: "Francie – Ligue 1", short: "Ligue 1", sofascoreId: 34,
    slugRe: /^france-ligue-1-?$/i, countryRe: /^France$/i, nameRe: /^Ligue 1$/i, forebetTags: ["Fra1"] },
  { key: "UCL", nameCs: "Liga mistrů UEFA", short: "Liga mistrů", sofascoreId: 7,
    slugRe: /uefa-champions-league/i, countryRe: EUROPE, nameRe: /^(UEFA )?Champions League$/i, forebetTags: ["UCL", "CL"] },
  { key: "UEL", nameCs: "Evropská liga UEFA", short: "Evropská liga", sofascoreId: 679,
    slugRe: /uefa-europa-league/i, countryRe: EUROPE, nameRe: /^(UEFA )?Europa League$/i, forebetTags: ["UEL", "EL"] },
  { key: "UECL", nameCs: "Konferenční liga UEFA", short: "Konferenční liga", sofascoreId: 17015,
    slugRe: /uefa-(europa-)?conference-league/i, countryRe: EUROPE, nameRe: /^(UEFA )?(Europa )?Conference League$/i,
    forebetTags: ["UECL", "UEC", "ECL"] },
  { key: "EREDIVISIE", nameCs: "Nizozemsko – Eredivisie", short: "Eredivisie", sofascoreId: 37,
    slugRe: /^netherlands-eredivisie$/i, countryRe: /^Netherlands$/i, nameRe: /^Eredivisie$/i, forebetTags: ["Ned1"] },
  { key: "PORTUGAL", nameCs: "Portugalsko – Liga Portugal", short: "Liga Portugal", sofascoreId: 238,
    slugRe: /^portugal-primeira-liga$/i, countryRe: /^Portugal$/i, nameRe: /^(Liga Portugal|Primeira Liga)$/i, forebetTags: ["Por1"] },
  { key: "BELGIE", nameCs: "Belgie – Pro League", short: "Pro League", sofascoreId: 38,
    slugRe: /^belgium-(pro-league|jupiler-pro-league|first-division-a)$/i, countryRe: /^Belgium$/i,
    nameRe: /^(Pro League|Jupiler Pro League|First Division A)$/i, forebetTags: ["Bel1"] },
  { key: "TURECKO", nameCs: "Turecko – Süper Lig", short: "Süper Lig", sofascoreId: 52,
    slugRe: /^turkey-super-lig$/i, countryRe: /^Turkey$/i, nameRe: /^Super Lig$/i, forebetTags: ["Tur1"] },
  { key: "SKOTSKO", nameCs: "Skotsko – Premiership", short: "Premiership", sofascoreId: 36,
    slugRe: /^scotland-premiership$/i, countryRe: /^Scotland$/i, nameRe: /^Premiership$/i, forebetTags: ["Sco1"] },
  { key: "CESKO", nameCs: "Česko – 1. liga", short: "1. liga", sofascoreId: 172,
    slugRe: /^czech-republic-1-liga$/i, countryRe: /^Czech/i, nameRe: /^1\.? ?Liga$/i, forebetTags: ["Cze1"] },
].map((lg) => ({ enabled: true, ...lg }));

function leagueMatches(lg, country, name, slug) {
  if (lg.slugRe && lg.slugRe.test(slug)) return true;
  if (lg.nameRe && lg.nameRe.test(String(name).trim())) {
    return lg.countryRe ? lg.countryRe.test(String(country).trim()) : true;
  }
  return false;
}

/** Vrátí sledovanou (zapnutou) ligu, která odpovídá hlavičce bloku, jinak null. */
function findLeague(country, name, slug) {
  return LEAGUES.find((lg) => lg.enabled && leagueMatches(lg, country, name, slug)) || null;
}

function leagueByKey(key) {
  return LEAGUES.find((lg) => lg.key === key) || null;
}

module.exports = {
  MIN_PROBABILITY, MIN_ODDS, HIGH_PROBABILITY, ESTIMATED_MARGIN, DISPLAY_TZ,
  SCORES24_BASE, SCORES24_URL, FOREBET_URL, SOFASCORE_API, SOFASCORE_WEB, RELEASE_API, RELEASE_FEED, RELEASE_PAGE, DOWNLOAD_URL, SCORES24_COOKIES,
  REQUEST_TIMEOUT_MS, REQUEST_DELAY_MS, REQUEST_RETRIES, LEAGUES, findLeague, leagueByKey,
};
