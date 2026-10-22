// HTTP klient proti lokálnímu serveru: opakování, rozpoznání blokace, chyby spojení.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { HttpClient, SourceError, NetworkError, BlockedError, looksBlocked } = require("../src/http");

/** Spustí server, který vrací postupně odpovědi ze `script` (poslední se opakuje). */
async function server(script) {
  const state = { hits: 0, headers: [] };
  const srv = http.createServer((req, res) => {
    state.hits += 1;
    state.headers.push(req.headers);
    const [code, body, type = "text/plain"] = script[Math.min(state.hits, script.length) - 1];
    res.writeHead(code, { "Content-Type": `${type}; charset=utf-8` });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${srv.address().port}/x`;
  state.close = () => new Promise((r) => srv.close(r));
  return state;
}
const client = (extra = {}) => new HttpClient({ delayMs: [0, 0], sleep: async () => {}, retries: 2, timeoutMs: 3000, ...extra });

test("HTTP: text v UTF-8 a vlastní hlavičky", async () => {
  const s = await server([[200, "Příliš žluťoučký kůň"]]);
  try {
    assert.match(await client({ userAgent: "TestAgent/1" }).getText(s.url, { headers: { Cookie: "a=b" } }), /žluťoučký/);
    assert.equal(s.headers[0]["user-agent"], "TestAgent/1");
    assert.equal(s.headers[0].cookie, "a=b");
    assert.match(s.headers[0]["accept-language"], /^cs-CZ/);
  } finally { await s.close(); }
});

test("HTTP: JSON a neplatný JSON", async () => {
  const s = await server([[200, '{"a": 1}', "application/json"], [200, "není json"]]);
  try {
    assert.deepEqual(await client().getJson(s.url), { a: 1 });
    await assert.rejects(() => client().getJson(s.url), (e) => e instanceof SourceError && /JSON/.test(e.message));
  } finally { await s.close(); }
});

test("HTTP: chyba serveru se zopakuje a uspěje", async () => {
  const s = await server([[503, "busy"], [200, "ok"]]);
  try {
    assert.equal(await client().getText(s.url), "ok");
    assert.equal(s.hits, 2);
  } finally { await s.close(); }
});

test("HTTP: trvalá chyba serveru to vzdá po 1 + 2 pokusech", async () => {
  const s = await server([[500, "boom"]]);
  try {
    await assert.rejects(() => client().getText(s.url), (e) => e instanceof SourceError && /HTTP 500/.test(e.message));
    assert.equal(s.hits, 3);
  } finally { await s.close(); }
});

test("HTTP: kontrola Cloudflare = BlockedError bez opakování", async () => {
  const s = await server([[403, "<html><head><title>Just a moment...</title></head></html>", "text/html"]]);
  try {
    await assert.rejects(() => client().getText(s.url), BlockedError);
    assert.equal(s.hits, 1);
  } finally { await s.close(); }
});

test("HTTP: 404 je srozumitelná chyba", async () => {
  const s = await server([[404, "nope"]]);
  try {
    await assert.rejects(() => client().getText(s.url), (e) => e instanceof SourceError && /404/.test(e.message));
  } finally { await s.close(); }
});

test("HTTP: odmítnuté spojení znamená offline", async () => {
  await assert.rejects(() => client().getText("http://127.0.0.1:9/x"), (e) => e instanceof NetworkError && e.offline === true);
});

test("HTTP: časový limit není offline", async () => {
  const srv = http.createServer(() => { /* nikdy neodpoví */ });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(() => client({ timeoutMs: 100, retries: 0 }).getText(`http://127.0.0.1:${srv.address().port}/`),
      (e) => e instanceof NetworkError && e.offline === false && /časový limit/.test(e.message));
  } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
});

test("HTTP: pauza mezi dotazy na stejný server", async () => {
  const sleeps = [];
  const c = new HttpClient({ delayMs: [100, 100], sleep: async (ms) => { sleeps.push(ms); }, retries: 0 });
  const s = await server([[200, "ok"]]);
  try {
    await c.getText(s.url);
    await c.getText(s.url);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] > 0 && sleeps[0] <= 100);
  } finally { await s.close(); }
});

test("looksBlocked: skutečný obsah vs. stránka kontroly", () => {
  assert.equal(looksBlocked(403, "<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body>"), true);
  assert.equal(looksBlocked(200, "<!DOCTYPE html><html><head><title>Just a moment...</title>"), true);
  assert.equal(looksBlocked(200, "<html><head><title>Football predictions</title></head></html>"), false);
});

test("HTTP: vlastní pauza pro jednotlivý požadavek (delayMs)", async () => {
  const s = await server([[200, "a"], [200, "b"]]);
  const waits = [];
  const c = new HttpClient({ delayMs: [800, 1600], sleep: async (ms) => { waits.push(ms); }, retries: 0, timeoutMs: 3000 });
  try {
    await c.getText(s.url);                                  // první požadavek na server se nezdržuje
    await c.getText(s.url, { delayMs: [3000, 3000] });       // jinak by pauza byla nejvýš 1600 ms
    assert.equal(waits.length, 1);
    assert.ok(waits[0] > 2000 && waits[0] <= 3000, `pauza ${waits[0]} ms má vycházet z vlastního rozmezí`);
  } finally { await s.close(); }
});
