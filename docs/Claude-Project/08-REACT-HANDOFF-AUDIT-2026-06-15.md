# React Handoff Audit - 2026-06-15

Repository: `https://github.com/BeardedBats/Pitcher-Dashboard`
Audited commit: `13ec536ab87cb484597b4532e9b9a4564ca7d7ae`
Branch: `main`

## Purpose

This document prepares the current Pitcher Dashboard React code for handoff into another React app. It identifies the components, data sources, constants, hooks, and utilities that should be reused so the destination app does not reimplement baseball-specific behavior.

The goal is not a cosmetic rewrite. The goal is to preserve the working baseball domain logic, reduce duplicate code, and give a React developer a clear mental model before they move or refactor anything.

## Executive Summary

The app already has strong domain modules:

- `frontend/src/utils/api.js` is the intended API boundary.
- `frontend/src/constants.js` is the source for pitch colors, team display names, table columns, thresholds, and result colors.
- `frontend/src/utils/pitchFilters.js` is the source for pitch result classification, result filtering, PBP description spans, tooltip labels, and run-scored helpers.
- `frontend/src/utils/formatting.js` is the source for numeric formatting, table emphasis, batted-ball formatting, result color lookup, and shared color conversion helpers.
- `frontend/src/hooks/useLiveLinescore.js` is the source for live linescore polling and projected live-game W/L decisions.

The largest code-minimization opportunity is not replacing the existing components. It is extracting orchestration currently trapped inside large view files, especially `App.jsx`, `PitcherCard.jsx`, `PlayerPage.jsx`, and the canvas chart components.

Recommended handoff strategy:

1. Copy the backend/API contract or keep this backend as a service.
2. Copy the domain utilities first.
3. Copy table and chart primitives second.
4. Rebuild page orchestration in the destination app around smaller route/view containers.
5. Only after parity, extract shared hooks from duplicated polling, routing, filters, and tooltip helpers.

## Current React Shape

The frontend is a Create React App project under `frontend/`.

Runtime dependencies are minimal:

| Package | Role |
|---|---|
| `react` | UI runtime |
| `react-dom` | DOM renderer |
| `react-scripts` | CRA build/dev tooling |

There is no Redux, no Context API, and no router package. Routing is hash-based and managed manually inside `App.jsx`.

### Largest Files

These are the files most likely to hide duplicated behavior or orchestration that should become hooks/utilities during handoff:

| File | Lines | Handoff interpretation |
|---|---:|---|
| `frontend/src/components/PitcherCard.jsx` | 1096 | Main game-level pitcher view. Reuse UI pieces, but extract filters/PBP rendering helpers before extending. |
| `frontend/src/components/VelocityTrendV2.jsx` | 1008 | Rich current-card velocity chart. Keep if this is the target velocity experience. |
| `frontend/src/App.jsx` | 1000 | Root orchestration, manual hash routing, global state, polling, navigation, reclassification. Split in target app. |
| `frontend/src/components/VelocityTrend.jsx` | 591 | Older/simple velocity chart used by `PlayerPage`. Candidate to retire or adapt to `VelocityTrendV2`. |
| `frontend/src/components/PlayByPlayModal.jsx` | 552 | PBP modal and PBP-specific rendering. Shares logic with `PitcherCard` and `VelocityTrendV2` tooltips. |
| `frontend/src/components/PlayerPage.jsx` | 505 | Season/player route. Shares most table/chart/filter concepts with `PitcherCard`. |
| `frontend/src/components/RegularSeasonTable.jsx` | 455 | Reusable game-log table with nested mode support. Keep. |
| `frontend/src/components/PitchDataTable.jsx` | 419 | Reusable pitch metric table. Keep. |
| `frontend/src/components/StrikeZonePlot.jsx` | 412 | Main strike-zone canvas. Keep, but extract repeated helpers. |
| `frontend/src/components/MovementPlot.jsx` | 409 | Movement canvas. Keep, but extract repeated helpers. |

## Source Of Truth Map

Use this table when deciding whether to copy, rewrite, or extract code.

