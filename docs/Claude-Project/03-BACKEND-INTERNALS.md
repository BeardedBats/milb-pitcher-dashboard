# Baseball Dashboard — Backend Internals

> **Purpose of this doc:** How the backend actually works under the hood — aggregation functions, data fetching, caching strategy, reclassification flow, and key formulas. Read this before modifying `backend/aggregation.py` or `backend/data.py` or anything cache-related.

---

## File map

| File | Role |
|---|---|
| `backend/app.py` | FastAPI app + all route handlers |
| `backend/aggregation.py` | Pitch/results aggregation, pitcher card builder, game log |
| `backend/data.py` | Data fetching (Savant CSV, MLB Stats API), caching, warmup, boxscore lookups, overrides |
| `backend/redis_cache.py` | Upstash Redis wrapper (`get`, `set`, `delete`, TTL support) |
| `backend/pitch_overrides.json` | Local fallback for pitch reclassifications (Redis is primary) |
| `api/index.py` | Vercel serverless entry — wraps FastAPI app |

---

## Aggregation layer (`backend/aggregation.py`)

### Core preparation

**`_prep_df(df)`** — adds computed boolean/scalar columns used by all aggregators:
- `in_zone` (pitch inside strike zone from plate_x/z + sz_top/bot)
- `is_swing`, `is_whiff`, `is_called_strike`, `is_strike`
- `havaa` (Height Adjusted Vertical Approach Angle)

### Primary aggregators

| Function | Returns | Notes |
|---|---|---|
| `_aggregate_pitch_df(df, full_df)` | list of pitch rows | Vectorized groupby. `full_df` passed separately so usage% is computed against the pitcher's full pitch count, not the filtered subset. |
| `aggregate_pitch_data(date_str, game_pk=None)` | pitch rows | Daily or single-game. |
| `aggregate_pitch_data_range(df)` | pitch rows | Multi-game range (already-fetched df). |
| `aggregate_pitcher_results(date_str, game_pk=None)` | result rows | IP from outs, hits/BB/K/HR from events. |
| `aggregate_pitcher_results_range(df)` | result rows | Uses boxscore for official stats; sorted by team then `appearance_order`. |

### Card + page builders

| Function | Returns |
|---|---|
| `get_pitcher_card(date_str, pitcher_id, game_pk)` | `{ pitcher_id, game_pk, name, team, hand, opponent, pitches: [...], sz_top, sz_bot, pitch_table, pitch_table_vs_l, pitch_table_vs_r, result, season_totals, game_weather }` |
| `get_pitcher_game_log(df, pitcher_id)` | `[{ game_pk, pitches, ip, hits, bbs, ks, hrs, er, runs, whiffs, csw_pct, strike_pct, par_pct, decision, ... }]` |
| `build_pitches_list(pdf)` | JSON-safe pitch list (pfx converted to inches, NaN → None, unknown columns dropped) |
| `get_season_averages(pitcher_id, season_year, before_date=None, exclude_game_pk=None)` | `{ pitch_type: { count, velo, usage, ivb, ihb, cs_pct, ... } }` |
| `find_previous_mlb_season(pitcher_id, season)` | year or None — for `auto_fallback` when current season has no data |

### Key metric formulas

| Metric | Formula | Notes |
|---|---|---|
| **IVB** (Induced Vertical Break) | `pfx_z * 12` | Inches. Already sign-correct for display. |
| **IHB** (Induced Horizontal Break) | `-pfx_x * 12` | Inches, sign-flipped so positive = armside for RHP. |
| **Extension** | `release_extension` | Feet. |
| **HAVAA** | Derived from `vy0, vz0, ay, az, plate_z, sz_top, sz_bot` | Height Adjusted Vertical Approach Angle. |
| **Arm angle** | Hawk-Eye native if present, else `4.45 * abs(x) + 23.64 * z - 106.0` | Approximation from release_pos_x/z when Hawk-Eye missing. |
| **Usage%** | `pitch_type_count / pitcher_total_count * 100` | |
| **Whiff% / SwStr%** | `whiffs / total * 100` | |
| **CSW%** | `(called_strikes + whiffs) / total * 100` | |
| **Strike%** | `strikes / total * 100` | |
| **PAR%** | `strikeouts_on_pitch / pitches_of_type_in_2strike_counts * 100` | |
| **Zone%** | `in_zone / total * 100` | |
| **O-Swing%** | `swings_out_of_zone / pitches_out_of_zone * 100` | |

