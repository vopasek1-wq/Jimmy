// Načítání zpráv z RSS (Seznam Zprávy, Novinky.cz, iDNES.cz) a odstranění duplicitních témat.
"use strict";

const SOURCES = [
  { id: "seznam", name: "Seznam Zprávy", url: "https://www.seznamzpravy.cz/rss" },
  { id: "novinky", name: "Novinky.cz", url: "https://www.novinky.cz/rss" },
  { id: "idnes", name: "iDNES.cz", url: "https://servis.idnes.cz/rss.aspx?c=zpravodaj" },
];

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text = "") {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
};

function imageOf(item) {
  const szn = tag(tag(item, "szn:image"), "szn:url");
  if (szn) {
    // Seznam/Novinky posílají obrázek v šířce 1200 px – pro náhled stačí menší.
    return decode(szn).replace(/res,\d+,,\d+/, "res,240,,3");
  }
  const media = item.match(/<media:(?:content|thumbnail)\b[^>]*\burl="([^"]+)"/i)
    || item.match(/<enclosure\b[^>]*\burl="([^"]+)"[^>]*type="image/i);
  return media ? decode(media[1]) : "";
}

function parseFeed(xml, source) {
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(([, item]) => {
    const link = decode(tag(item, "link")).replace(/#utm_.*$/, "");
    const date = new Date(decode(tag(item, "pubDate")));
    return {
      source: source.id,
      sourceName: source.name,
      title: decode(tag(item, "title")),
      description: decode(tag(item, "description")),
      link,
      image: imageOf(item),
      published: Number.isNaN(date.getTime()) ? 0 : date.getTime(),
    };
  }).filter((a) => a.title && /^https:\/\//.test(a.link));
}

/* ---------- Stejná témata z více webů ---------- */
const normalize = (text) => text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const STOP = new Set(normalize(
  "jsou byla bude který která které podle kvůli proti mezi také však jeho jejich jako když další před " +
  "při pro nad pod bylo byli není může mohou chce chtějí jsme jste roku let tento tato toto tyto ještě již",
).split(" "));

// Klíčová slova z titulku a perexu; porovnává se jen začátek slova (hrubé „kmenování“ češtiny).
function keywords(text) {
  return new Set(
    normalize(text)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w))
      .map((w) => w.slice(0, 5)),
  );
}

// Ověřeno na živých datech: stejná událost z různých webů sdílí 6+ klíčových slov.
function isSameStory(a, b) {
  let shared = 0;
  a.forEach((w) => { if (b.has(w)) shared += 1; });
  return shared >= 6 || (shared >= 3 && shared / Math.min(a.size, b.size) >= 0.5);
}

function mergeUnique(lists, limit = 20) {
  // Zdroje se střídají (aby žádný nepřevážil), duplicitní témata se přeskočí.
  const queues = lists.map((list) => [...list].sort((x, y) => y.published - x.published));
  const picked = [];
  const seenLinks = new Set();
  while (picked.length < limit && queues.some((q) => q.length)) {
    for (const queue of queues) {
      while (queue.length) {
        const article = queue.shift();
        const kw = keywords(`${article.title} ${article.description}`);
        if (seenLinks.has(article.link) || picked.some((p) => isSameStory(p.kw, kw))) continue;
        seenLinks.add(article.link);
        picked.push({ ...article, kw });
        break;
      }
      if (picked.length >= limit) break;
    }
  }
  return picked
    .sort((x, y) => y.published - x.published)
    .map(({ kw, ...article }) => article);
}

async function fetchNews(fetchImpl, limit = 20) {
  const results = await Promise.allSettled(SOURCES.map(async (source) => {
    const res = await fetchImpl(source.url, { headers: { "User-Agent": BROWSER_UA, Accept: "application/rss+xml, application/xml, text/xml" } });
    if (!res.ok) throw new Error(`${source.name}: HTTP ${res.status}`);
    return parseFeed(await res.text(), source);
  }));
  const lists = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const errors = results.filter((r) => r.status === "rejected").map((r) => String(r.reason?.message || r.reason));
  if (!lists.length) throw new Error(errors.join("; ") || "Žádný zdroj neodpověděl");
  return { articles: mergeUnique(lists, limit), errors, fetchedAt: Date.now() };
}

module.exports = { SOURCES, parseFeed, mergeUnique, isSameStory, keywords, fetchNews };
