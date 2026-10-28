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
// Forebet: přehled „dnes“ je jen malá část zápasů (a neobsahuje sledované ligy), proto se z jeho nabídky ligových odkazů
// (`/football-tips-and-predictions-for-<země>/<liga>`) načtou přímo stránky sledovaných lig.
const FOREBET_BASE = "https://www.forebet.com/en";
const FOREBET_TODAY_URL = `${FOREBET_BASE}/football-tips-and-predictions-for-today`;
// Evropské soutěže má Forebet na /en/predictions-europe/<soutěž>, ostatní na /en/football-tips-and-predictions-for-<země>/<liga>.
const forebetLeagueUrl = (path) => (/^predictions-/.test(path) ? `${FOREBET_BASE}/${path}` : `${FOREBET_BASE}/football-tips-and-predictions-for-${path}`);
const SOFASCORE_API = "https://www.sofascore.com/api/v1";
const SOFASCORE_WEB = "https://www.sofascore.com";
// Průběžné vydání s hotovou aplikací (vytváří ho workflow .github/workflows/tipy-windows.yml): kontrola nové verze a stažení.
const RELEASE_API = "https://api.github.com/repos/vopasek1-wq/Jimmy/releases/tags/tipy-latest";
const DOWNLOAD_URL = "https://github.com/vopasek1-wq/Jimmy/releases/download/tipy-latest/FotbalTipy.exe";

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
    slugRe: /^england-premier-league$/i, countryRe: /^England$/i, nameRe: /^Premier League$/i, forebetTags: ["Eng1", "En1"], forebetPaths: [/^england\/premier-league$/], forebetGuess: "england/premier-league" },
  { key: "LALIGA", nameCs: "Španělsko – La Liga", short: "La Liga", sofascoreId: 8,
    slugRe: /^spain-laliga$/i, countryRe: /^Spain$/i, nameRe: /^La ?Liga$/i, forebetTags: ["Spa1", "Es1"], forebetPaths: [/^spain\/(la-?liga|primera-division)$/], forebetGuess: "spain/la-liga" },
  { key: "SERIEA", nameCs: "Itálie – Serie A", short: "Serie A", sofascoreId: 23,
    slugRe: /^italy-serie-a$/i, countryRe: /^Italy$/i, nameRe: /^Serie A$/i, forebetTags: ["Ita1", "It1"], forebetPaths: [/^italy\/serie-a$/], forebetGuess: "italy/serie-a" },
  { key: "BUNDESLIGA", nameCs: "Německo – Bundesliga", short: "Bundesliga", sofascoreId: 35,
    slugRe: /^germany-bundesliga$/i, countryRe: /^Germany$/i, nameRe: /^Bundesliga$/i, forebetTags: ["Ger1", "De1"], forebetPaths: [/^germany\/bundesliga$/], forebetGuess: "germany/bundesliga" },
  { key: "LIGUE1", nameCs: "Francie – Ligue 1", short: "Ligue 1", sofascoreId: 34,
    slugRe: /^france-ligue-1-?$/i, countryRe: /^France$/i, nameRe: /^Ligue 1$/i, forebetTags: ["Fra1", "Fr1"], forebetPaths: [/^france\/ligue-?1$/], forebetGuess: "france/ligue1", forebetCountry: "france" },
  { key: "UCL", nameCs: "Liga mistrů UEFA", short: "Liga mistrů", sofascoreId: 7,
    slugRe: /uefa-champions-league$/i, countryRe: EUROPE, nameRe: /^(UEFA )?Champions League$/i, forebetTags: ["UCL", "CL"], forebetPaths: [/(^|\/)(uefa-)?champions-league$/], forebetGuess: "predictions-europe/uefa-champions-league" },
  { key: "UEL", nameCs: "Evropská liga UEFA", short: "Evropská liga", sofascoreId: 679,
    slugRe: /uefa-europa-league$/i, countryRe: EUROPE, nameRe: /^(UEFA )?Europa League$/i, forebetTags: ["UEL", "EL"], forebetPaths: [/(^|\/)(uefa-)?europa-league$/], forebetGuess: "predictions-europe/uefa-europa-league" },
  { key: "UECL", nameCs: "Konferenční liga UEFA", short: "Konferenční liga", sofascoreId: 17015,
    slugRe: /uefa-(europa-)?conference-league$/i, countryRe: EUROPE, nameRe: /^(UEFA )?(Europa )?Conference League$/i,
    forebetTags: ["UECL", "UEC", "ECL"], forebetPaths: [/(^|\/)(uefa-)?(europa-)?conference-league$/], forebetGuess: "predictions-europe/uefa-europa-conference-league" },
  { key: "EREDIVISIE", nameCs: "Nizozemsko – Eredivisie", short: "Eredivisie", sofascoreId: 37,
    slugRe: /^netherlands-eredivisie$/i, countryRe: /^Netherlands$/i, nameRe: /^Eredivisie$/i, forebetTags: ["Ned1", "Nl1"], forebetPaths: [/^netherlands\/eredivisie$/], forebetGuess: "netherlands/eredivisie" },
  { key: "PORTUGAL", nameCs: "Portugalsko – Liga Portugal", short: "Liga Portugal", sofascoreId: 238,
    slugRe: /^portugal-primeira-liga$/i, countryRe: /^Portugal$/i, nameRe: /^(Liga Portugal|Primeira Liga)$/i, forebetTags: ["Por1", "Pt1"], forebetPaths: [/^portugal\/(liga-portugal|primeira-liga)(-betclic)?$/], forebetGuess: "portugal/liga-portugal" },
  { key: "BELGIE", nameCs: "Belgie – Pro League", short: "Pro League", sofascoreId: 38,
    slugRe: /^belgium-(pro-league|jupiler-pro-league|first-division-a)$/i, countryRe: /^Belgium$/i,
    nameRe: /^(Pro League|Jupiler Pro League|First Division A)$/i, forebetTags: ["Bel1", "Be1"], forebetPaths: [/^belgium\/(pro-league|jupiler-pro-league|first-division-a)$/], forebetGuess: ["belgium/jupiler-pro-league", "belgium/pro-league", "belgium/first-division-a"], forebetCountry: "belgium" },
  { key: "TURECKO", nameCs: "Turecko – Süper Lig", short: "Süper Lig", sofascoreId: 52,
    slugRe: /^turkey-super-lig$/i, countryRe: /^Turkey$/i, nameRe: /^Super Lig$/i, forebetTags: ["Tur1", "Tr1"], forebetPaths: [/^turkey\/(super-lig|sueper-lig|super-league)$/], forebetGuess: "turkey/super-lig" },
  { key: "SKOTSKO", nameCs: "Skotsko – Premiership", short: "Premiership", sofascoreId: 36,
    slugRe: /^scotland-premiership$/i, countryRe: /^Scotland$/i, nameRe: /^Premiership$/i, forebetTags: ["Sco1", "Sc1"], forebetPaths: [/^scotland\/premiership$/], forebetGuess: "scotland/premiership" },
  { key: "CESKO", nameCs: "Česko – 1. liga", short: "1. liga", sofascoreId: 172,
    slugRe: /^czech-republic-1-liga$/i, countryRe: /^Czech/i, nameRe: /^1\.? ?Liga$/i, forebetTags: ["Cze1", "Cz1"], forebetPaths: [/^czech-rep\/(chance-liga|1-liga|fortuna-liga)$/], forebetGuess: "czech-rep/chance-liga" },
  // Domácí poháry zemí výše: v levém sloupci jsou pod svou zemí (`group` = klíč hlavní ligy). Adresy na Forebetu se hledají jen v jeho nabídce.
  { key: "FACUP", group: "EPL", nameCs: "Anglie – FA Cup", short: "FA Cup", sofascoreId: 19,
    slugRe: /^england-fa-cup$/i, countryRe: /^England$/i, nameRe: /^FA Cup$/i, forebetTags: [], forebetPaths: [/^england\/fa-cup$/], forebetGuess: "england/fa-cup" },
  { key: "EFLCUP", group: "EPL", nameCs: "Anglie – EFL Cup", short: "EFL Cup", sofascoreId: 21,
    slugRe: /^england-(efl|league)-cup$/i, countryRe: /^England$/i, nameRe: /^(EFL|League|Carabao) Cup$/i, forebetTags: [], forebetPaths: [/^england\/(efl-cup|league-cup|carabao-cup)$/], forebetGuess: "england/efl-cup" },
  { key: "COPADELREY", group: "LALIGA", nameCs: "Španělsko – Copa del Rey", short: "Copa del Rey", sofascoreId: 329,
    slugRe: /^spain-copa-del-rey$/i, countryRe: /^Spain$/i, nameRe: /^Copa del Rey$/i, forebetTags: [], forebetPaths: [/^spain\/copa-del-rey$/], forebetGuess: "spain/copa-del-rey" },
  { key: "COPPAITALIA", group: "SERIEA", nameCs: "Itálie – Coppa Italia", short: "Coppa Italia", sofascoreId: 328,
    slugRe: /^italy-coppa-italia$/i, countryRe: /^Italy$/i, nameRe: /^Coppa Italia$/i, forebetTags: [], forebetPaths: [/^italy\/coppa-italia$/], forebetGuess: "italy/coppa-italia" },
  { key: "DFBPOKAL", group: "BUNDESLIGA", nameCs: "Německo – DFB-Pokal", short: "DFB-Pokal", sofascoreId: 217,
    slugRe: /^germany-dfb-pokal$/i, countryRe: /^Germany$/i, nameRe: /^DFB[ -]Pokal$/i, forebetTags: ["DFB"], forebetPaths: [/^germany\/dfb-pokal$/], forebetGuess: "germany/dfb-pokal" },
  { key: "COUPEFR", group: "LIGUE1", nameCs: "Francie – Coupe de France", short: "Coupe de France", sofascoreId: 335,
    slugRe: /^france-(coupe-de-france|french-cup)$/i, countryRe: /^France$/i, nameRe: /^(Coupe de France|French Cup)$/i, forebetTags: [], forebetPaths: [/^france\/coupe-de-france$/], forebetGuess: "france/coupe-de-france" },
  { key: "KNVB", group: "EREDIVISIE", nameCs: "Nizozemsko – KNVB Beker", short: "KNVB Beker", sofascoreId: 330,
    slugRe: /^netherlands-knvb-(beker|cup)$/i, countryRe: /^Netherlands$/i, nameRe: /^KNVB[ -](beker|cup)$/i, forebetTags: [], forebetPaths: [/^netherlands\/(knvb-beker|knvb-cup)$/] },
  { key: "TACAPT", group: "PORTUGAL", nameCs: "Portugalsko – Taça de Portugal", short: "Taça de Portugal", sofascoreId: 336,
    slugRe: /^portugal-(portugal-cup|taca-de-portugal|cup)$/i, countryRe: /^Portugal$/i, nameRe: /^(Ta[cç]a de Portugal|Portugal Cup|Cup)$/i, forebetTags: [], forebetPaths: [/^portugal\/(taca-de-portugal|portugal-cup)$/] },
  { key: "TACALIGA", group: "PORTUGAL", nameCs: "Portugalsko – Taça da Liga", short: "Taça da Liga", sofascoreId: 327,
    slugRe: /^portugal-league-cup$/i, countryRe: /^Portugal$/i, nameRe: /^(League Cup|Ta[cç]a da Liga)$/i, forebetTags: [], forebetPaths: [/^portugal\/(taca-da-liga|league-cup)$/] },
  { key: "BELCUP", group: "BELGIE", nameCs: "Belgie – Belgický pohár", short: "Belgický pohár", sofascoreId: 326,
    slugRe: /^belgium-(belgian-cup|croky-cup|cup)$/i, countryRe: /^Belgium$/i, nameRe: /^(Belgian Cup|Croky Cup|Cup)$/i, forebetTags: [], forebetPaths: [/^belgium\/(cup|belgian-cup|croky-cup)$/] },
  { key: "TURCUP", group: "TURECKO", nameCs: "Turecko – Türkiye Kupası", short: "Türkiye Kupası", sofascoreId: 96,
    slugRe: /^turkey-(turkiye-kupasi|turkish-cup|cup)$/i, countryRe: /^Turkey$/i, nameRe: /^(Football Cup|Turkish Cup|Turkiye Kupasi|Cup)$/i, forebetTags: ["TrC"], forebetPaths: [/^turkey\/(cup|turkish-cup|turkiye-kupasi)$/] },
  { key: "SCOCUP", group: "SKOTSKO", nameCs: "Skotsko – Scottish Cup", short: "Scottish Cup", sofascoreId: 347,
    slugRe: /^scotland-(scottish-cup|fa-cup|cup)$/i, countryRe: /^Scotland$/i, nameRe: /^(Scottish Cup|FA Cup|Cup)$/i, forebetTags: [], forebetPaths: [/^scotland\/(scottish-cup|fa-cup|cup)$/] },
  { key: "SCOLCUP", group: "SKOTSKO", nameCs: "Skotsko – Scottish League Cup", short: "Scottish League Cup", sofascoreId: 332,
    slugRe: /^scotland-(scottish-)?league-cup$/i, countryRe: /^Scotland$/i, nameRe: /^(Scottish )?League Cup$/i, forebetTags: [], forebetPaths: [/^scotland\/(scottish-league-cup|league-cup)$/] },
  { key: "CZECUP", group: "CESKO", nameCs: "Česko – Pohár", short: "Český pohár", sofascoreId: 282,
    slugRe: /^czech-republic-cup$/i, countryRe: /^Czech/i, nameRe: /^(Cup|Czech Cup|MOL Cup)$/i, forebetTags: ["CzC"], forebetPaths: [/^czech-rep\/(cup|czech-cup|mol-cup)$/] },
].map((lg) => ({ enabled: true, group: lg.key, ...lg }));

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
  SCORES24_BASE, SCORES24_URL, FOREBET_TODAY_URL, forebetLeagueUrl, SOFASCORE_API, SOFASCORE_WEB, RELEASE_API, DOWNLOAD_URL, SCORES24_COOKIES,
  REQUEST_TIMEOUT_MS, REQUEST_DELAY_MS, REQUEST_RETRIES, LEAGUES, findLeague, leagueByKey,
};
