// Úklid složky s ladicími soubory.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cleanDir, tidy } = require("../src/housekeeping");

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 23, 12);

function put(dir, name, bytes, ageDays) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "x".repeat(bytes));
  const t = new Date(NOW - ageDays * DAY);
  fs.utimesSync(file, t, t);
}

test("cleanDir: soubory starší než 7 dní se smažou, čerstvé zůstanou", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hk-"));
  put(dir, "stare.html", 1000, 8);
  put(dir, "nove.txt", 1000, 1);
  const r = cleanDir(dir, { now: NOW });
  assert.deepEqual(r.removed, ["stare.html"]);
  assert.deepEqual(fs.readdirSync(dir), ["nove.txt"]);
});

test("cleanDir: přes strop se maže od nejstarších, nejnovější soubor zůstane vždy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hk-"));
  put(dir, "a.html", 600, 5);
  put(dir, "b.html", 600, 3);
  put(dir, "c.txt", 600, 1);
  const r = cleanDir(dir, { now: NOW, maxBytes: 1000 });
  assert.deepEqual(r.removed, ["a.html", "b.html"]);
  assert.equal(r.bytes, 600);
  const only = fs.mkdtempSync(path.join(os.tmpdir(), "hk-"));
  put(only, "velky.html", 5000, 0);
  assert.deepEqual(cleanDir(only, { now: NOW, maxBytes: 100 }).removed, []);     // jediný soubor se nemaže
});

test("cleanDir/tidy: chybějící složka nevadí; tidy odstraní starou mezipaměť gólů a staré ladicí soubory Forebetu", () => {
  assert.deepEqual(cleanDir(path.join(os.tmpdir(), "neexistuje-hk-xyz")), { removed: [], bytes: 0 });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "hk-"));
  fs.writeFileSync(path.join(data, "forebet-goals.json"), "{}");
  fs.writeFileSync(path.join(data, "forebet-goals-v2.json"), "{}");
  fs.mkdirSync(path.join(data, "ladeni"));
  for (const name of ["forebet-zapas.html", "forebet-diagnostika.txt", "forebet-seznam.html", "forebet-seznam-diagnostika.txt", "tikety-odpoved.txt", "zdroje-diagnostika.txt"]) {
    fs.writeFileSync(path.join(data, "ladeni", name), "x");
  }
  tidy(data);
  assert.deepEqual(fs.readdirSync(data).sort(), ["forebet-goals-v2.json", "ladeni"]);
  assert.deepEqual(fs.readdirSync(path.join(data, "ladeni")), ["zdroje-diagnostika.txt"]);
});
