// Statistiky zápasů ze SofaScore pro tikety: forma obou týmů (posledních 5 zápasů), vzájemné zápasy (H2H), střelecká
// produktivita, domácí/venkovní výkonnost a zranění. Je to veřejný JSON webu SofaScore (stejně jako sofascore.js a live.js);
// oficiální popis neexistuje, proto je každá část nepovinná: co se nenačte nebo nejde přečíst, se jen označí jako nedostupné.
// Podrobnosti jdou do ladicího souboru `ladeni/tikety-statistiky.txt`.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("./config");
const { BlockedError, SourceError } = require("./http");
const { localDate } = require("./timeutil");

const API = config.SOFASCORE_API;
const HEADERS = { Accept: "application/json", Referer: `${config.SOFASCORE_WEB}/` };
const BLOCK_LIMIT = 3;       // tolik zamítnutí po sobě = SofaScore nás blokuje, další dotazy nemá smysl posílat
const POSITION = { G: "brankář", D: "obránce", M: "záložník", F: "útočník" };

const round1 = (x) => Math.round(x * 10) / 10;
const avg = (list, f) => round1(list.reduce((s, x) => s + f(x), 0) / list.length);
const czDay = (ts) => { const [y, m, d] = localDate(new Date(ts * 1000)).split("-").map(Number); return `${d}. ${m}. ${y}`; };
const score = (s) => (s && (s.normaltime !== undefined ? s.normaltime : s.current)); // sázky se vyhodnocují po 90 minutách

