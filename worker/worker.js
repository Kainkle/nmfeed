// nmsports-feed — sportsfeed/ ported to one Cloudflare Worker (sofafleet F-offbox).
// Faithful port of sportsfeed/{espn,mut,match,fights,build}.py; the documented traps are
// marked TRAP below. One file, no build step, vanilla JS.
//
//   scheduled()  every minute: fetch ALL ESPN leagues (~30 GETs) + the mut listing (1) →
//                normalize → match → write {live, day, report} to KV key "feed".
//                The python loop's two-tier polling (actives every 10s, full scan / 30min)
//                collapses to one full tier per minute — the scoreboard GET carries all
//                three states, so the vanish→event() finals flow is redundant here.
//   fetch()      serves /live.json, /day.json, /report.json from KV (max-age=10, CORS *).
//                First deploy (empty KV) builds inline; if KV is >150s stale (cron missed)
//                a rebuild fires via waitUntil while stale content is served — degrade,
//                never blank.
//
// kiss: build + serve + cron in one module; splitting them buys nothing at this size.
// Deltas vs python are listed in ../FINDINGS.md.

// ---------- http seam (test.mjs swaps this) ----------
export function __setHttp(fn) { httpJson = fn; }
let httpJson = async (url, headers) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);
  try {
    const r = await fetch(url, { headers, signal: ac.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
};

// ---------- espn.py ----------
const ESPN_BASE = "https://site.web.api.espn.com/apis/site/v2/sports";

// mut groups → sport slug, VERBATIM: the matcher's sport discount and the emit key off this.
export const MUT_GROUP_TO_SLUG = {
  football: "football",
  "american-football": "american-football",
  baseball: "baseball",
  basketball: "basketball",
  fight: "mma",
  cricket: "cricket",
  darts: "darts",
  tennis: "tennis",
  afl: "aussie-rules",
};

// TRAP (espn.py L54): the table is (espn_sport, league) PAIRS — soccer under /soccer/, NFL and
// CFB under /football/. Deriving the path from the slug silently drops ALL soccer and both
// football codes (every other combination 400s, measured 2026-09-07).
export const LEAGUES = {
  football: [
    ["soccer", "eng.1"], ["soccer", "eng.2"], ["soccer", "eng.3"], ["soccer", "eng.4"],
    ["soccer", "esp.1"], ["soccer", "esp.2"], ["soccer", "ita.1"], ["soccer", "ger.1"],
    ["soccer", "fra.1"], ["soccer", "fra.2"], ["soccer", "por.1"], ["soccer", "ned.1"],
    ["soccer", "arg.1"], ["soccer", "bra.1"], ["soccer", "col.1"], ["soccer", "mex.1"],
    ["soccer", "usa.1"], ["soccer", "ksa.1"], ["soccer", "swe.1"],
    ["soccer", "uefa.champions"],
  ],
  "american-football": [["football", "nfl"], ["football", "college-football"]],
  baseball: [["baseball", "mlb"]],
  basketball: [["basketball", "nba"], ["basketball", "wnba"]],
  mma: [["mma", "ufc"]],
  tennis: [["tennis", "atp"], ["tennis", "wta"]],
};
export const LEAGUE_SPORT = {}; // league -> [slug, espn_sport]
for (const [slug, pairs] of Object.entries(LEAGUES))
  for (const [espnSport, lg] of pairs) LEAGUE_SPORT[lg] = [slug, espnSport];

export const leagueUrl = (league) =>
  `${ESPN_BASE}/${LEAGUE_SPORT[league][1]}/${league}/scoreboard`;

// Accent-fold BEFORE tokenizing (espn.py _fold): NFKD alone leaves combining marks that the
// matcher's own regex turns into spaces. Python drops chars with combining(c)!=0; \p{M} is the
// JS equivalent (Mn|Mc|Me — a strict superset that no team name here exercises).
const fold = (s) => (s || "").normalize("NFKD").replace(/\p{M}/gu, "");

function espnStatus(t) {
  if (t.name === "STATUS_POSTPONED") return "postponed";
  if (t.name === "STATUS_CANCELLED") return "cancelled";
  if (t.state === "in") return "live";
  if (t.state === "post") return "final";
  if (t.state === "pre") return "scheduled";
  return "unknown";
}

// An ESPN scoreboard event → the lean feed row (espn.py normalize's exact shape + key order).
function espnNormalize(e, slug, league) {
  try {
    const comp = (e.competitions || [{}])[0];
    const cs = comp.competitors || [];
    const home = cs.find((c) => c.homeAway === "home") || null;
    const away = cs.find((c) => c.homeAway === "away") || null;
    const date = e.date || "";
    if (!home || !away || !home.team?.displayName || !away.team?.displayName || !date) return null;
    const team = (c) => {
      const t = c.team || {};
      return {
        id: t.id,
        name: fold(t.displayName),
        short: fold(t.abbreviation),
        code: t.abbreviation || "",
        logo: (t.logos || [{}])[0].href || null,
      };
    };
    const st = (comp.status || {}).type || {};
    const status = espnStatus(st); // LIVE is never inferred — the source's own state, mapped
    return {
      id: `espn:${e.id}`,
      sport: slug,
      competition: fold((e.league || {}).name || league),
      start_utc: date,
      status,
      detail: status === "live" ? fold(st.shortDetail) : "",
      home: { ...team(home), score: String(home.score || "") },
      away: { ...team(away), score: String(away.score || "") },
    };
  } catch {
    return null;
  }
}

// One scoreboard GET. [] = failure; the caller degrades that league silently, never blanks.
async function scoreboard(league) {
  const data = await httpJson(leagueUrl(league));
  if (!data || !Array.isArray(data.events)) return [];
  const [slug] = LEAGUE_SPORT[league];
  const out = [];
  for (const e of data.events) {
    const ev = espnNormalize(e, slug, league);
    if (ev) out.push(ev);
  }
  return out;
}

// ---------- mut.py ----------
export const MUT_API = "https://mut.st/api/streams";
const MUT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const RE_VS = /^(.+?)\s+(?:vs\.?|at)\s+(.+)$/i; // mut uses "at" in NFL titles
const RE_PT_DATE = /\((\d{2})\/(\d{2})\/(\d{4})\)/;
// "05:00 PM PST - (09/06/2026)". "PST" is mut's year-round label for PT local time; parsed
// with a DST-aware offset below (the 04:59 "PST" row was verifiably 4:59 PM PDT).
const RE_PT_TIME = /(\d{1,2}):(\d{2})\s*(AM|PM)\s*PST[^(]*\((\d{2})\/(\d{2})\/(\d{4})\)/;

function firstSunday(y, mo) {
  const w = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7; // Monday=0 … Sunday=6
  return 1 + ((6 - w) % 7);
}
// -7 in PDT (2nd Sun Mar – 1st Sun Nov), -8 in PST. Date-granular on purpose (mut.py L47).
function ptOffsetHours(y, m, d) {
  const dstStart = Date.UTC(y, 2, firstSunday(y, 3) + 7);
  const dstEnd = Date.UTC(y, 10, firstSunday(y, 11));
  const t = Date.UTC(y, m - 1, d);
  return t >= dstStart && t < dstEnd ? -7 : -8;
}

export function mutStartUtc(timeField) {
  const m = RE_PT_TIME.exec(timeField || "");
  if (!m) return "";
  const hh = Number(m[1]) % 12 + (m[3].toUpperCase() === "PM" ? 12 : 0);
  const off = ptOffsetHours(+m[6], +m[4], +m[5]);
  return new Date(Date.UTC(+m[6], +m[4] - 1, +m[5], hh, +m[2]) - off * 3600e3)
    .toISOString().slice(0, 19) + "Z";
}

// One mut listing row, pre-parsed. Sides stay RAW; the matcher norms them.
export function mutRow(stream) {
  const title = (stream.title || "").trim();
  const d = RE_PT_DATE.exec(stream.time || "");
  if (!d) return null; // schedule headers, junk — not a dated listing
  const m = RE_VS.exec(title);
  return {
    title,
    date: `${d[3]}-${d[1]}-${d[2]}`, // PT date, from mut's own field
    group: stream.groupId || "",
    sources: (stream.sources || []).filter((s) => s && s.embedUrl).map((s) => s.embedUrl),
    start_utc: mutStartUtc(stream.time),
    versus: !!m,
    a: m ? m[1].trim() : "",
    b: m ? m[2].trim() : "",
    fight_special: (stream.groupId || "") === "fight" && !m,
  };
}

const KEEP_DAYS = 8, DROP_AFTER_H = 36;
export async function mutListing(nowMs) {
  const body = await httpJson(MUT_API, { "User-Agent": MUT_UA });
  if (!Array.isArray(body)) return null; // unreachable → caller degrades, never blanks
  const horizon = nowMs + KEEP_DAYS * 86400e3;
  const past = nowMs - DROP_AFTER_H * 3600e3;
  const rows = [];
  for (const section of body)
    for (const stream of section.streams || []) {
      const row = mutRow(stream);
      if (!row) continue;
      if (row.fight_special) {
        // Fossil prune: a title-only fight row with no playable sources and no airtime inside
        // the window is junk (measured: a 2016 LFC card lingers in the listing).
        const start = row.start_utc ? Date.parse(row.start_utc) : NaN;
        if (!row.sources.length && (Number.isNaN(start) || start < past || start > horizon)) continue;
      } else if (!row.versus) continue;
      rows.push(row);
    }
  return rows;
}

// ---------- match.py ----------
export const PAIR_FLOOR = 0.6;
const STOP = new Set(["fc", "cf", "ac", "sc", "afc", "the", "de", "cd", "as"]);

// Hand-grown aliases for gaps the token math can't see (match.py's doctrine: one verified
// entry at a time — a speculative table is an untested belief).
export const EXTRA_ALIASES = {
  "SMU Mustangs": ["Southern Methodist Mustangs"],
  "Estoril Praia": ["Estoril"],
};

export function norm(s) {
  // TRAP (match.py L50): fold accents BEFORE the regex — NFKD alone leaves combining marks
  // that the substitution turns into SPACES: "Vitória" became "vit oria", never equal to
  // "vitoria" (worth ~12 points of match rate, C-T-102).
  const flat = (s || "").normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[^0-9a-zA-Z\s]/g, " ").toLowerCase();
  const joined = [];
  let run = []; // join adjacent single letters: "D.C." → "dc"
  const flush = () => { if (run.length) { joined.push(run.join("")); run = []; } };
  for (const t of flat.split(/\s+/).filter(Boolean)) {
    if (t.length === 1) run.push(t);
    else { flush(); joined.push(t); }
  }
  flush();
  return new Set(joined.filter((t) => !STOP.has(t)));
}

const inter = (a, b) => { let n = 0; for (const t of a) if (b.has(t)) n++; return n; };
// max(Jaccard, containment) — containment lets "Athletics" hit "Oakland Athletics".
export function sideScore(a, b) {
  if (!a.size || !b.size) return 0;
  const i = inter(a, b);
  const jac = i / (a.size + b.size - i);
  return Math.max(jac, i / Math.min(a.size, b.size));
}

// Best-oriented both-sides score, floored by the WORSE side.
export const pairScore = (ra, rb, h, aw) =>
  Math.max(Math.min(sideScore(ra, h), sideScore(rb, aw)),
           Math.min(sideScore(ra, aw), sideScore(rb, h)));

// Both UTC-7 and UTC-8 — the DST edge — as ISO dates.
export function ptDates(startUtc) {
  let s = (startUtc || "").trim();
  if (/^\S+T\d{2}:\d{2}Z$/.test(s)) s = s.slice(0, -1) + ":00Z";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return [];
  return [-7, -8].map((o) => new Date(t + o * 3600e3).toISOString().slice(0, 10));
}

function extraTokens(name) {
  return (EXTRA_ALIASES[name] || []).flatMap((a) => [...norm(a)]);
}

// Events grouped by PT date: {date: [[id, {sport, h, a, dates}]]} — each best() scans
// same-day candidates only.
export function indexEvents(events, cache) {
  const out = {};
  for (const ev of events) {
    let c = cache ? cache.get(ev.id) : null;
    if (!c) {
      const h = new Set([...norm(ev.home.name), ...(ev.home.short ? norm(ev.home.short) : []), ...extraTokens(ev.home.name)]);
      const a = new Set([...norm(ev.away.name), ...(ev.away.short ? norm(ev.away.short) : []), ...extraTokens(ev.away.name)]);
      c = { sport: ev.sport, h, a, dates: ptDates(ev.start_utc) };
      if (cache) cache.set(ev.id, c);
    }
    for (const d of c.dates) (out[d] = out[d] || []).push([ev.id, c]);
  }
  return out;
}

// Highest-scoring ESPN event id for one mut row: gated by PT date, discounted by sport.
export function bestMatch(row, byDate) {
  const ra = norm(row.a), rb = norm(row.b);
  const expect = MUT_GROUP_TO_SLUG[row.group];
  let bestKey = null, bestScore = 0;
  for (const [key, c] of byDate[row.date] || []) {
    let s = pairScore(ra, rb, c.h, c.a);
    if (s < PAIR_FLOOR) continue;
    if (expect && c.sport !== expect) s *= 0.6; // discount, never veto
    if (s > bestScore) { bestKey = key; bestScore = s; }
  }
  return [bestKey, bestScore];
}

// ---------- fights.py ----------
const FIGHT_WINDOW_H = 4;
const PROMO_SPORT = [
  ["wrestling", /\bwwe\b|\bwwf\b|\braw\b|smackdown|\bnxt\b|\baew\b|dynamite|collision|\btna\b|\bnjpw\b|\broh\b|\bimpact\b|wrestl/i],
  ["mma", /\bufc\b|\bmma\b|contender series|rizin|\bpfl\b|bellator|\blfc\b|\bufl\b/i],
  ["boxing", /boxing|fight night|golden boy|top rank|\bwbc\b|\bwba\b|\bibo\b/i],
];
export const fightSport = (title) => (PROMO_SPORT.find(([, rx]) => rx.test(title)) || ["fight"])[0];

// The clock-bracketed status for a fight row ESPN does not speak for. The clock never sets
// live alone: mid-window is live ONLY if mut carries the row playable; else unknown.
export function fightStatus(row, nowMs) {
  if (row.group !== "fight" || !row.start_utc) return null;
  const start = Date.parse(row.start_utc);
  if (Number.isNaN(start)) return null;
  if (nowMs < start) return "scheduled";
  if (nowMs - start > FIGHT_WINDOW_H * 3600e3) return "finished";
  return row.sources.length ? "live" : "unknown";
}

// ---------- build.py (one cron cycle) ----------
const round2 = (x) => Math.round(x * 100) / 100;
const nowIso = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";
const byStartHome = (x, y) => {
  const a = x.start_utc || "", b = y.start_utc || "";
  return a < b ? -1 : a > b ? 1 : x.home.name < y.home.name ? -1 : 1;
};

// Bindings are incremental (build.py's lesson): a row keeps its binding while its event id
// lives in the pool. On the worker the cross-cycle store is KV key "bind" ({title: [id, score]}).
function bindRows(rows, pool, bindings) {
  const byDate = indexEvents(Object.values(pool));
  const out = {};
  for (const row of rows) {
    if (!row.versus) continue; // fight specials have no sides; fights.py owns their status
    const bound = bindings[row.title];
    if (bound && pool[bound[0]]) { out[row.title] = bound; continue; }
    const [key, score] = bestMatch(row, byDate);
    if (key) out[row.title] = [key, score]; // raw score; emit rounds (build.py's flow)
  }
  return out;
}

function emit(rows, pool, bindings, nowMs) {
  const liveOut = [], schedOut = [], finOut = [];
  const report = { matched: 0, near: [], unmatched: [], specials: 0, generated_utc: nowIso(nowMs) };
  for (const row of rows) {
    const bound = bindings[row.title];
    const ev = bound ? pool[bound[0]] : null;
    const score = bound ? bound[1] : 0;
    const mutMeta = { title: row.title, sources: row.sources.length, group: row.group };
    if (!ev) {
      // Fight rows ESPN does not carry: clock-bracketed pass; unknown keeps the
      // never-infer-LIVE rule intact even inside the exception.
      const status = fightStatus(row, nowMs);
      if (status) {
        const entry = {
          id: `mut:${row.title}`, sport: fightSport(row.title), start_utc: row.start_utc,
          status, detail: "", home: { name: row.a || row.title }, away: { name: row.b || "" },
          mut: mutMeta,
        };
        report.specials++;
        (status === "live" ? liveOut : status === "finished" ? finOut : schedOut).push(entry);
        continue;
      }
      report.unmatched.push(mutMeta);
      // Unmatched rows still ship in day.json — playable per mut, UNKNOWN status, never inferred.
      schedOut.push({
        id: `mut:${row.title}`, sport: row.group, start_utc: "", status: "unknown", detail: "",
        home: { name: row.a || row.title }, away: { name: row.b || "" }, mut: mutMeta,
      });
      continue;
    }
    report.matched++;
    if (score < PAIR_FLOOR)
      report.near.push({ ...mutMeta, score, sofa: `${ev.home.name} vs ${ev.away.name}` });
    const out = { ...ev, mut: mutMeta, match: round2(score) };
    if (ev.status === "live" && mutMeta.sources >= 1) liveOut.push(out);
    else if (ev.status === "final" || ev.status === "postponed" || ev.status === "cancelled") finOut.push(out);
    else schedOut.push(out);
  }
  liveOut.sort(byStartHome); schedOut.sort(byStartHome); finOut.sort(byStartHome);
  return {
    live: { generated_utc: nowIso(nowMs), refresh_s: 60, live: liveOut },
    day: {
      generated_utc: nowIso(nowMs), scheduled: schedOut, live: liveOut, finished: finOut,
      universe: rows.length, matched: report.matched,
    },
    report,
  };
}

// One full cycle. KV keys: "feed" {t, live, day, report} · "bind" bindings · "pool"/"rows"
// last-good fallbacks (a failed source degrades to its cache, never blanks the feed — the
// python loop got this from process state; the worker gets it from KV).
export async function runCycle(env, nowMs = Date.now()) {
  const kvGet = async (k) => { try { return await env.FEED.get(k); } catch { return null; } };

  let rows = await mutListing(nowMs);
  if (rows) await env.FEED.put("rows", JSON.stringify(rows));
  else rows = JSON.parse((await kvGet("rows")) || "[]");

  const leagues = Object.keys(LEAGUE_SPORT);
  const results = await Promise.all(leagues.map((lg) => scoreboard(lg)));
  const fetched = results.flat();

  // Pool = today's fetch merged over the cached pool (mirrors _state["slate"] accumulating),
  // pruned past the listing's own 9-day horizon. ponytail: a longer-lived event could bind an
  // ancient mut row in python; the PT-date gate makes the divergence cosmetic.
  const pool = {};
  try { for (const ev of JSON.parse((await kvGet("pool")) || "[]")) pool[ev.id] = ev; } catch {}
  for (const ev of fetched) pool[ev.id] = ev;
  const cutoff = nowMs - 9 * 86400e3;
  const poolEvents = Object.values(pool).filter((ev) => Date.parse(ev.start_utc || "") >= cutoff);
  await env.FEED.put("pool", JSON.stringify(poolEvents));
  const poolById = {};
  for (const ev of poolEvents) poolById[ev.id] = ev;

  let bindings = {};
  try { bindings = JSON.parse((await kvGet("bind")) || "{}") || {}; } catch {}
  const newBindings = bindRows(rows, poolById, bindings);

  const { live, day, report } = emit(rows, poolById, newBindings, nowMs);
  const payload = { t: nowMs, live, day, report };
  await env.FEED.put("feed", JSON.stringify(payload));
  if (JSON.stringify(newBindings) !== JSON.stringify(bindings))
    await env.FEED.put("bind", JSON.stringify(newBindings));
  return payload;
}

// ---------- handlers ----------
export default {
  async scheduled(event, env, ctx) {
    await runCycle(env); // ~31 subrequests (30 ESPN + 1 mut) + a few KV ops, < 40
  },
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    let payload = null;
    try { payload = JSON.parse(await env.FEED.get("feed") || "null"); } catch {}
    if (!payload) payload = await runCycle(env); // first deploy: build inline
    else if (Date.now() - payload.t > 150_000) ctx.waitUntil(runCycle(env)); // cron missed → heal
    const out = path === "/live.json" ? payload.live
      : path === "/day.json" ? payload.day
      : path === "/report.json" ? payload.report : null;
    if (!out) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(out), {
      headers: {
        "content-type": "application/json",
        "cache-control": "max-age=10",
        "access-control-allow-origin": "*",
      },
    });
  },
};
