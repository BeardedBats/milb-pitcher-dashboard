# Baseball Dashboard — Backend API

> **Purpose of this doc:** Every HTTP endpoint exposed by the FastAPI backend, with method, query params, response shape, and cache key. This is the authoritative list — use it before adding a new endpoint to avoid duplicate routes or shape drift.

All endpoints live in `backend/app.py`. Rewritten by Vercel via `/api/:path*` → `api/index.py`.

---

## Core data endpoints

### `GET /api/default-date`
Returns today's date in ET (string `YYYY-MM-DD`).
- **Params:** none
- **Returns:** `{ "date": "2026-04-21" }`
- **Cache:** none

### `GET /api/warmup-status`
Startup warmup progress. Used by frontend loading screen.
- **Params:** none
- **Returns:** `{ "ready": bool, "loading": bool, "error": str|null, "progress": { ... } }`
- **Cache:** none

### `GET /api/games`
Games for a date. Live status from MLB Stats API.
- **Params:** `date` (YYYY-MM-DD)
- **Returns:** `[{ game_pk, home, away, status, ... }]`
- **Cache:** none (live)

### `GET /api/pitch-data`
Aggregated pitch stats by pitcher × pitch type × game.
- **Params:** `date`, `game_pk?`
- **Returns:** array of pitch rows — see [05-DATA-SCHEMAS.md](05-DATA-SCHEMAS.md#pitch-data-aggregation)
- **Cache:** `agg:daily_pitch_{date}` (Redis)

### `GET /api/pitcher-results`
Pitcher box-score-style results (IP, ER, K, W/L).
- **Params:** `date`, `game_pk?`
- **Returns:** array of result rows
- **Cache:** `agg:daily_results_s{CARD_SCHEMA_VERSION}_{date}` (Redis)

### `GET /api/initial-load`
Combined `/api/default-date` + `/api/games` + `/api/pitch-data` + `/api/pitcher-results` for today. Reduces first-paint round-trips.
- **Params:** none
- **Returns:** `{ date, games, pitchData, resultsData }`
- **Cache:** composed (underlying pieces cached individually)

---

## Pitcher card / player endpoints

### `GET /api/pitcher-card`
Full pitcher card (pitches list, aggregated tables, result row, season totals, weather).
- **Params:** `date`, `pitcher_id`, `game_pk`
- **Returns:** card object — see [05-DATA-SCHEMAS.md](05-DATA-SCHEMAS.md#pitcher-card-response)
- **Cache:** `agg:card_{date}_{pitcher_id}_{game_pk}_v{override_version}_s{CARD_SCHEMA_VERSION}`

### `GET /api/pitcher-season-totals`
Pitcher's season-to-date box-score row.
- **Params:** `pitcher_id`, `start_date="2026-03-25"`, `end_date=""` (resolves to today ET)
- **Returns:** `{ ip, hits, bbs, ks, hrs, er, runs, batters_faced, whiffs, swstr_pct, csw_pct, strike_pct, par_pct, games, ... }`
- **Cache:** `agg:season_totals_{pitcher_id}_s{CARD_SCHEMA_VERSION}[_custom]` (stable key — `_custom` appended only for non-canonical date ranges)

### `GET /api/game-linescore`
Linescore + play-by-play for one game.
- **Params:** `game_pk`
- **Returns:** `{ home_team, away_team, home_score, away_score, inning, top_bottom, status, play_by_play: [...] }`
- **Cache:** `game_{game_pk}` (Redis, TTL 60s for live games)

### `GET /api/season-averages`
Per-pitch-type season averages for a pitcher. Used on the card to show "vs season avg" comparisons.
- **Params:** `pitcher_id`, `season`, `before_date?`, `exclude_game_pk?`, `auto_fallback?` (boolean — falls back to prior MLB season if current season has no data)
- **Returns:** `{ season: int, averages: { "FF": { count, velo, usage, ivb, ihb, ... }, "SL": { ... }, ... } }`
- **Cache:** `agg:season_avg_{pitcher_id}_{season}[_suffix]` (suffix encodes filters)

### `GET /api/player-page`
Full player page: info, pitch summary (all + vs L + vs R), results summary, game log.
- **Params:** `pitcher_id`, `start_date="2026-03-25"`, `end_date=""`
- **Returns:** `{ info, pitch_summary, pitch_summary_vs_l, pitch_summary_vs_r, results_summary, game_log }` — see [05-DATA-SCHEMAS.md](05-DATA-SCHEMAS.md#player-page-response)
- **Cache:** `agg:player_v2_{pitcher_id}_s{CARD_SCHEMA_VERSION}[_custom]` (stable key — `_custom` appended only for non-canonical date ranges)

---

## Search & team endpoints

### `GET /api/pitchers-search`
Typeahead pitcher search. Accent-insensitive.
- **Params:** `q`, `start_date`, `end_date`
- **Returns:** `[{ pitcher_id, name }]` (max 20)

### `GET /api/resolve-pitcher`
Resolve a name to a pitcher_id (for URL-based lookups).
- **Params:** `name`, `start_date`, `end_date`
- **Returns:** `{ pitcher_id, name }`

### `GET /api/team-pitchers`
All pitchers for a team, aggregated over a date range.
- **Params:** `team` (abbrev), `start_date`, `end_date`, `view="results"|"pitch-data"`
- **Returns:** array of result rows OR pitch rows depending on `view`
- **Cache:** `agg:team_{team}_{view}_{start}_{end}`

---

## Reclassification endpoints

Used to manually override a pitch's classification (e.g., Savant misclassified a cutter as a slider).

### `POST /api/pitch-reclassify`
Save a pitch override.
- **Body:** `{ game_pk, pitcher_id, at_bat_number, pitch_number, new_pitch_type, date }`
- **Returns:** `{ status: "ok", key }`
- **Side effect:** Increments `_override_version` in Redis (busts all dependent card/totals caches); also writes to `backend/pitch_overrides.json` as fallback.

### `DELETE /api/pitch-reclassify`
Undo a pitch override.
- **Params:** `game_pk`, `pitcher_id`, `at_bat_number`, `pitch_number`, `date`
- **Returns:** `{ status: "ok" }`
- **Side effect:** Increments override version, clears daily caches.

### `GET /api/pitch-overrides`
All current overrides (debug / export).
- **Returns:** `{ "{game_pk}_{pitcher_id}_{at_bat}_{pitch_num}": { new_type, new_name }, ... }`

### Override key format
`{game_pk}_{pitcher_id}_{at_bat_number}_{pitch_number}` — e.g.,
`745804_605400_3_2`.

---

## Admin / cache endpoints

### `POST /api/refresh`
Force a fresh fetch for today.
- **Returns:** `{ status, date, timestamp }`

### `GET /api/last-refresh`
ISO timestamp of last warmup. Displayed as "Last updated" in UI.
- **Returns:** `{ timestamp: "2026-04-21T14:30:00Z" }`

### `GET /api/clear-cache`
Clear all daily aggregations for a date.
- **Params:** `date`
- **Returns:** `{ status, cleared: [...] }`

### `GET /api/pitcher-schedule`
Game log lookup for a pitcher (by name).
- **Params:** `name`, `game_date?`
- **Returns:** schedule data

### `GET /api/leaderboard`
(See app.py for details — returns ranked pitchers by a given metric.)

---

## Cron endpoints

All cron endpoints validate Vercel's `Authorization` header. Called by Vercel's scheduler per `vercel.json`.

| Path | Schedule (UTC) | Purpose |
|---|---|---|
| `GET /api/cron/warmup` | `0 0-4,17-23 * * *` | Off-season hourly warmup |
| `GET /api/cron/warmup-daily` | `0 8 * * *` | Daily homepage-cache refresh (4:00 AM ET) |
| `GET /api/cron/warmup-daily-2` | `5 8 * * *` | Season-wide team aggregations (4:05 AM ET) |
| `GET /api/cron/warmup-daily-players` | `15 8 * * *` | Re-compute player pages for every pitcher who pitched yesterday |
| `GET /api/cron/warmup-daily-cards` | `30 8 * * *` | Pre-compute game feeds + season avgs + cards |
| `GET /api/cron/warmup-live-cards` | `*/10 16-23,0-5 * * *` | Live game card refresh every 10 min |

---

## Default dates

Hardcoded across backend (`app.py`) and frontend (`utils/api.js`):
- **Season start:** `2026-03-25`
- **Season end (default):** `""` → resolves to today (ET)

*Note: CLAUDE.md mentions `2026-02-10` for WBC inclusion, but actual code uses `2026-03-25`. The newer value wins — treat `2026-03-25` as canonical.*

## Response conventions

- All percentages returned as numbers 0–100 (e.g., `csw_pct: 67.2` means 67.2%), not 0–1.
- IP stored as string (`"7.1"` = 7⅓ innings).
- NaN/None scrubbed to `null` before JSON serialization.
- `pfx_x` / `pfx_z` returned in **inches** (already multiplied × 12). Raw Savant gives feet.
- `ihb` returned with display sign flip (`-pfx_x * 12`), so positive = armside for RHP.
