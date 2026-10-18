"""Sestavení ukázkových stránek ve stejné struktuře, jakou má živý web.

Scores24 (ověřeno na živém HTML): ligový blok = hlavička (odkaz /soccer/l-<slug> + „( N )“)
a pod ní odkazy na zápasy; rozbalený blok má zápasy v DOM, sbalený ne.
Třídy v ukázkách jsou záměrně jiné než na živém webu – parser se na ně nesmí spoléhat.
"""
from __future__ import annotations


def s24_row(home: str, away: str, time: str = "15:30", status: str = "today", pick: str = "Arsenal to Win",
            percent: str | None = "86", odds: str = "1.71", score: tuple[str, str] = ("-", "-"),
            slug: str = "a-b", pct_sign: bool = True) -> str:
    pct = ""
    if percent is not None:
        pct = (f'<div class="x1"><svg><use xlink:href="#finger-up"></use></svg>'
               f'<span>{percent}{"<!-- -->%" if pct_sign else ""}</span></div>')
    return f"""
<a class="link r1" href="/en/soccer/m-17-10-2026-{slug}-prediction">
  <div class="r2">
    <div class="r3"><span class="r4"><span>{time}</span></span><span class="r5">{status}</span></div>
    <div class="r6">
      <div class="r7"><span><img alt="{home}" src="data:image/gif;base64,R0lG"></span><span>{home}</span></div>
      <div class="r7"><span><img alt="{away}" src="data:image/gif;base64,R0lG"></span><span>{away}</span></div>
    </div>
    <div class="r8">{pct}
      <div class="r9"><div><span>{pick}</span></div><div><span>{score[0]}</span><span>{score[1]}</span></div></div>
      <span class="r10">{odds}</span>
    </div>
  </div>
  <div class="m1">{home} - {away} {time} {pick} {percent or ""}</div>
</a>"""


def s24_block(country: str, name: str, slug: str, count: int, rows: list[str] | None = None) -> str:
    body = "".join(rows) if rows else ""
    return f"""
<div class="b0">
  <div class="b1"><div class="b2"><span><picture></picture></span><span>{country}</span><span></span>
     <a class="link" href="/en/soccer/l-{slug}">{name}</a><span>( {count} )</span></div></div>
  <div class="b3">{body}</div>
</div>"""


def s24_page(blocks: list[str], menu: bool = True) -> str:
    # v menu jsou odkazy na ligy BEZ počtu zápasů – nesmí se zaměnit za hlavičky bloků
    nav = ('<nav><a href="/en/soccer/l-england-premier-league">Premier League</a>'
           '<a href="/en/soccer/l-spain-laliga">La Liga</a></nav>') if menu else ""
    return f"<html><head><title>Soccer predictions</title></head><body>{nav}<div class='list'>{''.join(blocks)}</div></body></html>"


def forebet_row(home: str, away: str, p: tuple[int, int, int], pick: str, when: str = "2026-10-18 15:30:00",
                odds: tuple[str, str, str] | None = ("1.85", "3.40", "4.20")) -> str:
    o = "".join(f'<span class="lscrsp">{x}</span>' for x in odds) if odds else ""
    return f"""
<div class="rcnt tr_0">
  <div class="tnms"><div class="tnmscn">
    <span class="homeTeam"><span itemprop="name">{home}</span></span>
    <span class="awayTeam"><span itemprop="name">{away}</span></span>
    <time itemprop="startDate" datetime="{when}"><span class="date_bah">18/10/2026 15:30</span></time>
  </div></div>
  <div class="fprc"><span>{p[0]}</span><span class="fpr">{p[1]}</span><span>{p[2]}</span></div>
  <div class="predict"><div class="predict_y"><span class="forepr">{pick}</span></div></div>
  <div class="ex_sc tabonly">2 - 1</div><div class="avg_sc tabonly">2.71</div>
  <div class="haodd">{o}</div>
</div>"""


def forebet_page(rows: list[str], league_tag: str = "Eng1") -> str:
    head = f'<div class="trow8"><div class="shortagDiv"><span class="shortTag">{league_tag}</span></div></div>'
    return f"<html><body><div class='contentmiddle'>{head}{''.join(rows)}</div></body></html>"
