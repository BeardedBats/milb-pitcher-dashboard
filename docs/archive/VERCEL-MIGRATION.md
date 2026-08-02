# Vercel + Redis Migration Plan

## Overview

Move the Pitcher Dashboard from Railway (persistent Docker container) to Vercel (serverless Python functions) with Upstash Redis for caching. Replace the auto-refreshing TTL cache with a manual refresh button + three daily cron warmups. Remove the Leaderboard page entirely (Team pages stay). Pitch reclassification overrides move from disk JSON to Redis.

---

## Part 1: Vercel Account Setup (you do this in the browser)

1. Go to https://vercel.com/dashboard
2. Click "Add New Project" and import the `baseball-dashboard` GitHub repo
3. In **Build & Development Settings**, set:
   - **Framework Preset**: Other
   - **Build Command**: `cd frontend && npm install && npm run build`
   - **Output Directory**: `frontend/build`
   - **Install Command**: leave blank (handled in build command)
4. Do NOT deploy yet — you need the config files first (Part 3)

## Part 2: Upstash Redis Setup (you do this in the browser)

1. From your Vercel project dashboard, go to the **Storage** tab
2. Click **Create Database** → choose **Upstash Redis** (KV)
3. Name it something like `pitcher-dashboard-cache`
4. Select the region closest to you (e.g., `us-east-1`)
5. Click **Create** — Vercel auto-injects these environment variables:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
6. Note: The free tier gives you 10,000 commands/day, 256MB storage

## Part 3: Files I will create/modify

### New files to create:

**`vercel.json`** — Project configuration telling Vercel how to route requests:
- All `/api/*` requests → Python serverless function (your FastAPI backend)
- All other requests → static React frontend files
- Three cron job definitions: 5am ET, 5pm ET, 10pm ET
- Note: Vercel cron uses UTC, so 5am ET = 10:00 UTC, 5pm ET = 22:00 UTC, 10pm ET = 03:00 UTC (next day)

**`api/index.py`** — Entry point that Vercel's Python runtime uses to find your FastAPI app. This is a thin wrapper that imports your existing `app` from `backend/app.py` and exposes it via Mangum (an adapter that converts AWS Lambda/Vercel events into ASGI requests that FastAPI understands).

**`api/cron/warmup.py`** — The cron endpoint. Vercel calls this on schedule. It triggers the same warmup logic you already have, but adapted for serverless: fetches from Savant, aggregates, and stores everything in Redis.

**`backend/redis_cache.py`** — New module that replaces all the in-memory dict caches (`_cache`, `_range_cache`, `_agg_cache`, `_boxscore_cache`, `_feed_cache`, etc.) with Redis get/set calls. Uses `upstash-redis` Python SDK. Serializes DataFrames as compressed JSON for storage. Each cache entry gets a Redis key like `savant:2026-03-22` or `agg:card_2026-03-22_12345_789`.

### Files to modify:

**`backend/data.py`** — The biggest change. Every function that reads/writes to `_cache`, `_range_cache`, `_agg_cache`, `_boxscore_cache`, `_feed_cache`, `_schedule_cache`, `_season_cache`, `_batter_name_cache`, or `_pitchers_list_cache` gets updated to call the Redis cache module instead of dict lookups. The `LIVE_CACHE_TTL` auto-expiry logic goes away entirely — data only refreshes on cron or manual refresh. The `start_warmup()` background thread is removed (cron replaces it). Pitch reclassification overrides (`_overrides`, `_load_overrides`, `_save_overrides`) switch from file I/O to Redis get/set.

**`backend/app.py`** — Add a `/api/refresh` POST endpoint (the backend handler for the refresh button). Add a `/api/cron/warmup` GET endpoint (what Vercel cron hits). Remove the `@app.on_event("startup")` warmup since there's no persistent process. Add a `/api/last-refresh` GET endpoint that returns the timestamp of the last data refresh from Redis.

**`backend/requirements.txt`** — Add `upstash-redis` and `mangum` packages.

**`frontend/src/App.jsx`** — Remove the Leaderboard button, `navigateToLeaderboard`, the `LeaderboardPage` lazy import, and the Leaderboard rendering block. Add a refresh button (single clickable element containing both the "Last updated: X" timestamp and a refresh icon). While refreshing: show a spinner inside the button. After refreshing: show a brief "Data refreshed" toast notification that auto-dismisses.

**`frontend/src/components/LeaderboardPage.jsx`** — Delete this file entirely.

**`frontend/src/utils/api.js`** — Add `fetchRefresh()` and `fetchLastRefresh()` API functions.

**`push-update.bat`** — Change the echo message from "Railway" to "Vercel".

**`Dockerfile`** — Can be left as-is (still works for local/Electron builds) but is no longer used for deployment.

### Files to delete:

- `railway.toml` — Railway-specific config, no longer needed
- `render.yaml` — Render-specific config, no longer needed

---