| Concern | Source of truth | Reuse decision |
|---|---|---|
| API base URL, fetch timeouts, endpoint wrappers | `frontend/src/utils/api.js` | Keep and expand. All network calls should go through this file or a typed replacement. |
| Pitch colors | `frontend/src/constants.js` (`PITCH_COLORS`, `getPitchColor`) | Keep. Do not duplicate hex maps in components. |
| Team abbreviations and display names | `frontend/src/constants.js` (`TEAM_FULL_NAMES`, `TEAM_ABBREV_DISPLAY`, `displayTeamAbbrev`) | Keep. Components should call display helpers. |
| Table column schemas | `frontend/src/constants.js` (`PITCH_DATA_COLUMNS`, `CARD_PITCH_DATA_COLUMNS`, `CARD_RESULTS_COLUMNS`, `CARD_USAGE_COLUMNS`, `PITCHER_RESULTS_COLUMNS`) | Keep. Destination app should render from these schemas where possible. |
| Pitch result filters | `frontend/src/utils/pitchFilters.js` (`RESULT_FILTER_OPTIONS`, `RESULT_QUICK_ACTIONS`, `matchesResultFilter`) | Keep. This avoids charts and tables disagreeing. |
| Tooltip result labels/colors | `frontend/src/utils/pitchFilters.js` (`getTooltipResult`) | Keep. This is already the shared tooltip source. |
| PBP event spans | `frontend/src/utils/pitchFilters.js` (`getPADescriptionSpans`, `getNotableMidAbActions`, `buildExpandedPitchItems`) | Keep. |
| Runs scored on pitch | `frontend/src/utils/pitchFilters.js` (`runsScoredOnPitch`, `isRunScored`) | Keep. |
| Table formatting and cell emphasis | `frontend/src/utils/formatting.js` | Keep. |
| Strike-zone normalization | `frontend/src/utils/strikezone.js` | Keep. |
| Live linescore polling | `frontend/src/hooks/useLiveLinescore.js` | Keep and use for all live card/game state refresh. |
| Mobile breakpoint detection | `frontend/src/hooks/useIsMobile.js` | Keep unless the destination app already has a responsive hook. |
| Persistent local state | `frontend/src/hooks/usePersistentState.js` | Keep if user preferences remain localStorage-backed. |

## Component Reuse Matrix

### Reuse With Minimal Changes

These components are good candidates to move into the destination app mostly intact once their imports are updated.

| Component | Why reuse | Required inputs |
|---|---|---|
| `PitchDataTable.jsx` | Mature pitch-metric table using column schemas, formatting helpers, deltas, sort state, and pitch-type selection. | Rows with backend pitch metric fields, `CARD_PITCH_DATA_COLUMNS` or `PITCH_DATA_COLUMNS`, optional season averages. |
| `PitcherResultsTable.jsx` | Main results table for date/game view. | Pitcher result rows and `PITCHER_RESULTS_COLUMNS`. |
| `ResultsTable.jsx` | Compact card-level results table. | Aggregated pitch results by pitch type. |
| `UsageTable.jsx` | Count-bucket usage matrix. | Usage rows and `CARD_USAGE_COLUMNS`. |
| `RegularSeasonTable.jsx` | Game log with grouped modes and season total row behavior. | Player game log, game-level pitch tables/results/usage data. |
| `GameLogTable.jsx` | Smaller game-log table used by player/card flows. | Game log rows, `buildCardHref`, team display helper. |
| `PitchFilterDropdown.jsx` | Multi-select/quick-action filter UI. | Option array, selected Set, quick actions. |
| `ReclassifyModal.jsx` | Pitch type selection modal. | Pitch metadata, confirm/cancel callbacks. |
| `DatePicker.jsx` | Simple date input with mobile handling. | Date value and change callback. |
| `ErrorBoundary.jsx` | Generic React error boundary. | No domain dependency. |
| `PitchMixBar.jsx` and `UsageBar.jsx` | Small display primitives. | Precomputed pitch mix/usage values. |

### Reuse After Extraction

These are valuable but currently carry duplicated helpers, direct DOM work, or route-specific assumptions.

