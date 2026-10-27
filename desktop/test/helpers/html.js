// Sestavení ukázkových stránek ve stejné struktuře, jakou má živý web (třídy záměrně jiné než na webu –
// parser se na ně nesmí spoléhat).
"use strict";

function s24Row({ home, away, time = "15:30", status = "today", pick = "Arsenal to Win", percent = "86", odds = "1.71",
  score = ["-", "-"], slug = "a-b", pctSign = true, icon = "finger-up" }) {
  const pct = percent === null ? "" : `<div class="x1"><svg><use xlink:href="#${icon}"></use></svg><span>${percent}${pctSign ? "<!-- -->%" : ""}</span></div>`;
  return `
<a class="link r1" href="/en/soccer/m-17-10-2026-${slug}-prediction">
  <div class="r2">
    <div class="r3"><span class="r4"><span>${time}</span></span><span class="r5">${status}</span></div>
    <div class="r6">
      <div class="r7"><span><img alt="${home}" src="data:image/gif;base64,R0lG"></span><span>${home}</span></div>
      <div class="r7"><span><img alt="${away}" src="data:image/gif;base64,R0lG"></span><span>${away}</span></div>
    </div>
    <div class="r8">${pct}
      <div class="r9"><div><span>${pick}</span></div><div><span>${score[0]}</span><span>${score[1]}</span></div></div>
      <span class="r10">${odds}</span>
    </div>
  </div>
  <div class="m1">${home} - ${away} ${time} ${pick} ${percent || ""}</div>
</a>`;
}

function s24Block(country, name, slug, count, rows = []) {
  return `
<div class="b0">
  <div class="b1"><div class="b2"><span><picture></picture></span><span>${country}</span><span></span>
     <a class="link" href="/en/soccer/l-${slug}">${name}</a><span>( ${count} )</span></div></div>
  <div class="b3">${rows.join("")}</div>
</div>`;
}

function s24Page(blocks, { menu = true } = {}) {
  // v menu jsou odkazy na ligy BEZ počtu zápasů – nesmí se zaměnit za hlavičky bloků
  const nav = menu ? '<nav><a href="/en/soccer/l-england-premier-league">Premier League</a><a href="/en/soccer/l-spain-laliga">La Liga</a></nav>' : "";
  return `<html><head><title>Soccer predictions</title></head><body>${nav}<div class='list'>${blocks.join("")}</div></body></html>`;
}

function forebetRow({ home, away, p, pick, when = "2026-10-18 15:30:00", odds = ["1.85", "3.40", "4.20"], href = "" }) {
  const o = odds ? odds.map((x) => `<span class="lscrsp">${x}</span>`).join("") : "";
  return `
<div class="rcnt tr_0">
  <div class="tnms">${href ? `<a class="tnmscn" href="${href}">zápas</a>` : ""}<div class="tnmscn">
    <span class="homeTeam"><span itemprop="name">${home}</span></span>
    <span class="awayTeam"><span itemprop="name">${away}</span></span>
    <time itemprop="startDate" datetime="${when}"><span class="date_bah">18/10/2026 15:30</span></time>
  </div></div>
  <div class="fprc"><span>${p[0]}</span><span class="fpr">${p[1]}</span><span>${p[2]}</span></div>
  <div class="predict"><div class="predict_y"><span class="forepr">${pick}</span></div></div>
  <div class="ex_sc tabonly">2 - 1</div><div class="avg_sc tabonly">2.71</div>
  <div class="haodd">${o}</div>
</div>`;
}

function forebetPage(rows, leagueTag = "Eng1") {
  const head = `<div class="trow8"><div class="shortagDiv"><span class="shortTag">${leagueTag}</span></div></div>`;
  return `<html><body><div class='contentmiddle'>${head}${rows.join("")}</div></body></html>`;
}

/** Událost ve tvaru API SofaScore. */
function sofaEvent(id, home, away, ts, stype = "notstarted", hs = null, as = null, normal = null) {
  const score = (cur, nt) => (cur === null ? {} : { current: cur, ...(nt !== null ? { normaltime: nt } : {}) });
  return {
    id, slug: `${home}-${away}`.toLowerCase().replace(/ /g, "-"), customId: "abc", startTimestamp: ts,
    status: { type: stype, description: "x" }, homeTeam: { name: home }, awayTeam: { name: away },
    homeScore: score(hs, normal ?? hs), awayScore: score(as, normal ?? as),
  };
}

module.exports = { s24Row, s24Block, s24Page, forebetRow, forebetPage, sofaEvent };