## Part 4: How the caching model changes

### Before (Railway):
- Server starts → background thread fetches all Savant data and pre-caches
- `_cache` dict holds DataFrames in memory, TTL expires every 60s for today
- Every user request checks the dict — cache miss fetches from Savant live
- Server stays running, cache persists indefinitely

### After (Vercel + Redis):
- **Cron jobs** (5am, 5pm, 10pm ET) call `/api/cron/warmup`, which:
  1. Fetches the smart default date from MLB schedule
  2. Pulls Savant CSV for that date + MLB API fallback
  3. Stores the raw DataFrame (serialized) in Redis under `savant:{date}`
  4. Pre-computes aggregations (daily pitch data, results) and stores in Redis
  5. Pre-fetches boxscores and linescores for all games
  6. Stores a `last_refresh` timestamp in Redis
- **User requests** hit the serverless function, which:
  1. Checks Redis for cached data (1 GET command)
  2. If found → returns immediately (fast, ~50ms)
  3. If not found → fetches from Savant (slow, 2-5s), stores in Redis, returns
- **Refresh button** calls `/api/refresh`, which:
  1. Clears relevant Redis keys for today's date
  2. Re-fetches from Savant and re-caches everything
  3. Returns the new `last_refresh` timestamp
  4. Frontend shows a brief "Data refreshed" toast, then updates the timestamp display

### Redis key structure:
```
savant:{date}              → serialized DataFrame (compressed)
agg:daily_pitch_{date}     → JSON list (pitcher results aggregation)
agg:daily_results_{date}   → JSON list (pitch data aggregation)
agg:card_{date}_{pid}_{gp} → JSON dict (pitcher card)
agg:player_v2_{pid}_{s}_{e}→ JSON dict (player page)
agg:season_avg_{pid}_{yr}  → JSON dict (season averages)
agg:season_totals_{...}    → JSON dict (season totals)
agg:team_{...}             → JSON list (team page)
boxscore:{game_pk}         → JSON dict (boxscore stats)
feed:{game_pk}             → JSON dict (game feed/linescore)
schedule:{date}            → JSON list (MLB schedule)
batter_names               → JSON dict (batter ID → name map)
overrides                  → JSON dict (pitch reclassification overrides)
last_refresh               → ISO timestamp string
```

---

## Part 5: What the refresh button looks like in the UI

Where the Leaderboard button currently sits in the header nav, there will be a single clickable button containing:
- A refresh icon (↻) on the left
- "Last updated: 5:00 PM" text on the right

Behavior:
- **Click** → calls `/api/refresh`, icon spins while loading
- **On success** → a toast notification "Data refreshed" slides in briefly (auto-dismisses after ~3 seconds), timestamp updates to "Last updated: just now"
- **On error** → toast shows "Refresh failed" in red

---

## Part 6: Estimated Redis usage

Per cron warmup (~3x/day):
- ~15-20 SET commands (one per game's data, plus aggregations)
- Total: ~50-60 writes/day from crons

Per user browsing session (100 clicks):
- ~250 GET commands (2-3 per page navigation)

Per manual refresh:
- ~20-30 commands (DEL + SET for each key)

**Budget**: 10,000 free commands/day supports ~38 heavy browsing sessions + 3 crons + occasional refreshes. More than enough for personal use.

---

## Part 7: Things that change in serverless (and their solutions)

| Feature | Railway (now) | Vercel (after) |
|---|---|---|
| Startup warmup | Background thread on boot | Three daily cron jobs (5am, 5pm, 10pm ET) |
| In-memory cache | Python dicts, instant | Redis, ~5ms per lookup |
| Pitch reclassification | Writes to `pitch_overrides.json` on disk | Stores in Redis (same UX, just different backend storage) |
| Live data auto-refresh | 60s TTL auto-refetch | Manual refresh button only |
| Leaderboard page | Accessible via header button | Removed entirely |

---

## Part 8: Step-by-step execution order

When you're ready for me to build this, the order would be:

1. **You**: Create the Vercel project + Upstash Redis in the Vercel dashboard (Parts 1 & 2)
2. **You**: Give me the go-ahead
3. **Me**: Create `vercel.json`, `api/index.py`, `api/cron/warmup.py`
4. **Me**: Create `backend/redis_cache.py` (the Redis abstraction layer)
5. **Me**: Refactor `backend/data.py` to use Redis instead of dicts, move overrides to Redis
6. **Me**: Update `backend/app.py` with refresh + cron endpoints, remove startup warmup
7. **Me**: Update frontend — remove Leaderboard entirely, add refresh button + toast
8. **Me**: Update `push-update.bat`, `requirements.txt`, delete `railway.toml` & `render.yaml`
9. **You**: Push to GitHub → Vercel auto-deploys
10. **You**: Verify the deploy, test the refresh button, check cron runs in Vercel dashboard
11. **You**: Delete the Railway project when satisfied