| Component | Keep | Extract first |
|---|---|---|
| `StrikeZonePlot.jsx` | Canvas strike-zone drawing, pitch hover, pitch click/reclassify surface. | `ordinal`, `basesString`, `pitchMatch`, tooltip coordinate helpers, canvas DPR setup. |
| `MovementPlot.jsx` | IVB/IHB movement plot and interaction model. | Same repeated helpers as `StrikeZonePlot`; common tooltip model. |
| `VelocityTrendV2.jsx` | Rich game-card velocity trend with inning overlays and linescore-aware PBP hints. | Shared inning/team display helpers and PBP tooltip renderer. |
| `VelocityTrend.jsx` | Simpler season-level velocity trend used by `PlayerPage`. | Decide whether destination app still needs it once `VelocityTrendV2` can accept player-page data. |
| `Scoreboard.jsx` | Linescore/table display and inning tooltip logic. | Shared inning labels, display team helper usage, PBP result rendering. |
| `PlayByPlayModal.jsx` | Full modal PBP drill-down. | `formatResult`, `isStrikeout`, `ordinal`, PBP row rendering shared with `PitcherCard`. |
| `PitcherCard.jsx` | Complete game-card experience and best demonstration of all primitives together. | Split into data container, filters hook, chart/table sections, PBP section, next-starts section. |
| `PlayerPage.jsx` | Season player page and best second view for shared table/chart primitives. | Replace direct fetch/poll loop with API client and `useWarmupBackedResource`; share filters with `PitcherCard`. |
| `TeamPage.jsx` | Team route. | Replace direct fetch/poll loop with API client and `useWarmupBackedResource`; reuse table primitives instead of custom table rendering if possible. |

### Do Not Copy Blindly

| File/logic | Why |
|---|---|
| Most of `App.jsx` | It mixes routing, navigation, data fetching, polling, reclassification, table filters, modal state, and render layout. Use as a behavior reference, not as the final target app shape. |
| Direct `fetch` calls in `PlayerPage.jsx`, `TeamPage.jsx`, `SearchBar.jsx`, and `App.jsx` name resolution | These bypass `utils/api.js`. Move them into the API client during handoff. |
| `VelocityTrend.jsx` plus `VelocityTrendV2.jsx` as permanent parallel charts | This duplicates concepts. Pick one public velocity chart API and adapt page-specific data into it. |
| Raw CSS class additions without checking `styles.css` prefix conventions | The CSS is global. New classes can collide unless prefixes are kept disciplined. |

## API And Data Source Boundary

The frontend should treat `backend/app.py` as the contract. `api/index.py` only exposes the FastAPI app to Vercel.

Primary frontend-facing endpoints:

| Endpoint | React caller today | Handoff note |
|---|---|---|
| `/api/default-date` | `fetchDefaultDate()` | Keep wrapper. |
| `/api/initial-load` | `fetchInitialLoad()` | Keep wrapper. Cold starts can be long; preserve timeout behavior. |
| `/api/games` | `fetchGames(date)` | Keep wrapper. |
| `/api/pitch-data` | `fetchPitchData(date, gamePk?)` | Keep wrapper. |
| `/api/pitcher-results` | `fetchPitcherResults(date, gamePk?)` | Keep wrapper. |
| `/api/game-view` | `fetchGameView(date, gamePk)` | Keep wrapper. |
| `/api/pitcher-card` | `fetchPitcherCard(date, pitcherId, gamePk)` | Keep wrapper. |
| `/api/player-page` | direct in `PlayerPage`, wrapper exists as `fetchPlayerPage()` | Use wrapper only. |
| `/api/team-pitchers` | direct in `TeamPage` | Add wrapper. |
| `/api/warmup-status` | direct in `PlayerPage` and `TeamPage` | Add wrapper and shared polling hook. |
| `/api/game-linescore` | `fetchGameLinescore(gamePk)` | Keep wrapper and `usePolledLinescore`. |
| `/api/pitchers-directory` | `fetchPitchersDirectory()` | Keep wrapper. |
| `/api/pitchers-search` | direct fallback in `SearchBar` | Add wrapper if fallback remains. |
| `/api/resolve-pitcher` | direct in `App.jsx` | Add wrapper. |
| `/api/pitcher-schedule` | `fetchPitcherSchedule(name, gameDate)` | Keep wrapper. Source is a Google Sheet. |
| `/api/pitch-reclassify` | `reclassifyPitch()`, `undoReclassify()` | Keep wrappers. |
| `/api/refresh`, `/api/last-refresh` | `fetchRefresh()`, `fetchLastRefresh()` | Keep wrappers. |

