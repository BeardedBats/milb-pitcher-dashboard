# DECISIONS

One line per ambiguous call: what was chosen, and why.

## Phase 0 — data-source verification

- **Minors Savant CSV requires `&minors=true`** — the spec's URL (same params as `SAVANT_CSV_URL`, `hfLevel` empty) silently returns **MLB** rows from `/statcast-search-minors/csv`; Savant's own bundle appends `&minors=true&wbc=false` to every CSV download. Verified: without it, 2026-07-30 → 10 MLB game_pks (822946 = NYY @ CWS, sportId 1); with it → 23 MiLB game_pks.
- **AAA Savant coverage on 2026-07-30 is 18/18, not 10/15** — the spec's "misses some AAA games" finding was an artifact of the broken URL. With `&minors=true&hfLevel=AAA|` the CSV returns exactly the 18 game_pks on the sportId=11 schedule. The MLB-live-feed backfill is still implemented as specified (coverage rule is locked) but now acts as a safety net rather than the primary gap-filler.
- **Fetch with `hfLevel` empty, then filter by level from the schedule** — per spec. The unfiltered minors CSV also returns Single-A (Florida State League) tracked-park rows; every row is tagged with its true level from the per-level statsapi schedules and the pitch pipeline keeps only AAA + AFL, so no A-ball pitch views leak in.
- **AFL has no Savant statcast rows** — verified against 2025-10-15 (3 AFL games on sportId=17/leagueId=119, 0 minors CSV rows). The spec's "try the savant card first, else box-score card" order is implemented as written; in practice the box-score fallback is the operative path for AFL.
- **Arm-angle leaderboard fetch deleted** — the minors CSV ships per-pitch `arm_angle` populated on 99.5% of rows (2026-07-30 AAA), so `_fetch_arm_angle_map` / `get_arm_angle` are dead weight.
- **Multi-level game log sourced from `/people/{id}/stats?stats=gameLog&sportId=N`** rather than assembled from box scores. It returns every field the adapted table needs (`inningsPitched`, `hits`, `runs`, `earnedRuns`, `baseOnBalls`, `strikeOuts`, `homeRuns`, `battersFaced`, `numberOfPitches`, `strikes`, `groundOuts`, `airOuts`, decision fields, `isHome`, `opponent`, `game.gamePk`) in one call per level, which is what the spec prescribes.
- **`GO/AO` = `groundOuts / airOuts`, `Str%` = `strikes / numberOfPitches`** — both straight from the gameLog `stat` block; no derived metrics invented beyond these.

## Phase 1 — fork cleanup

- **Range materialization now runs in-process** (`data.queue_range_materialization` spawns a daemon thread; status lives in a module dict, not Redis). Upstream it queued into Redis for a Vercel cron to drain; with the crons deleted and Redis optional locally, that queue would never drain and every season-range endpoint would 202 "rebuilding" forever.
- **`api/requirements.txt` moved to `backend/requirements.txt`** rather than deleted with `api/` — it is the canonical pinned dep set and `requirements-dev.txt` includes it.
- **`test_endpoint_guards.py` kept, cron/materialize bearer-auth cases dropped** — the 20 failing cases only covered deleted endpoints; the date-validation cases still guard live middleware and stay green.
- **Weather line and next-starts strip removed from `PitcherHeader`/`PlayerPage`, not just hidden** — both were MLB-only (hardcoded MLB stadium coords; a Google Sheet of MLB probables) with no MiLB equivalent.
- **Ports unchanged (backend 8000, frontend 3847)** — spec locks 3847, so the two dashboards cannot run simultaneously; the launchers get distinct window titles as specified. `Pitcher Dashboard.vbs` renamed to `MiLB Pitcher Dashboard.vbs`.
- **`_IS_SERVERLESS` deleted** — with no Vercel target, `on_startup` always warms up.

## Phase 2 — data layer

