# nmfeed

Sports feed for the NM apps: pulls [ESPN's public scoreboard API](https://site.web.api.espn.com) and
[mut.st](https://mut.st)'s listing, matches them (accent-folded token scoring, PT-date gating), and
publishes `live.json` / `day.json` / `report.json` into `docs/` every 5 minutes via GitHub Actions.

- Feed URL (for clients): <https://raw.githubusercontent.com/Kainkle/nmfeed/main/docs/live.json>
- Day view: `.../docs/day.json`
- Build diagnostics: `.../docs/report.json`

`live.json` carries `generated_utc` and `refresh_s` — age-gate rows on `generated_utc`; the raw
CDN edge caches for up to 5 minutes.

Everything here is generated from public data. No secrets, no keys, no private endpoints.

## Layout

- `worker/worker.js` — the whole pipeline (fetch → normalize → match → emit) as one dependency-free
  ESM module. It is also the source used by the (parked) Cloudflare Worker port, so the JS stays the
  single source of truth for the feed logic.
- `scripts/build.mjs` — runs one cycle with an in-memory store and writes the JSONs.
- `.github/workflows/feed.yml` — the 5-minute cron.
- `.github/workflows/keepalive.yml` — weekly commit so GitHub never auto-disables the schedule
  (60-day inactivity rule).

## Local run

```
node scripts/build.mjs docs
```