Backend source categories to preserve:

| Source | Where handled | Frontend assumption |
|---|---|---|
| Baseball Savant / Statcast | `backend/data.py`, aggregation helpers | Pitch rows use Statcast-style snake_case fields such as `pitch_name`, `description`, `events`, `launch_speed`, `launch_angle`, `plate_x`, `plate_z`. |
| MLB Stats API / boxscore / linescore | `backend/data.py`, `backend/app.py` endpoints | Linescore/PBP fields power `Scoreboard`, `VelocityTrendV2`, `PlayByPlayModal`, and live decision projection. |
| Google Sheet pitcher schedule | `backend/app.py` `/api/pitcher-schedule` | `PitcherCard` next-starts display should not be reimplemented client-side. |
| Redis / Upstash cache | `backend/redis_cache.py`, `backend/data.py`, `backend/app.py` | Frontend must preserve long timeout and 202 warmup behavior rather than assuming instant responses. |

## Streamlined Destination App System

Use this target organization when moving into a different React app. Names are suggestions, but the boundaries are the important part.

```text
src/
  baseball/
    api/
      baseballApi.js
      endpointTypes.ts        # optional if the target app uses TypeScript
    constants/
      baseballConstants.js
      tableColumns.js
      colors.js
    hooks/
      useBaseballDate.js
      useGameNavigation.js
      useLiveLinescore.js
      usePitchFilters.js
      useWarmupBackedResource.js
    utils/
      baseballDate.js
      gameState.js
      gamePresentation.js
      pitchFilters.js
      pitchTableAgg.js
      seasonTotals.js
      formatting.js
      strikezone.js
    components/
      tables/
      charts/
      filters/
      modals/
      scoreboard/
    views/
      GamesView.jsx
      PitcherCardView.jsx
      PlayerPageView.jsx
      TeamPageView.jsx
```

### Boundary Rules

1. `views/` may fetch data and assemble page layout.
2. `components/` should receive data and callbacks; they should not know route hash formats.
3. `hooks/` own reusable stateful behavior: polling, filters, navigation, persistent settings.
4. `utils/` are pure functions and constants with no React imports.
5. `api/` is the only place that constructs backend URLs or calls `fetch`.
6. Backend response field names stay snake_case at the boundary. Convert only if a target app has a typed model layer.

## Extraction Roadmap

### Phase 1 - Preserve Domain Behavior

Copy or port these files first:

```text
frontend/src/constants.js
frontend/src/utils/api.js
frontend/src/utils/pitchFilters.js
frontend/src/utils/formatting.js
frontend/src/utils/pitchTableAgg.js
frontend/src/utils/gameLogPitch.js
frontend/src/utils/gameLogStats.js
frontend/src/utils/seasonTotals.js
frontend/src/utils/strikezone.js
frontend/src/hooks/useLiveLinescore.js
frontend/src/hooks/useIsMobile.js
frontend/src/hooks/usePersistentState.js
```

Then copy table and filter components:

```text
frontend/src/components/PitchDataTable.jsx
frontend/src/components/PitcherResultsTable.jsx
frontend/src/components/ResultsTable.jsx
frontend/src/components/UsageTable.jsx
frontend/src/components/RegularSeasonTable.jsx
frontend/src/components/GameLogTable.jsx
frontend/src/components/PitchFilterDropdown.jsx
frontend/src/components/ReclassifyModal.jsx
```

### Phase 2 - Centralize API Calls

Add these wrappers to the API client before moving page files:

```js
fetchWarmupStatus()
fetchTeamPitchers(teamAbbrev, { startDate, endDate, view })
fetchPitchersSearch(query, { startDate, endDate })
resolvePitcher(name, { startDate, endDate })
```

Then remove direct `fetch` calls from page/components:

- `PlayerPage.jsx` currently polls `/api/warmup-status` and calls `/api/player-page` directly.
- `TeamPage.jsx` currently polls `/api/warmup-status` and calls `/api/team-pitchers` directly.
- `SearchBar.jsx` currently calls `/api/pitchers-search` directly as fallback.
- `App.jsx` currently calls `/api/resolve-pitcher` directly.

### Phase 3 - Extract Shared Hooks

Create `useWarmupBackedResource` for endpoints that can return `202` while cache materialization is pending.

