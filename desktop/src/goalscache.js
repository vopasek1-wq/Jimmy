// Mezipaměť pravděpodobností gólů z Forebetu (podle adresy zápasu), aby se stránky zápasů nestahovaly při každém obnovení.
// Hodnoty se mění pomalu, proto platí několik hodin; ukládá se do JSON souboru, ať přežije restart aplikace.
"use strict";

const fs = require("node:fs");

const TTL_MS = 4 * 3600 * 1000;
const KEEP_MS = 2 * 24 * 3600 * 1000;

class GoalsCache {
  constructor(file = null, { now = () => Date.now(), ttlMs = TTL_MS } = {}) {
    this.file = file;
    this.now = now;
    this.ttlMs = ttlMs;
    this.items = new Map();
    this.dirty = false;
    if (file) {
      try {
        for (const [url, e] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) {
          if (e && e.goals && now() - e.at < KEEP_MS) this.items.set(url, e);
        }
      } catch { /* žádná nebo poškozená mezipaměť = začíná se znovu */ }
    }
  }

  get(url) {
    const e = this.items.get(url);
    return e && this.now() - e.at < this.ttlMs ? e.goals : null;
  }

  set(url, goals) {
    this.items.set(url, { at: this.now(), goals });
    this.dirty = true;
  }

  save() {
    if (!this.file || !this.dirty) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.items)), "utf8");
      this.dirty = false;
    } catch { /* mezipaměť je jen urychlení */ }
  }
}

module.exports = { GoalsCache, TTL_MS };