/** Odehrané zápasy z odpovědi { events: [...] }, nejnovější první. */
function finishedEvents(data) {
  const out = [];
  for (const e of (data && data.events) || []) {
    try {
      if (e.status && e.status.type && e.status.type !== "finished") continue; // rozehrané, neodehrané a zrušené ne
      const hs = score(e.homeScore);
      const as = score(e.awayScore);
      if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
      out.push({ id: e.id, ts: Number(e.startTimestamp) || 0, homeId: e.homeTeam.id, awayId: e.awayTeam.id, home: e.homeTeam.name, away: e.awayTeam.name, hs, as });
    } catch {
      /* nečitelnou událost přeskočíme */
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** Zápas z pohledu jednoho týmu (V/R/P, vstřelené a obdržené góly); null, když tým v zápase nehrál. */
function viewOf(ev, teamId) {
  const home = ev.homeId === teamId;
  if (!home && ev.awayId !== teamId) return null;
  const gf = home ? ev.hs : ev.as;
  const ga = home ? ev.as : ev.hs;
  return { home, gf, ga, res: gf > ga ? "V" : gf < ga ? "P" : "R", opp: home ? ev.away : ev.home };
}

const record = (views) => (views.length ? {
  zapasu: views.length, V: views.filter((v) => v.res === "V").length, R: views.filter((v) => v.res === "R").length, P: views.filter((v) => v.res === "P").length,
  dal: avg(views, (v) => v.gf), obdrzel: avg(views, (v) => v.ga),
} : null);

/** Počty zápasů s více / méně než 1,5, 2,5 a 3,5 gólu a s gólem obou týmů z posledních `n` zápasů (podklad pro koláče v detailu tipu). */
function goalLines(views, n = 11) {
  const last = views.slice(0, n);
  if (!last.length) return null;
  const over = (line) => last.filter((v) => v.gf + v.ga > line).length;
  return { zapasu: last.length, over15: over(1.5), over25: over(2.5), over35: over(3.5), btts: last.filter((v) => v.gf > 0 && v.ga > 0).length };
}

/** Počty zápasů → podíly v % (zaokrouhlené), jak je ukazují koláče v detailu tipu. */
const shares = (serie) => {
  const pct = (n) => Math.round((100 * n) / serie.zapasu);
  return { over15: pct(serie.over15), over25: pct(serie.over25), over35: pct(serie.over35), btts: pct(serie.btts) };
};

/** Koláče z Forebetu (`recent` ze stránky zápasu, v %) mají přednost před těmi, které se spočítaly ze SofaScore. */
function chartsWithForebet(charts, recent) {
  return recent && recent.a && recent.b ? { zdroj: "Forebet", n: null, home: recent.a, away: recent.b } : charts;
}

/** Forma týmu z jeho posledních zápasů (odpověď `team/<id>/events/last/0`); null, když nejsou žádné odehrané. */
function teamForm(data, teamId) {
  const views = finishedEvents(data).map((e) => viewOf(e, teamId)).filter(Boolean);
  if (!views.length) return null;
  const last5 = views.slice(0, 5);
  const last10 = views.slice(0, 10);
  return {
    forma: last5.map((v) => v.res).join(" "),
    posledni: last5.map((v) => `${v.res} ${v.gf}:${v.ga} ${v.home ? "doma" : "venku"} s ${v.opp}`),
    goly: { zapasu: last10.length, dal: avg(last10, (v) => v.gf), obdrzel: avg(last10, (v) => v.ga) },
    doma: record(views.filter((v) => v.home).slice(0, 5)),
    venku: record(views.filter((v) => !v.home).slice(0, 5)),
    serie: goalLines(views),
  };
}

/** Vzájemné zápasy z odpovědi `event/<customId>/h2h/events`; počty z pohledu domácího týmu právě hraného zápasu. */
function h2hFromEvents(data, homeId, awayId) {
  if (!data || !Array.isArray(data.events)) return null;
  const evs = finishedEvents(data).filter((e) => [e.homeId, e.awayId].includes(homeId) && [e.homeId, e.awayId].includes(awayId)).slice(0, 5);
  if (!evs.length) return { zapasu: 0 };
  const views = evs.map((e) => viewOf(e, homeId));
  return {
    zapasu: evs.length, domaci_vyhry: views.filter((v) => v.res === "V").length, remizy: views.filter((v) => v.res === "R").length,
    hoste_vyhry: views.filter((v) => v.res === "P").length, goly_na_zapas: avg(evs, (e) => e.hs + e.as),
    oba_skorovaly: evs.filter((e) => e.hs > 0 && e.as > 0).length,
    posledni: evs.map((e) => `${czDay(e.ts)} ${e.home} ${e.hs}:${e.as} ${e.away}`),
  };
}

/** Záložní zdroj vzájemných zápasů: jen počty výher (odpověď `event/<id>/h2h`). */
function h2hFromDuel(data) {
  const d = data && data.teamDuel;
  if (!d || !Number.isFinite(d.homeWins) || !Number.isFinite(d.awayWins) || !Number.isFinite(d.draws)) return null;
  return { zapasu: d.homeWins + d.awayWins + d.draws, domaci_vyhry: d.homeWins, remizy: d.draws, hoste_vyhry: d.awayWins };
}

/** Chybějící hráči z odpovědi `event/<id>/lineups` (i když sestavy ještě nejsou potvrzené); null, když data nejsou. */
function missingFrom(data) {
  if (!data || (!data.home && !data.away)) return null;
  const side = (s) => ((s && s.missingPlayers) || []).slice(0, 8).map((m) => {
    const p = m.player || {};
    const pos = POSITION[p.position] || p.position || "";
    return `${p.shortName || p.name || "?"}${pos ? ` (${pos})` : ""} – ${m.type === "doubtful" ? "pochybný" : "chybí"}`;
  });
  return { domaci: side(data.home), hoste: side(data.away) };
}

const ROLE_MATCHES = 3;    // z kolika posledních zápasů týmu se zjišťuje, jestli chybějící hráč patřil do základu

/**
 * Role chybějícího hráče z odpovědí `event/<id>/lineups` posledních zápasů týmu (`recent` = [{ ev, data }]): v kolika z nich byl v základní
 * sestavě a jaké měl průměrné hodnocení. null, když nemáme žádnou sestavu.
 */
function playerRole(playerId, teamId, recent) {
  if (!recent.length) return null;
  let started = 0;
  const ratings = [];
  for (const { ev, data } of recent) {
    const side = ev.homeId === teamId ? data.home : data.away;
    const entry = ((side && side.players) || []).find((x) => x && x.player && x.player.id === playerId);
    if (!entry) continue;
    if (entry.substitute === false) started += 1;
    const r = Number(entry.statistics && entry.statistics.rating);
    if (Number.isFinite(r) && r > 0) ratings.push(r);
  }
  return { zapasu: recent.length, v_zakladu: started, hodnoceni: ratings.length ? round1(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null };
}

/** „základní hráč“ (v základu aspoň ve 2/3 zápasů), „občas hraje“, nebo „nehrává v základu“. */
const roleLabel = (r) => (r.v_zakladu * 3 >= r.zapasu * 2 ? "základní hráč" : r.v_zakladu > 0 ? "občas hraje" : "nehrává v základu");

/**
 * Stručný souhrn absencí týmu ze seznamu z `missingFrom`: počet chybějících a pochybných a zda mezi chybějícími je brankář nebo útočník.
 * `roles` (volitelně) = [{ jmeno, pozice, typ, role }] z `playerRole`: doplní, kdo z absentujících je základní hráč.
 */
function absenceSummary(list, rolesIn) {
  if (!list || !list.length) return "žádné známé absence";
  const roles = rolesIn || [];
  const out = list.filter((x) => x.endsWith("– chybí"));
  const key = ["brankář", "útočník"].filter((p) => out.some((x) => x.includes(`(${p})`)));
  const regulars = roles.filter((r) => r.role && roleLabel(r.role) === "základní hráč");
  const detail = regulars.length
    ? `; základní hráči mezi absentujícími: ${regulars.map((r) => `${r.jmeno}${r.pozice ? ` (${r.pozice})` : ""}, ${r.typ}, v základu ${r.role.v_zakladu}/${r.role.zapasu}${r.role.hodnoceni ? `, hodnocení ${r.role.hodnoceni}` : ""}`).join("; ")}`
    : (roles.length && roles.every((r) => r.role) ? "; žádný z nich není základní hráč" : "");
  return `chybí ${out.length}${key.length ? ` (mezi nimi ${key.join(", ")})` : ""}, pochybných ${list.length - out.length}${detail}`;
}

/** Dny od posledního odehraného zápasu týmu (únava, nasazení v poháru); null, když zápas neznáme. */
function restDays(data, now) {
  const last = finishedEvents(data)[0];
  return last && last.ts ? Math.max(0, Math.floor((now - last.ts * 1000) / 86400e3)) : null;
}

/** Složí statistiky zápasu pro AI (české klíče); `complete` = známe formu obou týmů, bez ní se zápas neposuzuje. */
function buildStats({ homeLast, awayLast, homeId, awayId, h2h, missing, roles = null, now = Date.now() }) {
  const home = teamForm(homeLast, homeId);
  const away = teamForm(awayLast, awayId);
  const stats = {};
  const rest = (data) => { const d = restDays(data, now); return d === null ? {} : { dnu_od_posledniho_zapasu: d }; };
  if (home) stats.forma_domaci = { posledni_zapasy: home.posledni, forma: home.forma, goly_na_zapas: home.goly, doma: home.doma, ...rest(homeLast) };
  if (away) stats.forma_hoste = { posledni_zapasy: away.posledni, forma: away.forma, goly_na_zapas: away.goly, venku: away.venku, ...rest(awayLast) };
  if (h2h) stats.h2h = h2h;
  if (missing) {
    stats.zraneni = missing;
    stats.dostupnost = { domaci: absenceSummary(missing.domaci, roles && roles.domaci), hoste: absenceSummary(missing.hoste, roles && roles.hoste) };
  }
  return { stats, complete: Boolean(home && away), charts: home && away && home.serie && away.serie ? { zdroj: "SofaScore", n: Math.max(home.serie.zapasu, away.serie.zapasu), home: shares(home.serie), away: shares(away.serie) } : null };
}

class MatchStats {
  /**
   * @param {object} http  HttpClient (getJson)
   * @param {object} opts  debugDir = složka pro ladicí soubor, delayMs = pauza mezi dotazy, concurrency = souběžné zápasy
   */
  constructor(http, { debugDir = null, delayMs = [250, 600], concurrency = 2, cache = null, cacheMs = 30 * 60 * 1000, now = () => Date.now() } = {}) {
    this.http = http;
    this.cache = cache;     // Map id zápasu → { at, result }: opakované vytvoření tiketů do `cacheMs` nic nestahuje
    this.cacheMs = cacheMs;
    this.now = now;
    this.debugDir = debugDir;
    this.delayMs = delayMs;
    this.concurrency = concurrency;
    this.blockedStreak = 0;
    this.blocked = false;
  }

  /** Jeden dotaz; chyba zdroje nic neshodí, jen se zapíše do `notes` (null = data nejsou). */
  async get(kind, url, notes) {
    if (this.blocked) { notes[kind] = "přeskočeno (blokace)"; return null; }
    try {
      const data = await this.http.getJson(url, { headers: HEADERS, delayMs: this.delayMs });
      this.blockedStreak = 0;
      notes[kind] = "ok";
      return data;
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      if (err instanceof BlockedError) {
        this.blockedStreak += 1;
        if (this.blockedStreak >= BLOCK_LIMIT) this.blocked = true;
      } else if (err.status) {
        this.blockedStreak = 0;
      }
      notes[kind] = err.status === 404 ? "404" : err.message;
      return null;
    }
  }

  /** Poslední zápasy týmu; když seznam chybí nebo nejde přečíst, zkusí se záložní přehled výkonnosti týmu. */
  async lastEvents(side, teamId, notes) {
    const data = await this.get(`posledni_${side}`, `${API}/team/${teamId}/events/last/0`, notes);
    if (teamForm(data, teamId)) return data;
    return (await this.get(`vykonnost_${side}`, `${API}/team/${teamId}/performance`, notes)) || data;
  }

  /**
   * Role chybějících hráčů jednoho týmu: z posledních zápasů týmu se stáhnou sestavy (jen když někdo chybí a má id) a zjistí se,
   * kolikrát v nich hráč nastoupil v základu. Vrací [{ jmeno, pozice, typ, role }]; chybějící sestavy nic neshodí (role = null).
   */
  async roles(sideData, teamId, last, label, notes) {
    const players = ((sideData && sideData.missingPlayers) || []).filter((m) => m && m.player && m.player.id).slice(0, 8);
    if (!players.length) return [];
    const recent = [];
    for (const [i, ev] of finishedEvents(last).filter((x) => x.id).slice(0, ROLE_MATCHES).entries()) {
      const data = await this.get(`sestavy_${label}_${i + 1}`, `${API}/event/${ev.id}/lineups`, notes);
      if (data && (data.home || data.away)) recent.push({ ev, data });
    }
    return players.map((m) => ({
      jmeno: m.player.shortName || m.player.name || "?", pozice: POSITION[m.player.position] || m.player.position || "",
      typ: m.type === "doubtful" ? "pochybný" : "chybí", role: playerRole(m.player.id, teamId, recent),
    }));
  }

  /** Statistiky jednoho zápasu podle jeho SofaScore ID. */
  async statsFor(id) {
    const notes = {};
    const data = await this.get("event", `${API}/event/${id}`, notes);
    const e = data && data.event;
    const homeId = e && e.homeTeam && e.homeTeam.id;
    const awayId = e && e.awayTeam && e.awayTeam.id;
    if (!homeId || !awayId) return { stats: {}, complete: false, notes };
    const homeLast = await this.lastEvents("domaci", homeId, notes);
    const awayLast = await this.lastEvents("hoste", awayId, notes);
    let h2h = e.customId ? h2hFromEvents(await this.get("h2h", `${API}/event/${e.customId}/h2h/events`, notes), homeId, awayId) : null;
    if (!h2h) h2h = h2hFromDuel(await this.get("h2h_pocty", `${API}/event/${id}/h2h`, notes));
    if (!h2h) { // naposledy: setkání obou týmů mezi posledními zápasy domácího týmu (bez dalšího dotazu)
      const recent = h2hFromEvents(homeLast, homeId, awayId);
      if (recent && recent.zapasu) h2h = { ...recent, poznamka: "jen setkání z posledních zápasů domácího týmu" };
    }
    const lineups = await this.get("sestavy", `${API}/event/${id}/lineups`, notes);
    const missing = missingFrom(lineups);
    const roles = missing ? { domaci: await this.roles(lineups.home, homeId, homeLast, "domaci", notes), hoste: await this.roles(lineups.away, awayId, awayLast, "hoste", notes) } : null;
    return { ...buildStats({ homeLast, awayLast, homeId, awayId, h2h, missing, roles }), notes };
  }

  /** Statistiky jednoho zápasu pro detail tipu (s mezipamětí jako u tiketů); vrací { stats, complete, notes }. */
  async detail(id) {
    const hit = this.cache && this.cache.get(id);
    if (hit && this.now() - hit.at < this.cacheMs) return hit.result;
    const r = await this.statsFor(id);
    if (this.cache && r.complete) this.cache.set(id, { at: this.now(), result: r });
    return r;
  }

  /**
   * Statistiky všech kandidátů (kandidát = tip s `sofascoreId` a `ticketId`). Zápas se dvěma tipy se stahuje jednou.
   * Vrací { stats: { ticketId: statistiky }, covered, total, noId, blocked }; jen zápasy s formou obou týmů.
   */
  async collect(candidates, progress = () => {}) {
    const ids = [...new Set(candidates.map((c) => c.sofascoreId).filter(Boolean))];
    const results = new Map();
    const queue = [];
    for (const id of ids) {
      const hit = this.cache && this.cache.get(id);
      if (hit && this.now() - hit.at < this.cacheMs) results.set(id, { ...hit.result, notes: { ...hit.result.notes, mezipamet: "z mezipaměti" } });
      else queue.push(id);
    }
    progress(`Stahuji statistiky zápasů ze SofaScore (${results.size}/${ids.length})…`);
    const worker = async () => {
      while (queue.length && !this.blocked) {
        const id = queue.shift();
        const r = await this.statsFor(id);
        results.set(id, r);
        if (this.cache && r.complete) this.cache.set(id, { at: this.now(), result: r });
        progress(`Stahuji statistiky zápasů ze SofaScore (${results.size}/${ids.length})…`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, ids.length) }, worker));

    const stats = {};
    for (const c of candidates) {
      const r = results.get(c.sofascoreId);
      if (r && r.complete) stats[c.ticketId] = r.stats;
    }
    const out = { stats, covered: Object.keys(stats).length, total: candidates.length, noId: candidates.filter((c) => !c.sofascoreId).length, blocked: this.blocked };
    this.writeDiagnostics(candidates, results, out);
    return out;
  }

  writeDiagnostics(candidates, results, out) {
    if (!this.debugDir) return;
    try {
      const lines = [
        `Statistiky zápasů pro tikety – ${new Date().toISOString()}`,
        `Zápasů: ${out.total}, bez SofaScore ID: ${out.noId}, se statistikami (forma obou týmů): ${out.covered}`,
        ...(out.blocked ? ["SofaScore zamítá dotazy (ochrana proti robotům) – další dotazy se neposílaly."] : []), "",
      ];
      for (const c of candidates) {
        const r = results.get(c.sofascoreId);
        lines.push(`${c.ticketId} ${c.matchName} | SofaScore ID ${c.sofascoreId || "chybí"} | ${r ? (r.complete ? "OK" : "NEÚPLNÉ") : "-"} ${r ? JSON.stringify(r.notes) : ""}`);
      }
      fs.mkdirSync(this.debugDir, { recursive: true });
      fs.writeFileSync(path.join(this.debugDir, "tikety-statistiky.txt"), `${lines.join("\n")}\n`, "utf8");
    } catch {
      /* ladicí soubor není nutný */
    }
  }
}

module.exports = { MatchStats, finishedEvents, teamForm, h2hFromEvents, h2hFromDuel, missingFrom, buildStats, chartsWithForebet, playerRole };
