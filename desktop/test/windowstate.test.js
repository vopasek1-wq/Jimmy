// Pamatování monitoru, na kterém okno naposledy bylo.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadState, saveState, pickBounds } = require("../src/windowstate");

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const SECOND = { x: 1920, y: 0, width: 2560, height: 1400 };
const state = (over = {}) => ({ x: 2200, y: 100, width: 1500, height: 900, display: SECOND, ...over });

test("pickBounds: okno se vrátí na druhý monitor, kde bylo naposledy", () => {
  assert.deepEqual(pickBounds(state(), [PRIMARY, SECOND]), { x: 2200, y: 100, width: 1500, height: 900 });
});

test("pickBounds: monitor už není připojený → null (otevře se na hlavním)", () => {
  assert.equal(pickBounds(state(), [PRIMARY]), null);
  assert.equal(pickBounds(null, [PRIMARY, SECOND]), null);
});

test("pickBounds: velikost se vejde na monitor a poloha leží uvnitř něj", () => {
  assert.deepEqual(pickBounds(state({ width: 5000, height: 3000 }), [PRIMARY, SECOND]), { x: 1920, y: 0, width: 2560, height: 1400 });
  const off = pickBounds(state({ x: 100, y: 100 }), [PRIMARY, SECOND]);                   // uložená poloha je mimo monitor → na střed monitoru
  assert.deepEqual(off, { x: 1920 + 530, y: 250, width: 1500, height: 900 });
});

test("pickBounds: monitor se změnil rozlišením → najde se podle středu původní plochy", () => {
  const smaller = { x: 1920, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(pickBounds(state(), [PRIMARY, smaller]), { x: 2200, y: 100, width: 1500, height: 900 });
});

test("loadState/saveState: uložení, poškozený a chybějící soubor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wstate-"));
  const file = path.join(dir, "window.json");
  assert.equal(loadState(file), null);
  saveState(file, state());
  assert.deepEqual(loadState(file), state());
  fs.writeFileSync(file, "{ rozbité");
  assert.equal(loadState(file), null);
  saveState(file, { x: NaN });                       // neplatný stav se neukládá
  assert.equal(loadState(file), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