Desired API:

```js
const { data, loading, message, error, reload } = useWarmupBackedResource({
  key: ["player-page", pitcherId, startDate],
  load: () => baseballApi.fetchPlayerPage(pitcherId, startDate),
  pollWarmup: baseballApi.fetchWarmupStatus,
  retryMs: 2500,
  warmupPollMs: 2000,
});
```

Apply it to:

- `PlayerPage`
- `TeamPage`
- Any future leaderboard/materialized season view

Create `usePitchFilters` for filter state shared by `PitcherCard` and `PlayerPage`.

Owned state:

- `pitchTypeFilter`
- `resultFilter`
- `contactFilter`
- `batterFilter`
- `selectedPitchTypes`
- `gameFilter`

Owned derived values:

- `effectiveResultFilter`
- `filteredPitches`
- `selectedPitchTypeSet`
- callbacks to clear/toggle selected pitch types

### Phase 4 - Extract Routing And Navigation

Move route helpers out of `App.jsx`.

Current candidates:

- `getHashParts`
- route builders for `card`, `player`, and `team`
- `isNewWindowClick`
- `openInNewWindow`
- `openHashesInNewTabs`
- `scrollToTopAfterRender`

Suggested module:

```text
frontend/src/utils/navigation.js
```

Suggested API:

```js
parseBaseballHash(hash)
buildCardHash({ date, pitcherId, gamePk })
buildPlayerHash(pitcherId)
buildTeamHash(teamAbbrev)
isNewWindowClick(event)
openHashInNewWindow(hash)
openHashesInNewTabs(hashes)
```

The destination app may use React Router, Next.js routes, or another app router. If so, keep these as adapters rather than preserving hash routing forever.

### Phase 5 - Extract Presentation Helpers

These helper functions are duplicated across chart/PBP components today:

- `ordinal`
- `basesString`
- `pitchMatch`
- `formatResult`
- `isStrikeout`
- local `displayAbbrev` wrappers around `displayTeamAbbrev`

Suggested modules:

```text
frontend/src/utils/gamePresentation.js
frontend/src/utils/pitchIdentity.js
frontend/src/utils/pbpPresentation.js
```

Suggested exports:

```js
ordinalInning(n)
formatBaseState({ on_1b, on_2b, on_3b })
samePitchIdentity(a, b)
formatPaResult(result, trajectory)
isStrikeoutResult(result)
```

### Phase 6 - Consolidate Velocity Charts

Today:

- `PitcherCard.jsx` imports both `VelocityTrend` and `VelocityTrendV2`, but renders `VelocityTrendV2`.
- `PlayerPage.jsx` renders `VelocityTrend`.

Recommended target:

1. Define one public `VelocityTrend` component.
2. Use `VelocityTrendV2` as the implementation if its richer behavior is desired.
3. Pass optional `linescoreData` and `pitcherId` only when available.
4. Delete or archive the older implementation after visual parity is confirmed on the player page.

This removes one of the largest duplicated chart surfaces.

## Naming Conventions

### Files

| Type | Convention | Examples |
|---|---|---|
| React components | PascalCase `.jsx` | `PitchDataTable.jsx`, `PitcherCard.jsx` |
| Hooks | `useCamelCase.js` | `useLiveLinescore.js`, `useIsMobile.js` |
| Utility modules | camelCase `.js` | `pitchFilters.js`, `seasonTotals.js` |
| Constants | Usually central `constants.js`; exported symbols are uppercase when static | `PITCH_COLORS`, `CARD_USAGE_COLUMNS` |
| Docs | Numbered Markdown in `docs/Claude-Project/` | `04-FRONTEND.md`, this file |

### React Symbols

| Symbol type | Convention | Notes |
|---|---|---|
| Component | PascalCase default export | Keep one component per file unless creating tiny internal render helpers. |
| Hook | `useSomething` named/default export | Hooks may own state/effects. Utilities should not. |
| Event handler | `handleThing` for internal handlers, `onThing` for props | Example: `onReclassify`, `onPitchHover`, `handleSort`. |
| Boolean prop/state | `is`, `has`, `show`, `can`, `should` prefix | Example: `isMobile`, `showChange`, `hasAvgData`. |
| Set state | Use `Set` for multi-select filters | Preserve this for result/pitch-type filters. |

