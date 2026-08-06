# MiLB Pitcher Dashboard

Fork of the MLB Pitcher Dashboard covering MINOR-league pitchers.
See BUILD-REPORT.md for what the fork changed and DECISIONS.md for why.

## Tech Stack
- Frontend: React 18 (Create React App), port 3847 in dev
- Backend: Python FastAPI — uvicorn locally, ONE Vercel serverless function (`api/index.py`) in production behind the `/api/*` rewrite

## Runtime
- Repo: `BeardedBats/milb-pitcher-dashboard` (private). Hosted on Vercel (Pitcher List team) + Upstash Redis. Pushing `main` auto-deploys to production; branches get previews. **Requires Vercel Pro** — `maxDuration: 300` and sub-daily crons are Pro-only.
- Env vars: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `CRON_SECRET`.
- **`vercel.json` MUST exist in the deployed branch.** A branch without it builds to an empty output in ~99ms and still reports READY — a silent no-op deploy. The import screen's suggested multi-service config is only a proposal and does nothing unless committed.
- Local launchers: `MiLB Pitcher Dashboard.vbs` (hidden + opens browser) and `start-dashboard.bat` (minimized windows). Ports match the MLB dashboard, so run only one of the two at a time.
- Cache: per-process in-memory dict (L1) + Upstash Redis (L2, `backend/redis_cache.py`). `CARD_SCHEMA_VERSION` in `backend/data.py` is embedded in cache keys — bump it whenever cached payload shape or cache semantics change, and add a line to its changelog comment.
- Range materialization is **queued into Redis** and drained by `/api/cron/materialize-ranges`. Do NOT convert this to a background thread: a Vercel function is frozen once its response is sent, so the thread may never finish and its status would be invisible to the next invocation.
- `on_startup` warms only when `_IS_SERVERLESS` is false. Never remove that guard — on Vercel it would start a full-season Savant fetch on every cold start.
- `backend/boxscore_levels.py` caches are two-tier (L1 dict + Redis via `_two_tier`). Cache DERIVED rows, never raw box scores — a full slate of raw payloads exceeds Upstash's per-request limit.
- **Two cache versions, not one.** `CARD_SCHEMA_VERSION` (data.py) covers the daily agg keys; `_METRICS_VERSION` (boxscore_levels.py) covers the per-game derived rows and pitch metrics, which have a 30-day TTL and sit BEHIND the daily keys. Changing a derived-row shape and bumping only `CARD_SCHEMA_VERSION` makes the daily key miss, recompute, and read stale rows straight back out — bump BOTH. The box daily key encodes both (`daily_results_box_{level}_s{VER}m{METRICS}_{date}`) so they cannot desync. Two traps seen for real: a bump is only effective if the resulting key STRING changes (replacing a literal `v2` with a constant set to `2` is a no-op), and requesting a date during a partial rollout re-poisons the fresh key from the old cache.

## Crons (9, in `vercel.json`)
Level-aware — the MLB originals assumed one slate a day.
- Daily jobs run 07:00–08:20 UTC at 20-min spacing. Two constraints: each job does ~6x the work now, and 09:00 UTC is 5:00 AM EDT, exactly the `get_default_date()` rollover, where a job would warm the wrong slate.
- `warmup-daily` loops all 6 levels under a deadline; `warmup-daily-cards` and both live crons are AAA+AFL only (no cards exist elsewhere).
- `_final_game_pks_for_date` must never hardcode `sportId=1`.
- Cron + `/api/materialize-*` endpoints fail CLOSED: unset `CRON_SECRET` means 401, not open.

## Levels — the core concept
`backend/levels.py` owns the level registry, the MLB parent-org map, and `(org, level)` team display names. Nothing else hardcodes a sportId.
- AAA=11, AA=12, A+=13, A=14, R=16, AFL=17 + leagueId 119. **MLB (sportId 1) is excluded everywhere.**
- `STATCAST_LEVELS = ("AAA", "AFL")` — only these get pitch tables, plots and game cards. Everything else is box-score only via `backend/boxscore_levels.py` and renders `AdaptedResultsTable`.
- **Level must be part of every date- or game-scoped cache key.** Existing keys: `games_{level}_{date}`, `schedule:{date}:{level}`, `daily_pitch_{level}_{date}`, `daily_results_{level}_s{VER}_{date}`, `daily_results_box_{level}_...`, `game_view_{level}_{date}_{pk}`, `range_day:{date}:lvlAAA-AFL:s{VER}`.
- Player pages include ALL levels; game cards exist only for AAA + AFL; the player-page Savant table is AAA-only and is **omitted from the payload entirely** when a pitcher has no AAA games.
- Current level = the level of the pitcher's LAST game. Never rosters, never active status.