- **All three Savant URLs switched to the minors endpoint**, not just the daily one: `SAVANT_CSV_URL`, `SAVANT_RANGE_URL` and `SAVANT_PITCHER_SEASON_URL` all now hit `/statcast-search-minors/csv` with `minors=true`. Leaving the range/season URLs on the MLB endpoint would have made player pages and season averages silently major-league.
- **`hfGT` narrowed to `R|PO`** — minors game types are only regular season and playoffs; the MLB set (`S|E|W|D|L|F`) returns nothing from the minors endpoint.
- **New `backend/levels.py`** is the single owner of "AAA means sportId 11", the org map, and `(org, level)` team display. Nothing else hardcodes a sportId.
- **Org map keyed by `(level, abbrev)`, not `abbrev`** — MiLB abbreviations are not unique across levels (`COL` is both Columbia Fireflies at A and the Rockies' MLB abbrev). `team_id` is preferred wherever the schedule provides it.
- **AFL clubs have no parent org** (`parentOrgName` = "Office of the Commissioner"), so their `org` is None and `team_display_name` falls back to `<name> (AFL)`.
- **Level is resolved per game_pk from the schedules, not from the CSV** — the minors CSV has no level column. `_apply_levels` (single date) and `_apply_levels_multi_date` (range/season) tag every row and drop anything outside AAA/AFL.
- **A total schedule-fetch failure drops the day's rows rather than passing them through untagged** — showing Single-A games labeled AAA is worse than showing nothing and retrying.
- **Cache keys carry a level scope**: `games_{level}_{date}`, `schedule:{date}:{level}`, `daily_pitch_{level}_{date}`, `daily_results_{level}_s{VER}_{date}`, `daily_results_box_{level}_...`, `game_view_{level}_{date}_{pk}`. The pitch pipeline spans all Statcast levels at once, so `range_day` uses the set token `lvlAAA-AFL`.
- **`CARD_SCHEMA_VERSION` 43 → 44** — nothing cached under 43 describes minor-league games.
- **New `backend/boxscore_levels.py`** serves non-Statcast levels from the box score and the per-level gameLog. `role` is `SP` when the box score reports `gamesStarted == 1` (or the pitcher appeared first), matching the Statcast pipeline's first-pitcher rule, so the existing `row.role === "SP"` filter keeps working.
- **`arm_angle` is absent from pitch-table rows** — that is pre-existing upstream behavior (`_aggregate_pitch_df` never emitted it; only the card's `build_pitches_list` resolves arm angle), not a MiLB regression.

## Phase 3 — main game log

- **`AdaptedResultsTable` is a new component, not a stripped-down `PitcherResultsTable`** — the existing table is built around CSW%/whiffs/velo-delta columns that do not exist below AAA; threading "hide half the columns" through it would degrade both.
- **Level persists in localStorage (`pl_milb_level`), org too (`pl_milb_org`)** — matches the existing `usePersistentState` convention used by the pitch-mix display modes.
- **Changing level clears the selected game** — a `game_pk` from the AAA slate has no meaning on the AA slate.
- **The Pitch Data tab is hidden (not disabled) below AAA** — there is no pitch data to show, and a disabled tab invites clicking.
- **Org filter is client-side** — rows already carry `org`, so filtering needs no extra round-trip.

## Phase 4 — player pages

- **The box-score gameLog is the spine of the merged log; Savant enriches it** — only the gameLog sees AA/A+/A/R at all, so making Savant the spine would have dropped every sub-AAA game.
- **The Savant frame is filtered to `level == "AAA"` before any summary is computed** — otherwise an AFL outing would land inside a pitcher's regular-season pitch mix (fetch returns all Statcast levels).
- **Zero-AAA hides the Savant table by OMITTING the keys, not sending `[]`** — spec says hide entirely, and an absent key gives the frontend nothing to render; `hasSavant` checks `Array.isArray(data.pitch_summary)`.
- **Identity falls back to the MLB people endpoint** — a pitcher with no AAA games has no Savant rows, so name/hand had nowhere to come from and the page rendered nameless.
- **`results_summary` is recomputed from the merged log**, so it reflects every level rather than AAA only.

## Phase 5 — cards + team pages

- **`card_type` (`"statcast"` | `"boxscore"`) is on every card** so the frontend branches on an explicit field instead of inferring from an empty `pitches` array.
- **The box-score card ships empty `pitches`/`pitch_table*` lists rather than omitting them** — unlike the player page (where absence is the spec'd signal), keeping the keys makes every downstream `.map` safe.
- **`/api/org-page` is a new endpoint rather than reusing `/api/team-pitchers`** — team pages route per MLB org and need an ordered multi-affiliate payload, which the single-team endpoint's flat array cannot express.
- **`/api/org-page` returns 202 while the season range warms** instead of an empty AAA table, which would read as "this org has no pitchers."
- **The header Teams dropdown lists backend `all_orgs()` (30), not `TEAMS_LIST` (57)** — the latter still carries WBC and legacy-MLB entries that have no farm system.
- **AFL is excluded from org pages** — its clubs report `parentOrgName: "Office of the Commissioner"`, so they belong to no org.
