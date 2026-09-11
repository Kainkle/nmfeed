// nmfeed GHA build — one fresh worker cycle → <target>/live.json, day.json, report.json.
// Node >= 20, ZERO npm deps (node:fs + global fetch only). `node scripts/build.mjs [target]`
// (default target: docs/). The repo commit IS the persistence — see LOCAL-TEST.md for why
// statelessness is sound against the worker's KV keys.
//
// Single source of truth: the cycle is worker/worker.js's runCycle, imported not copied.
// It takes the KV via env.FEED, so an in-memory Map satisfies it — and makes "no state
// between runs" true by construction: get() always misses, put() dies with the process.
// Layout note: in the nmfeed repo this file sits at scripts/ with worker/ as a sibling
// (import ../worker/worker.js). In the F-offbox tree it sits at gha/scripts/ with the
// worker two up — hence the one fallback.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
let W;
try {
  W = await import("../worker/worker.js"); // nmfeed layout: scripts/ + worker/
} catch {
  W = await import("../../worker/worker.js"); // F-offbox layout: gha/scripts/ + worker/
}

const target = process.argv[2] || "docs";

// Throwaway KV stub — the shape test.mjs uses, minus the counters.
const kv = new Map();
const env = { FEED: {
  get: async (k) => (kv.has(k) ? kv.get(k) : null),
  put: async (k, v) => { kv.set(k, v); },
} };

const t0 = Date.now();
let payload = null;
try {
  // 28 ESPN scoreboards + 1 mut listing; httpJson already swallows per-source failure
  // (null → league degrades / rows go last-good → here: empty). Never throws on a down source.
  payload = await W.runCycle(env, Date.now());
} catch (e) {
  console.error(`cycle failed: ${(e && e.stack) || e}`);
}

if (payload) {
  mkdirSync(target, { recursive: true });
  for (const [name, body] of [
    ["live.json", payload.live],
    ["day.json", payload.day],
    ["report.json", payload.report],
  ])
    writeFileSync(join(target, name), JSON.stringify(body) + "\n");
  const r = payload.report;
  console.log(
    `feed: matched=${r.matched} specials=${r.specials} near=${r.near.length} ` +
    `unmatched=${r.unmatched.length} universe=${payload.day.universe} ` +
    `live=${payload.live.live.length} ms=${Date.now() - t0} ` +
    `subrequests=${Object.keys(W.LEAGUE_SPORT).length + 1} -> ${target}/`
  );
} else {
  console.error("feed: no files written");
  process.exit(1); // loud ONLY here: cycle produced nothing at all
}
