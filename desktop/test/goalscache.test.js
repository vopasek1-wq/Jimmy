// Mezipaměť pravděpodobností gólů.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GoalsCache, TTL_MS } = require("../src/goalscache");
const { mayPass } = require("../src/filters");

test("GoalsCache: hodnota platí jen po dobu TTL a přežije uložení do souboru", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gc-")), "g.json");
  let t = 1_000_000;
  const a = new GoalsCache(file, { now: () => t });
  a.set("u1", { over: { 2.5: 60 } });
  a.save();
  const b = new GoalsCache(file, { now: () => t + TTL_MS - 1000 });
  assert.deepEqual(b.get("u1"), { over: { 2.5: 60 } });
  assert.equal(new GoalsCache(file, { now: () => t + TTL_MS + 1000 }).get("u1"), null);
  assert.equal(b.get("jiná"), null);
});

test("GoalsCache: poškozený nebo starý soubor nevadí, staré položky se zahodí", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-"));
  const file = path.join(dir, "g.json");
  fs.writeFileSync(file, "{ rozbité");
  assert.equal(new GoalsCache(file).get("x"), null);
  fs.writeFileSync(file, JSON.stringify({ old: { at: 0, goals: { over: {} } } }));
  const c = new GoalsCache(file, { now: () => 10 * 24 * 3600 * 1000 });
  assert.equal(c.items.size, 0);
  assert.doesNotThrow(() => new GoalsCache(null).save());
});

test("mayPass: tip, který filtry zahodí, nemá smysl dál doplňovat", () => {
  const tip = (o) => ({ home: "A", away: "B", leagueKey: "EPL", probability: 70, odds: 1.8, ...o });
  assert.equal(mayPass(tip()), true);
  assert.equal(mayPass(tip({ probability: 55 })), false);
  assert.equal(mayPass(tip({ probability: 60 })), false);
  assert.equal(mayPass(tip({ odds: 1.3 })), false);
  assert.equal(mayPass(tip({ odds: null, probability: 62 })), true);   // kurz se odhadne z pravděpodobnosti (1,52)
  assert.equal(mayPass(tip({ odds: null, probability: 70 })), false);  // odhad 1,34 je pod hranicí 1,50
  assert.equal(mayPass(tip({ probability: null })), true);        // pravděpodobnost může doplnit Forebet
  assert.equal(mayPass(tip({ leagueKey: "NEZNAMA" })), false);
  assert.equal(mayPass(tip({ home: "Arsenal Women" })), false);
});
