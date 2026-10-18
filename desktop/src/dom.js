// Pomocné funkce nad cheerio – obdoba BeautifulSoup `stripped_strings` a `get_text`.
"use strict";

const cheerio = require("cheerio");

const SKIP = new Set(["script", "style", "noscript", "template"]);
const collapse = (s) => s.replace(/\s+/g, " ").trim();

function load(html) {
  return cheerio.load(html);
}

/** Všechny neprázdné texty uvnitř prvku v pořadí dokumentu, s sjednocenými mezerami. */
function strippedStrings(el) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === "text") {
      const t = collapse(node.data || "");
      if (t) out.push(t);
    } else if (node.children && !(node.type !== "root" && SKIP.has(node.name))) {
      node.children.forEach(walk);
    }
  };
  (el.get ? el.get() : [el]).forEach(walk);
  return out;
}

const textOf = (el) => strippedStrings(el).join(" ");

module.exports = { load, strippedStrings, textOf, collapse };
