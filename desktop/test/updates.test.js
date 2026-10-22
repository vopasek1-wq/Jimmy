// Kontrola nové verze: číslo sestavení z verze, rozbor vydání GitHubu a Atom kanálu, záložní cesta a důvody selhání.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOf, parseRelease, parseFeed, checkForUpdate } = require("../src/updates");
const config = require("../src/config");

const release = (name = "Fotbalové tipy – sestavení 37", extra = {}) => ({
  name, body: "Sestaveno 22.10.2026 14:00 UTC z commitu abc1234 (běh č. 37).", published_at: "2026-10-22T14:03:12Z",
  assets: [{ name: "FotbalTipy.exe", browser_download_url: "https://github.com/x/y/releases/download/tipy-latest/FotbalTipy.exe" }], ...extra,
});
const feed = (...titles) => `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n  <title>Release notes from Jimmy</title>\n${titles.map((t) => `  <entry><id>x</id><title>${t}</title></entry>`).join("\n")}\n</feed>`;
const reply = (status, body) => async () => ({
  ok: status >= 200 && status < 300, status,
  json: async () => { if (body instanceof Error) throw body; return body; },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
/** fetch podle adresy: API a Atom kanál. */
const routes = ({ api, atom }) => async (url, init) => {
  if (url === config.RELEASE_API) return api(url, init);
  if (url === config.RELEASE_FEED) return atom(url, init);
  throw new Error(`neočekávaná adresa ${url}`);
};
const offline = async () => { throw new Error("net::ERR_INTERNET_DISCONNECTED"); };

test("buildOf: číslo sestavení z verze", () => {
  assert.deepEqual(["1.0.37", "1.0.0", "2.3.105", "1.0", "", null, "x.y.z"].map(buildOf), [37, 0, 105, 0, 0, 0, 0]);
});

test("parseRelease: číslo z názvu i z popisu, odkaz na exe", () => {
  assert.deepEqual(parseRelease(release()), { build: 37, url: "https://github.com/x/y/releases/download/tipy-latest/FotbalTipy.exe", published: "2026-10-22T14:03:12Z" });
  const fromBody = parseRelease(release("Něco jiného", { assets: [] }));
  assert.deepEqual([fromBody.build, fromBody.url], [37, config.DOWNLOAD_URL]);
  assert.equal(parseRelease(release("Bez čísla", { body: "nic" })), null);
  assert.equal(parseRelease(null), null);
  assert.equal(parseRelease("text"), null);
});

test("parseFeed: nejvyšší číslo sestavení z názvů vydání, ostatní vydání se ignorují", () => {
  const xml = feed("J.I.M.M.Y. – verze 26", "Fotbalové tipy – sestavení 42", "Fotbalové tipy &amp; spol. – sestavení 7", "AI Dashboard pro Windows");
  assert.deepEqual(parseFeed(xml), { build: 42, url: config.DOWNLOAD_URL, published: null });
  assert.equal(parseFeed(feed("J.I.M.M.Y. – verze 26")), null);
  assert.equal(parseFeed(""), null);
  assert.equal(parseFeed(null), null);
});

test("checkForUpdate: novější sestavení je k dispozici, stejné ani starší ne", async () => {
  let seen = null;
  const fetchFn = routes({ api: async (url, init) => { seen = { url, init }; return reply(200, release())(); }, atom: offline });
  const newer = await checkForUpdate({ fetchFn, version: "1.0.36" });
  assert.deepEqual([newer.available, newer.current, newer.latest], [true, 36, 37]);
  assert.equal(seen.url, config.RELEASE_API);
  assert.equal(seen.init.headers["User-Agent"], "FotbalTipy");
  assert.equal(seen.init.headers.Accept, "application/vnd.github+json");
  assert.equal((await checkForUpdate({ fetchFn, version: "1.0.37" })).available, false);
  assert.equal((await checkForUpdate({ fetchFn, version: "1.0.40" })).available, false);
  assert.equal((await checkForUpdate({ fetchFn, version: "1.0.0" })).available, true); // vývojová verze
});

test("checkForUpdate: když API nejde (limit, 404, spojení, odpověď bez čísla), použije se Atom kanál", async () => {
  const atom = reply(200, feed("Fotbalové tipy – sestavení 42"));
  for (const api of [reply(403, { message: "rate limit" }), reply(404, {}), offline, reply(200, { name: "bez čísla" }), reply(200, new Error("špatný JSON"))]) {
    const r = await checkForUpdate({ fetchFn: routes({ api, atom }), version: "1.0.40" });
    assert.deepEqual([r.latest, r.available, r.url], [42, true, config.DOWNLOAD_URL]);
  }
});

test("checkForUpdate: když selžou obě cesty, vrátí { error } se skutečnými důvody", async () => {
  const both = async (api, atom) => (await checkForUpdate({ fetchFn: routes({ api, atom }), version: "1.0.1" })).error;
  assert.equal(await both(reply(404, {}), offline),
    "Kontrola nové verze se nepodařila (GitHub API: HTTP 404 (vydání se právě nahrává, nebo neexistuje); github.com: net::ERR_INTERNET_DISCONNECTED).");
  assert.match(await both(reply(403, {}), reply(429, "")), /GitHub API: HTTP 403 \(GitHub dočasně odmítá dotazy z tvé sítě\); github\.com: HTTP 429 \(GitHub dočasně odmítá/);
  assert.match(await both(reply(500, {}), reply(200, feed("J.I.M.M.Y. – verze 26"))), /GitHub API: HTTP 500; github\.com: v seznamu vydání není sestavení/);
  const hang = (_url, { signal }) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("abort"), { name: "AbortError" }))));
  const r = await checkForUpdate({ fetchFn: hang, version: "1.0.1", timeoutMs: 20 });
  assert.match(r.error, /GitHub API: vypršel časový limit; github\.com: vypršel časový limit/);
  assert.equal(r.available, undefined);
});