## Savant minors endpoint — the one trap
`/statcast-search-minors/csv` **requires `&minors=true`**. Without that flag it silently returns MAJOR-league rows and everything looks superficially fine. All three Savant URLs in `data.py` (`SAVANT_CSV_URL`, `SAVANT_RANGE_URL`, `SAVANT_PITCHER_SEASON_URL`) carry it. Minors gameTypes are only `R|PO`. `hfLevel` is left empty and rows are level-tagged from the schedules instead (`_apply_levels` / `_apply_levels_multi_date`).

## Build & Verify
- Frontend build: `cd frontend && npx react-scripts build` (use 180s+ timeout — can be slow)
- Frontend tests: `cd frontend && npx react-scripts test --watchAll=false`
- Backend syntax check: `cd backend && python -c "import app"`
- Backend tests: `python -m pytest backend/tests -q`
- Dev server: `BROWSER=none` is set in `frontend/.env` to prevent double browser windows

## Key Files

### Frontend Components
- `frontend/src/components/PitcherCard.jsx` — Main player card: Box Score table, pitch type metrics, strikezone plots, velocity trend, play-by-play. Receives `cardData`, `onReclassify`, `onPlayerClick` props.
- `frontend/src/components/VelocityTrendV2.jsx` — Single-lane velocity chart with interactive legend. `lockedType` state for click-to-lock pitch type highlighting. When locked, draws swim lane overlay (top/bottom lines, dotted avg line, right-side labels with anti-overlap). `activeHighlight = lockedType || highlightType`.
- `frontend/src/components/StrikeZonePlot.jsx` — Canvas strikezone with reclassify on click. Accepts `onReclassify` prop.
- `frontend/src/components/PlayByPlayModal.jsx` — Lightbox PBP view with tooltips.
- `frontend/src/components/PitchDataTable.jsx` — Pitch type metrics table with TOTALS row. Totals show "—" for Velo/Usage/IVB/IHB/Ext, percentages for Vs R/Vs L (overall hand split), and weighted averages for CS%/SwStr%/CSW%/Strike%.
- `frontend/src/components/ResultsTable.jsx` — Results tab with totals row using `.pp-total-row` CSS class.
- `frontend/src/components/PlayerPage.jsx` — Full player page with game log. Renders the Savant section only when `pitch_summary` is present in the payload (AAA-only rule).
- `frontend/src/components/PitcherResultsTable.jsx` — Pitcher results on main data page (Statcast levels).
- `frontend/src/components/AdaptedResultsTable.jsx` — Box-score results table for non-Statcast levels: Date+Lvl | Pitcher | Team | Opp | Dec | IP | H | R | ER | BB | K | HR | BF | P | Str% | GO/AO. No derived metrics beyond Str% and GO/AO.
- `frontend/src/components/TeamPage.jsx` — Routed per MLB ORG; one table per affiliate, highest level first.
- `frontend/src/components/RegularSeasonTable.jsx` — Regular Season game-log table SHARED by the player page and the game card (the only game-log table; no postseason/spring/MiLB variants). Holds the view/pitch/hand filters and the Pitch-Mix display modes (below); delegates markup to `GameLogTable`.
- `frontend/src/components/GameLogTable.jsx` — Generic game-log shell (left box score + pluggable `rightCols`). Optional display-mode hooks (all no-op by default, backward-compatible): `rightCellAttrs(row,i,col)→{className,style}` (heatmap tint), `renderRowDivider(row,i,colSpan)` (full-width injected row; `colSpan` auto-tracks Bars mode), `renderDateBadge(row,i)` (per-game pill), `getRowClassName(row,i)`.
- `frontend/src/components/PitchMixBar.jsx` — One game's mix as a 100%-width stacked bar (canonical order + faint "other" segment for untracked mass).

