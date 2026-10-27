// Kontrola nové verze: číslo sestavení z verze, rozbor vydání GitHubu a důvody selhání.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOf, parseRelease, checkForUpdate } = require("../src/updates");
const config = require("../src/config");

const release = (name = "Fotbalové tipy – sestavení 37", extra = {}) => ({
  name, body: "Sestaveno 22.10.2026 14:00 UTC z commitu abc1234 (běh č. 37).", published_at: "2026-10-22T14:03:12Z",
  assets: [{ name: "FotbalTipy.exe", browser_download_url: "https://github.com/x/y/releases/download/tipy-latest/FotbalTipy.exe" }], ...extra,
});
const reply = (status, body) => async () => ({
  ok: status >= 200 && status < 300, status,
  json: async () => { if (body instanceof Error) throw body; return body; },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
/** fetch pro adresu vydání (jiná adresa = chyba testu). */
const api = (handler) => async (url, init) => {
  if (url !== config.RELEASE_API) throw new Error(`neočekávaná adresa ${url}`);
  return handler(url, init);
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

test("checkForUpdate: novější sestavení je k dispozici, stejné ani starší ne", async () => {
  let seen = null;
  const fetchFn = api(async (url, init) => { seen = { url, init }; return reply(200, release())(); });
  const newer = await checkForUpdate({ fetchFn, version: "1.0.36" });
  assert.deepEqual([newer.available, newer.current, newer.latest], [true, 36, 37]);
  assert.equal(seen.url, config.RELEASE_API);
  assert.equal(seen.init.headers["User-Agent"], "FotbalTipy");
  assert.equal(seen.init.headers.Accept, "application/vnd.github+json");
  assert.equal((await checkForUpdate({ fetchFn, version: "1.0.37" })).available, false);
  assert.equal((await checkForUpdate({ fetchFn, version: "1.0.40" })).available, false);
  assert.equal((await checkForUpdate({ fetchFn, version: "1.0.0" })).available, true); // vývojová verze
});

test("checkForUpdate: když kontrola selže, vrátí { error } se skutečným důvodem (a nikdy nevyhodí výjimku)", async () => {
  const why = async (handler) => (await checkForUpdate({ fetchFn: api(handler), version: "1.0.1" })).error;
  assert.equal(await why(reply(404, {})), "Kontrola nové verze se nepodařila (HTTP 404 (vydání se právě nahrává, nebo neexistuje)).");
  assert.match(await why(reply(403, {})), /HTTP 403 \(GitHub dočasně odmítá dotazy z tvé sítě\)/);
  assert.match(await why(reply(429, "")), /HTTP 429/);
  assert.match(await why(reply(500, {})), /HTTP 500\)/);
  assert.match(await why(offline), /net::ERR_INTERNET_DISCONNECTED/);
  assert.match(await why(reply(200, { name: "bez čísla" })), /není číslo sestavení/);
  assert.match(await why(reply(200, new Error("špatný JSON"))), /špatný JSON/);
  const hang = (_url, { signal }) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("abort"), { name: "AbortError" }))));
  const r = await checkForUpdate({ fetchFn: api(hang), version: "1.0.44", timeoutMs: 20 });
  assert.match(r.error, /vypršel časový limit/);
  assert.deepEqual([r.available, r.current], [undefined, 44]);
});
