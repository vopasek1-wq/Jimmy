// Sdílené konstanty a pomocné funkce pro tipy.
"use strict";

const { normalize } = require("./names");
const { utcDateOf } = require("./timeutil");

const UPCOMING = "upcoming";
const LIVE = "live";
const FINISHED = "finished";

const SOURCE_SCORES24 = "Scores24";
const SOURCE_FOREBET = "Forebet";
const SOURCE_SOFASCORE = "SofaScore";

/** Identita tipu napříč opakovanými načteními (den zápasu v UTC + týmy + trh). */
function tipKey(t) {
  return [utcDateOf(t.kickoff), normalize(t.home), normalize(t.away), t.tipCode].join("|");
}

const sourceLabel = (t) => t.sources.join(" + ");

/** Výsledek jednoho běhu stahování. */
function newResult(startedAt) {
  return { tips: [], statuses: {}, startedAt, finishedAt: null, offline: false, warnings: [] };
}

const resultOk = (result) => {
  const st = result.statuses[SOURCE_SCORES24];
  return Boolean(st && (st.state === "ok" || st.state === "partial"));
};

module.exports = { UPCOMING, LIVE, FINISHED, SOURCE_SCORES24, SOURCE_FOREBET, SOURCE_SOFASCORE, tipKey, sourceLabel, newResult, resultOk };