### Pitch-Mix display modes (RegularSeasonTable)
Apply only to the `Pitch Mix` view with no pitch-type filter. Controls render in the existing filter row, scoped to that view. One shared preference persisted via `usePersistentState` (localStorage keys `pl_pitchmix_cellmode|heatmap|divider`) across both surfaces and all pitchers.
- **Dropdown** `Raw columns | Distribution bar` (cell rendering). **Heatmap** + **Approach-shift divider** are independent toggles. Heatmap is disabled while Bars is selected; the divider toggle is disabled (with tooltip) unless the hand split is vs LHB / vs RHB.
- Per-game pitch-to-side count (the divider's sample gate) is `_handTotal` on each pitch-mix row in `gameLogPitch.js` — already client-side, NO data-layer change.
- Helpers in `frontend/src/utils/gameLogPitch.js`: `pitchMixHeatRanges`, `pitchMixHeatStyle`, `buildMixBarSegments`, `hexToRgba`.
- Detector + config in `frontend/src/utils/approachShift.js`: `detectApproachShift(games, pitchKeys)`; constants `MIN_SIDE_PITCHES=15`, `MIN_PHASE_GAMES=3`, `MIN_TVD=8`. Significance = seeded permutation test (p<0.05, deterministic — no flicker) AND TVD ≥ `MIN_TVD`; returns null ("no shift") otherwise.

### Frontend Utilities
- `frontend/src/utils/pitchFilters.js` — `getTooltipResult(pitch, opts)` shared tooltip utility returning `{ label, color, isK, isCalledStrikeThree, subLabel }`. Normalizes both Statcast and PBP formats.
- `frontend/src/utils/api.js` — All fetch functions including `fetchPitcherSeasonTotals`.
- `frontend/src/utils/formatting.js` — Cell highlight, emphasis frames, formatting helpers.
- `frontend/src/constants.js` — `PITCH_COLORS`, `CARD_PITCH_DATA_COLUMNS`, `CARD_RESULTS_COLUMNS`, `TEAM_FULL_NAMES`, `displayAbbrev`.
- `frontend/src/styles.css` — All CSS including `.pp-total-row`, `.card-gameline-table`, `.pitch-tooltip`.

### Backend
- `backend/app.py` — FastAPI endpoints: `/api/levels`, `/api/pitcher-card`, `/api/pitcher-season-totals`, `/api/player-page`, `/api/org-page`, `/api/game-linescore`, `/api/season-averages`, etc. Date-scoped endpoints take `level`.
- `backend/levels.py` — Level registry (sportIds), per-level schedule URLs, MLB parent-org map, `(org, level)` team display. The ONLY place sportIds live.
- `backend/boxscore_levels.py` — Box-score path for non-Statcast levels: `get_level_results` (adapted daily rows), `get_multi_level_game_log` (merged all-levels player log), `get_person_info`, `current_level`.
- `backend/aggregation.py` — Data aggregation: `get_pitcher_card`, `get_pitcher_game_log`, `aggregate_pitch_data_range`, `_aggregate_pitch_df`. `_filter_level` slices a day's frame to one level.
- `backend/data.py` — Data fetching, caching, boxscore lookups, level tagging (`_apply_levels`, `_apply_levels_multi_date`, `get_game_level_map`).
- `backend/season.py` — Shared constants + pure helpers: `SEASON_START`/`season_start(year)`, `now_et()`, `strip_accents()`, `ip_to_outs()` (single IP parser), `aggregate_game_log_to_totals()` (single copy of season-totals math). Stdlib-only — importable from anywhere without cycles.
- `backend/caches.py` — Process-local caches shared between data.py and aggregation.py (`season_game_agg_cache`).

## Two Pitch Data Formats
- **Statcast:** `pitch_name`, `release_speed`, `description`, `events`
- **PBP:** `type`, `speed`, `desc`, plus parent PA `result`
- `getTooltipResult` normalizes both with `.toLowerCase().replace(/\s+/g, "_")` on `desc` and `ev`

## Color System

### Tooltip Result Colors
- Strikeout: `#65FF9C`
- Walk/HBP: `#ffc277`
- Home Run: `#FF5EDC`
- Outs: `#65BAFF`
- Single/Double/Triple: `#feffa3`
- Foul: `#AAB9FF`
- Run-scoring text: `#FF5EDC` (pink)

### Pitch Type Colors (in PITCH_COLORS constant)
- Knuckleball: `#A0A0A0` (grey)
- Forkball: `#78E0AE` (teal, between Changeup green and Splitter blue)

## Strike Zone Positioning (normalize to the batter's zone)
Pitch height (`plate_z`) is absolute feet, but each batter's zone (`sz_top`/`sz_bot`) varies by height. To match Baseball Savant, every strikezone plot draws ONE fixed-size box and positions pitches RELATIVE to each pitch's own batter zone.
- Helper: `utils/strikezone.js` → `normalizePlateZ(plate_z, sz_top, sz_bot)` remaps onto the fixed reference zone `[DISPLAY_SZ_BOT=1.5, DISPLAY_SZ_TOP=3.5]`. A pitch at the batter's zone top → 3.5, at the bottom → 1.5, proportionally beyond for balls. Missing zone data falls back to identity (raw value).
- ALWAYS pass `normalizePlateZ(...)` (never raw `plate_z`) into any vertical coordinate map. Sites: StrikeZonePlot (main canvas + tooltip), StrikeZonePBP (`toY`), and the mini-SVG tooltips in PitcherCard, PlayByPlayModal, MovementPlot, VelocityTrend, VelocityTrendV2. Draw the box at the fixed `[1.5, 3.5]` — do NOT size it to the card-mean `sz_top`/`sz_bot`.
- Backend ships per-pitch `sz_top`/`sz_bot` in every pitch record: `aggregation.py` `_pitch_cols`/`_float_fields` (card + `build_pitches_list`) and the PBP builder in `data.py` (`strikeZoneTop`/`strikeZoneBottom`). Both Savant CSV (native columns) and the MLB API path populate them. Bump `CARD_SCHEMA_VERSION` when this plumbing changes.

## Tooltip Pattern (4 locations)
All tooltips in StrikeZonePlot, VelocityTrend, PlayByPlayModal, PitcherCard:
- Use `position: fixed` with viewport clamping (`window.innerWidth`/`window.innerHeight`) to prevent overflow jitter
- Set `transform: "none"` to override the CSS `translate(-50%, -100%)`
- Strikeout sub-label ("Swinging Strike"/"Called Strike") on same line as "vs Batter", right-aligned
- Mini strikezone SVG container gets `paddingTop: 16` when `result.isK && result.subLabel`
- StrikeZonePBP passes `clientX`/`clientY` in its `onPitchHover` callback for fixed positioning

## Totals Rows
- Both PitchDataTable and ResultsTable use `.pp-total-row` CSS class (bold `font-weight: 700`, `background: rgba(255,255,255,0.04)`, `border-top: 2px solid var(--border)`)
- Box Score season totals row also uses `.pp-total-row` + `.pp-total-label`
- Box Score columns: Pitcher | IP | R | ER | Hits | BB | K | Whiffs | SwStr% | CSW% | Strike% | # | HR

## Season Date Range
All season totals use `2026-03-25` as the start date. This is set in:
- Backend: ONE constant — `SEASON_START` in `backend/season.py` (update annually; dynamic-year sites use `season_start(year)`)
- Frontend: `api.js` defaults, `PitcherCard.jsx` springStart, `PlayerPage.jsx` start_date

## Sorting
Sort teams alphabetically by FULL team name, never by abbreviation. For MLB rows that's the `TEAM_FULL_NAMES` lookup (PitchDataTable, PitcherResultsTable default sort, column sort, splitByTeam sort); for MiLB rows the affiliate name rides along on the row as `team_name` / `team_display`, so sort on that — `TEAM_FULL_NAMES` has no MiLB entries and would silently fall back to abbreviation order.

## Fielder's Choice / Outs
In `getTooltipResult`, fielder's choice and force outs are in the trajectory-based out section with "(FC)" or "(DP)" suffix. Launch angle determines: Groundout (<10°), Lineout (10-25°), Flyout (25-50°), Popout (>50°).

## VelocityTrendV2 Interactions
- **Hover legend:** Dims other pitch types to 20% opacity (only when no locked type)
- **Click legend:** Locks pitch type — shows swim lane overlay with top/bottom boundary lines, dotted avg line, right-side max/avg/min labels with anti-overlap stacking
- **Click canvas dot:** Opens reclassify lightbox (same as MovementPlot and StrikeZonePlot)
- Legend items use `padding: 2px 10px` with `gap: 0` on parent to eliminate hover jitter between items

## Dynamic Heights (VelocityTrend v1 swim lanes)
Formula: `max(50, round(24.75 * pitchCount))` with 4-pitch = 99px baseline.

## Create Tabs / Background-Tab Opening (browser policy — verified June 2026)
`openInNewWindow`/`openHashesInNewTabs` in `App.jsx` dispatch synthetic clicks on real `<a target="_blank">` anchors (this bypasses the popup blocker even for 30 opens, unlike a `window.open` loop). Hard constraints, all verified empirically in Chrome against prod:
- Chrome IGNORES synthetic-event modifiers (`ctrlKey: true` on the dispatched MouseEvent) and `rel="opener"` on synthetic clicks. Tab disposition comes from the REAL input event being handled at dispatch time: middle-click or Ctrl/Cmd+click on Create Tabs → all tabs open in BACKGROUND, focus stays; plain left click → focus follows the last tab opened.
- Nothing can refocus the page afterward: `window.focus()`, `opener.focus()` (even with a real opener ref), and `window.open('', window.name)` are all blocked by popunder mitigations. There is NO plain-click path to background tabs from page JS.
- INVARIANT: the synthetic dispatches must stay SYNCHRONOUS inside the real click/auxclick handler — a `setTimeout`/`await` before them loses the gesture's disposition.
- UX: plain click still opens the tabs and shows `.create-tabs-hint` teaching the middle/Ctrl+click gesture (suppressed in Electron, where `electronAPI.openNewWindow` handles it).


# Baseball Dashboard

## Project Overview
A web-based pitcher and hitter stats dashboard for PitcherList staff, featuring live Statcast data and the Savant Dashboard aesthetic. This is Nick's personal analytics tool for reviewing pitcher (and eventually hitter) performance — NOT the PL Pro Dashboard that subscribers use.

## Owner
Nick Pollack, CEO of Pitcher List

## Key Context
- Built with FastAPI (Python backend) + React 18 / Create React App (frontend)
- Live Statcast integration via Baseball Savant's `/gf` endpoint with WebSocket push for iVB, HAVAA, and arm angle metrics
- Design system: dark navy (`#0b1120`-range) backgrounds, cyan (`#55e8ff`) and amber (`#ffc277`) accents, DM Sans font family
- Design tokens documented in `design.md`

## Current State
- Pitcher stats dashboard is functional with live Savant data
- Hitter dashboard does NOT exist yet

## Planned Work
1. **Ingest PitcherList API** — PLV, PLV derivatives, non-competitive rate, mistake rate, and all proprietary PL stats. The API exists but Nick needs to coordinate access with his developers.
2. **Add full hitter dashboard** — same depth as pitchers. Needs design work on what hitter game cards should display (different focus than pitcher cards).
3. **Merge with Pitcher Video Viewer** — one unified codebase. Link every individual pitch in the data to its corresponding video clip. Ensure universal design and synced data between stats and video views.
4. **Admin login for PL staff** — so staff can view pitcher video alongside the data.

## Important Distinctions
- This is a STAFF-FACING analytics tool, not the subscriber-facing PL Pro Dashboard
- This dashboard will eventually feed INTO the PL Pro Dashboard as one of its tools/apps
- SWATCH and HIPSTER are branded content labels, NOT data metrics
- PLV, Process+, PL Ranks ARE data metrics

## Related Projects
- Pitcher Video Viewer (merging into this)
- PL Pro Dashboard (this becomes one of its apps)
- pl-pro-figma-plugin (design token management)

## Tech Stack
- FastAPI + React 18 (Create React App)
- Baseball Savant API
- PitcherList API (upcoming integration)
