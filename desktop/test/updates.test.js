// Kontrola nové verze: číslo sestavení z verze, rozbor vydání GitHubu a rozhodnutí, jestli je k dispozici novější.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOf, parseRelease, checkForUpdate } = require("../src/updates");
const config = require("../src/config");

const release = (name = "Fotbalové tipy – sestavení 37", extra = {}) => ({
  name, body: "Sestaveno 22.10.2026 14:00 UTC z commitu abc1234 (běh č. 37).", published_at: "2026-10-22T14:03:12Z",
  assets: [{ name: "FotbalTipy.exe", browser_download_url: "https://github.com/x/y/releases/download/tipy-latest/FotbalTipy.exe" }], ...extra,
});
const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body instanceof Error) throw body; return body; } });

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
  const fetchFn = async (url, init) => { seen = { url, init }; return reply(200, release())(); };
  const newer = await checkForUpdate({ fetchFn, version: "1.0.36" });
  assert.deepEqual([newer.available, newer.current, newer.latest], [true, 36, 37]);
  assert.equal(seen.url, config.RELEASE_API);
  assert.equal(seen.init.headers["User-Agent"], "FotbalTipy");
  assert.equal((await checkForUpdate({ fetchFn, version: "1.0.37" })).available, false);
  assert.equal((await checkForUpdate({ fetchFn, version: "1.0.40" })).available, false);
  assert.equal((await checkForUpdate({ fetchFn, version: "1.0.0" })).available, true); // vývojová verze
});

test("checkForUpdate: chyby sítě, 404 a nesmysly se tiše přeskočí", async () => {
  assert.equal(await checkForUpdate({ fetchFn: reply(404, {}), version: "1.0.1" }), null);
  assert.equal(await checkForUpdate({ fetchFn: reply(403, { message: "rate limit" }), version: "1.0.1" }), null);
  assert.equal(await checkForUpdate({ fetchFn: reply(200, new Error("špatný JSON")), version: "1.0.1" }), null);
  assert.equal(await checkForUpdate({ fetchFn: reply(200, { name: "bez čísla" }), version: "1.0.1" }), null);
  assert.equal(await checkForUpdate({ fetchFn: async () => { throw new Error("ERR_INTERNET_DISCONNECTED"); }, version: "1.0.1" }), null);
  // časový limit
  const hang = (_url, { signal }) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("abort"))));
  assert.equal(await checkForUpdate({ fetchFn: hang, version: "1.0.1", timeoutMs: 20 }), null);
});