---

## Data layer (`backend/data.py`)

### Fetch functions

| Function | Source | Output |
|---|---|---|
| `fetch_date(date_str)` | Savant CSV `/statcast_search/csv` + MLB Stats API | DataFrame for 1 day |
| `fetch_date_range(start_date, end_date)` | `fetch_date` per-day (parallel) | Concatenated DataFrame |
| `fetch_pitcher_season(pitcher_id, season_year)` | `fetch_date_range` for Mar 25 → today | Single pitcher's season |
| `fetch_all_pitchers_list_materialized(start_date, end_date)` | Extracted from materialized range | `[{ pitcher_id, name, name_norm, ... }, ...]` |
| `prefetch_boxscores(game_pks)` | MLB Stats API per-game (parallel) | Boxscore dict by game_pk |
| `get_game_linescore(game_pk)` | MLB Stats API game feed | Linescore + PBP |

### Data normalization steps (on fetch)

1. **Team assignment** — `_assign_teams_vectorized(df)` uses `inning_topbot` + `home_team`/`away_team`:
   - Top of inning: pitcher_team = home, opponent = away
   - Bottom of inning: pitcher_team = away, opponent = home
2. **Name fixing** — "Last, First" → "First Last" via regex
3. **Pitch name mapping** — 2-letter code (FF) ↔ human name (Four-Seamer) — see pitch type table below
4. **Overrides applied** — if a pitch has a reclassification override, its `pitch_type` and `pitch_name` are replaced in-memory before aggregation
5. **Batter names resolved** — batter IDs → names via batched MLB Stats API call, cached in Redis `batter_names`

### Pitch type code ↔ name mapping

| Code | Name |
|---|---|
| FF | Four-Seamer |
| SI | Sinker |
| FC | Cutter |
| SL | Slider |
| ST | Sweeper |
| CU | Curveball |
| KC | Knuckle Curve |
| CH | Changeup |
| FS | Splitter |
| FO | Forkball |
| SC | Screwball |
| KN | Knuckleball |
| EP | Eephus |

### Relevant Savant columns loaded

`pitch_type`, `pitch_name`, `release_speed`, `release_extension`, `description`, `zone`, `plate_x`, `plate_z`, `pfx_x`, `pfx_z`, `vx0`, `vy0`, `vz0`, `ax`, `ay`, `az`, `arm_angle`, `release_pos_x`, `release_pos_z`, `events`, `hc_x`, `hc_y`, `launch_speed`, `launch_angle`, `stand` (batter hand), `at_bat_number`, `pitch_number`, `outs_when_up`, `balls`, `strikes`, `on_1b`, `on_2b`, `on_3b`, `inning`, `inning_topbot`, `game_pk`, `game_date`, `des`, `home_team`, `away_team`, `sz_top`, `sz_bot`, `player_name` (pitcher), `pitcher` (id), `p_throws`, `pitcher_team`, `opponent`, `batter`, `batter_name`.

---

## Cache system

### Two tiers

- **L1 (in-memory, per-process):** `_cache`, `_season_cache`, `_batter_name_cache` dicts in `data.py`. Fast, non-persistent.
- **L2 (Redis via Upstash):** Persistent, cross-process, JSON-serialized. Survives Vercel cold starts.

Read path: L1 → L2 → origin (Savant/MLB API). Write path: origin → L2 → L1.

### Cache keys (Redis)

All aggregation results are stored under an `agg:` prefix.

```
overrides                                                     # All pitch reclassifications (dict)
override_version                                              # Int counter — bumped on every save/delete
batter_names                                                  # { batter_id: "Full Name" }
last_refresh                                                  # ISO timestamp
schedule:{date}                                               # MLB Stats API schedule cache (TTL 120s)
boxscore:{game_pk}, gamestate:{game_pk}, feed:{game_pk}       # Per-game from MLB Stats API
pitchers:{start}_{end}                                        # Deduped pitcher list cache
live_cards_active:{date}                                      # Live-cards cron state
live_cards_done:{date}                                        # Live-cards cron state

# Aggregation results (all wrapped as agg:{key} in Redis):
agg:daily_pitch_{date}
agg:daily_results_s{CARD_SCHEMA_VERSION}_{date}
agg:card_{date}_{pitcher_id}_{game_pk}_v{override_version}_s{CARD_SCHEMA_VERSION}
agg:season_totals_{pitcher_id}_s{CARD_SCHEMA_VERSION}[_custom]
agg:season_avg_{pitcher_id}_{season}[_b{before_date}][_x{exclude_game_pk}]
agg:season_avg_fb_{pitcher_id}_{season}[_suffix]              # Fallback (auto_fallback=true, walks back through prior seasons)
agg:player_v2_{pitcher_id}_s{CARD_SCHEMA_VERSION}[_custom]
agg:team_{team}_{view}_{start}_{end}
agg:leaderboard_results_{start}_{end}
agg:leaderboard_pitch-data_{start}_{end}
```