### Data Fields

Backend payloads use snake_case. Preserve those names in raw rows:

- `pitcher_id`
- `game_pk`
- `pitch_name`
- `launch_speed`
- `launch_angle`
- `sz_top`
- `sz_bot`
- `plate_x`
- `plate_z`
- `away_team`
- `home_team`

React-only props and local variables should use camelCase:

- `pitcherId`
- `gamePk`
- `selectedPitchTypes`
- `linescoreData`
- `buildCardHref`

Do not half-convert row objects. Either preserve backend rows as snake_case or create a typed adapter layer that converts the full object consistently.

### Route Names

Current hash routes:

| Route | Meaning |
|---|---|
| `#` | Games view |
| `#card/{date}/{pitcher_id}/{game_pk}` | Game-level pitcher card |
| `#player/{pitcher_id}` | Season player page |
| `#team/{team_abbrev}` | Team page |

If the destination app uses a router, map these route concepts directly:

```text
/baseball
/baseball/card/:date/:pitcherId/:gamePk
/baseball/player/:pitcherId
/baseball/team/:teamAbbrev
```

### CSS Classes

Current CSS is global in `frontend/src/styles.css`. Prefixes already carry meaning:

| Prefix/pattern | Meaning |
|---|---|
| `.pp-*` | Player page / player profile / pitcher card table sections |
| `.pbp-*` | Play-by-play modal/card elements |
| `.pf-*` | Pitch filter dropdown |
| `.sb-*` | Scoreboard |
| `.gl-*` | Game log / gameline table details |
| `.reclass-*` | Reclassification modal |
| `.hl-*` | Highlight/emphasis cells |
| `.card-*` | Pitcher card and card-level gameline areas |
| `.table-*` | Generic table surfaces |

Destination app recommendation:

1. Keep these prefixes during migration to avoid breaking styles.
2. If the target app uses CSS Modules/Tailwind/shadcn, wrap old components first and convert one prefix group at a time.
3. Do not introduce unprefixed classes for baseball-specific UI.

## Component Contract Notes

### PitchDataTable

Keep this table as the main pitch-metric renderer. It already handles:

- sortable columns
- totals row logic
- season-average deltas
- pitch-type row selection
- team split rendering
- mobile/slim behavior
- emphasis classes from `formatting.js`

Do not fork it for card/player/team views. Pass column schemas and flags instead.

### RegularSeasonTable And GameLogTable

These should remain the canonical game-log renderers.

Current key props:

- `displayAbbrev`
- `buildCardHref`
- `onGameClick`
- game log rows
- optional season totals / per-game pitch data / result / usage maps

If the destination app needs a different route system, change only `buildCardHref` and `onGameClick`.

### StrikeZonePlot, MovementPlot, VelocityTrend

These canvas charts should be moved with their utilities and constants. The rendering is specialized enough that rewriting would create more risk than it saves.

Before expanding them, extract:

- canvas DPR setup
- tooltip coordinate clamping
- pitch identity comparison
- base-state string formatting
- inning ordinal formatting

### PitcherCard

Treat `PitcherCard.jsx` as the reference composition, not the final architecture.

Recommended split:

```text
PitcherCardView.jsx
  PitcherHeader.jsx
  NextStartsStrip.jsx
  BoxScoreSection.jsx
  PitchMetricsSection.jsx
  PitchPlotsSection.jsx
  PitchPlayByPlaySection.jsx
  RegularSeasonSection.jsx
```

Keep the first split mechanical. Do not alter behavior while moving JSX.

### PlayerPage

`PlayerPage.jsx` is the best place to prove shared season-view primitives. It should use the same filter hook and table/chart components as `PitcherCard`.

Highest-leverage cleanup:

- move direct API calls into `api.js`
- replace manual warmup polling with `useWarmupBackedResource`
- replace `VelocityTrend` with the consolidated velocity component once parity is confirmed

### TeamPage

`TeamPage.jsx` currently renders custom team tables rather than reusing more table primitives. If the destination app prioritizes smaller code, convert it to feed `PitchDataTable` / `PitcherResultsTable` style table components instead of maintaining a separate table renderer.

## Duplication Inventory

These are the first concrete targets for code reduction:

| Duplication | Files | Proposed home |
|---|---|---|
| Inning ordinal formatting | `PitcherCard`, `PlayByPlayModal`, `StrikeZonePlot`, `MovementPlot`, `VelocityTrend`, `VelocityTrendV2`, `Scoreboard`, `GameTabs` | `utils/gamePresentation.js` |
| Base-state string formatting | `StrikeZonePlot`, `MovementPlot`, `VelocityTrend`, `VelocityTrendV2` | `utils/gamePresentation.js` |
| Pitch identity comparison | `StrikeZonePlot`, `MovementPlot` | `utils/pitchIdentity.js` |
| PA result formatting and strikeout detection | `PitcherCard`, `PlayByPlayModal` | `utils/pbpPresentation.js` |
| Warmup 202 polling | `PlayerPage`, `TeamPage` | `hooks/useWarmupBackedResource.js` |
| Backend base URL construction | `utils/api.js`, `PlayerPage`, `TeamPage`, `SearchBar`, `App` | `utils/api.js` only |
| Hash route building/opening | `App`, `PlayerPage`, `PitcherCard`, `GameLogTable` via props | `utils/navigation.js` plus route-builder props |
| Filter state and derived filtered pitches | `PitcherCard`, `PlayerPage` | `hooks/usePitchFilters.js` |
| Velocity chart concepts | `VelocityTrend`, `VelocityTrendV2` | One public velocity chart component |

## Handoff Checklist

Use this checklist when moving into the destination app.

1. Verify the destination app can call the same backend endpoints.
2. Port `constants.js` and all utilities listed in Phase 1.
3. Port API wrappers and remove all direct component-level `fetch`.
4. Port table components and confirm `PitchDataTable`, `ResultsTable`, `UsageTable`, and `RegularSeasonTable` render from fixture data.
5. Port chart components and confirm canvas sizing, hover, and reclassify click behavior.
6. Port `useLiveLinescore` and confirm live games keep polling until final.
7. Port `PitcherCard` as a reference view, then split sections without changing behavior.
8. Port `PlayerPage` and `TeamPage` using shared warmup/resource hooks.
9. Replace hash navigation with the destination router through adapter functions.
10. Run a visual parity pass on:
    - games list
    - pitcher card
    - player page
    - team page
    - PBP modal
    - reclassify modal
    - mobile viewport

## Minimal Code Target

The target app should aim for this steady-state architecture:

| Layer | Owns | Does not own |
|---|---|---|
| API client | URL building, timeout/retry behavior, endpoint wrappers | React state |
| Resource hooks | loading/error/retry/polling lifecycle | JSX layout |
| Filter hooks | filter state and derived pitch subsets | Table/chart rendering |
| View components | page composition and route params | low-level baseball calculations |
| Table/chart components | rendering and local interaction | backend URL construction |
| Utilities/constants | pure baseball rules and display maps | React effects |

If a file violates more than two layers, split it before adding new features.

## Known Cautions

- Preserve long timeout behavior for cold backend/serverless work. Some card/player-page requests are expected to take tens of seconds when caches are cold.
- Preserve `202` warmup behavior for season/team/player endpoints. A loading response is not an error.
- Preserve raw Statcast/MLB event strings until they pass through existing helpers. Many edge cases are encoded in `pitchFilters.js`.
- Preserve `runs_scored` preference in `runsScoredOnPitch`; parsing descriptions is only a fallback.
- Preserve `normalizePlateZ` behavior in strike-zone charts.
- Preserve team display overrides such as `KC` to `KCR`, `TB` to `TBR`, and Athletics variants.
- Do not create new pitch color maps in the destination app.
- Do not fork table column definitions by copying arrays into components.

## Recommended First PR In The Destination App

The first PR should be small and boring:

1. Add `src/baseball/constants`, `src/baseball/utils`, and `src/baseball/api`.
2. Add table components only.
3. Add fixture-driven render stories or a temporary dev route.
4. Prove `PitchDataTable`, `ResultsTable`, `UsageTable`, and `RegularSeasonTable` render from saved API payloads.

Do not start with `App.jsx` or `PitcherCard.jsx`. Those files are too coupled to be a good first move. Start with the sources of truth and primitives, then assemble views once the base layer is stable.