### CARD_SCHEMA_VERSION

Integer constant in `data.py`. Bump when:
- Pitcher card response shape changes
- Player page response shape changes
- Season totals shape changes

Any key embedding `_s{CARD_SCHEMA_VERSION}` is automatically invalidated on bump — no manual clear needed.

### override_version

Integer counter persisted in Redis. Incremented on every `POST`/`DELETE /api/pitch-reclassify`. Embedded in card cache keys as `_v{override_version}`. On any reclassification:

1. Save override to Redis + JSON
2. Bump `override_version` in Redis
3. Clear `daily_pitch_{date}` and `daily_results_{date}` (those don't embed the version)
4. Next card/totals fetch misses cache (new key) → recomputes with override applied

### TTLs

| Key pattern | TTL | Reason |
|---|---|---|
| `game_{game_pk}` | 60s (live games) | Live data should be fresh |
| Most other keys | No TTL | Busted via schema version or manual clear |

### Warmup strategy

- **Local dev:** `start_warmup(start_date="2026-03-25")` on uvicorn startup; pre-fetches recent dates in background thread.
- **Vercel:** Cron jobs handle warmup (see [01-ARCHITECTURE.md](01-ARCHITECTURE.md#vercel-cron-schedule-utc)). Cold-start serverless invocations fetch on-demand from Redis.
- **Bulk seeding:** `bulk_warmup.py` (repo root) computes cards + player pages for a date range and writes directly to Redis. Use after schema bumps or when seeding a new Redis instance.

---

## Pitch reclassification flow

End-to-end, when a user clicks a pitch on the strike zone plot and picks a new type:

```
Frontend                           Backend                         Redis
────────                           ───────                         ─────
User clicks pitch
  → ReclassifyModal opens
  → User picks new pitch type
  → utils/api.js: reclassifyPitch(...)
     POST /api/pitch-reclassify ──→ app.py: pitch_reclassify()
                                      ↓
                                      save to overrides dict  ──→  SET overrides
                                      ↓
                                      write pitch_overrides.json (fallback)
                                      ↓
                                      INCR override_version  ────→ SET override_version
                                      ↓
                                      DEL daily_pitch_{date}  ───→ DEL
                                      DEL daily_results_{date} ──→ DEL
                                      ↓
                                      return { status: "ok" }
  ← response
  Refetch pitcher-card ─────────→ cache miss (new _v{version}) → rebuild with overrides → SET new key
  ← updated card
```

**Undo:** `DELETE /api/pitch-reclassify` removes the override, bumps version, clears daily caches.

**Override application point:** In `data.py` during fetch normalization. Overrides dict is loaded once at startup (or on first access), then applied row-by-row as DataFrames are built. This means aggregators never need to know about overrides — they see already-corrected pitch types.

**Override key format:** `{game_pk}_{pitcher_id}_{at_bat}_{pitch_num}`.

---

## Error handling conventions

- Missing Savant data for a date returns empty DataFrame, not an error.
- NaN values scrubbed to `None` before JSON serialization.
- Batter name lookup failure → empty string (not null), so frontend doesn't crash on concat.
- Boxscore fetch failure → falls back to Statcast-derived stats (less accurate but available).
- Override version fetch failure → defaults to `0`.

## Performance notes

- `fetch_date_range` parallelizes per-date fetches with ThreadPoolExecutor (default 8 workers).
- `prefetch_boxscores` parallelizes per-game (default 8 workers).
- `_aggregate_pitch_df` is fully vectorized (pandas groupby) — no Python loops.
- Pitcher card endpoint is the hottest path — expect ~50ms L2 hit, ~500ms cold compute (depends on game length).
