# Baseball Dashboard — Frontend

> **Purpose of this doc:** React component inventory, state model, routing, utilities, and constants. Read this before adding/editing any UI. Every component listed has its key props called out.

---

## Stack

React 18 (Create React App). Port **3847** in dev. `BROWSER=none` in `frontend/.env` so `npm start` doesn't open the browser twice (Electron opens its own window).

No Redux, no Context API. State lives in `App.jsx` and is prop-drilled.

## Routing

Hash-based — parsed in `App.jsx`.

| Hash pattern | View |
|---|---|
| `` or `#` | games view |
| `#card/{date}/{pitcher_id}/{game_pk}` | pitcher card |
| `#player/{pitcher_id}` | player page |
| `#team/{team_abbrev}` | team page |

## Global state (in `App.jsx`)

| State | Purpose |
|---|---|
| `date` | Currently selected date (YYYY-MM-DD) |
| `selectedGame` | `{ game_pk, home, away, ... }` or null |
| `view` | `"pitcher-results"` \| `"pitch-data"` — which table is shown |
| `pitchData`, `resultsData` | Table data from `/api/pitch-data` and `/api/pitcher-results` |
| `cardData` | Full pitcher card data (when one is open) |
| `pitchFilter` | Pitch type filter (dropdown) |
| `spOnly`, `splitByTeam` | Filter toggles |
| `resultsSortKey`/`resultsSortDir` | Results table sort |
| `pitchSortKey`/`pitchSortDir` | Pitch data table sort |
| `pbpModal` | Play-by-play modal state |
| `reclassifyPitch_` | Pitch currently being reclassified |
| `linescoreData` | For scoreboard / inning tooltips |

---

## Component inventory (`frontend/src/components/`)

### Main views

| Component | Key props | Purpose |
|---|---|---|
| `App.jsx` (root, not in components/) | — | Holds global state, renders current view based on hash |
| `PitcherCard.jsx` | `cardData`, `onReclassify`, `onPlayerClick`, `seasonAverages` | **The main player card.** Box Score table + pitch type metrics + strikezone plots + velocity trend + play-by-play |
| `PlayerPage.jsx` | `pitcher_id` | Full player page: game log, season summary, pitch summary tabs (All/vs L/vs R) |
| `TeamPage.jsx` | `team` | Team view — pitch data or pitcher results for the whole staff |
| `LeaderboardPage.jsx` | (varies) | Ranked pitchers by metric |

### Data tables

| Component | Key props | Purpose |
|---|---|---|
| `PitcherResultsTable.jsx` | `data`, `sortKey`, `sortDir`, `onSort`, `hiddenCols` | Results per pitcher/game (IP, R, ER, K, etc.) on the games view |
| `PitchDataTable.jsx` | `data`, `onReclassify`, `onPlayerClick` | Pitch metrics by type. Includes TOTALS row (`.pp-total-row`) |
| `ResultsTable.jsx` | `data`, `onReclassify` | Results tab on pitcher card — totals row same pattern |
| `UsageTable.jsx` | — | Pitch usage by count bucket (0-0 / Early / Behind / Two-Strikes × LHB/RHB) |

### Plots (canvas)

| Component | Key props | Purpose |
|---|---|---|
| `StrikeZonePlot.jsx` | `pitches`, `result`, `sz_top`, `sz_bot`, `onReclassify`, `onPitchHover` | Strike zone with pitch dots. Click to reclassify. `onPitchHover` emits `clientX`/`clientY` for fixed-position tooltips |
| `MovementPlot.jsx` | `pitches`, `onReclassify`, `onPitchHover` | IVB vs IHB scatter (Savant style) |
| `VelocityTrendV2.jsx` | `pitches`, `onReclassify`, `onPitchHover`, `selectedPitchType` | Single-lane velocity trend. Interactive legend: hover dims others; click locks a type (draws swim lane overlay with top/bottom/avg lines + anti-overlap side labels). `activeHighlight = lockedType \|\| highlightType` |

### Modals

| Component | Key props | Purpose |
|---|---|---|
| `PlayByPlayModal.jsx` | `game_pk`, `inning`, `isTop`, `onClose` | Lightbox PBP view with mini strikezone + pitch list + tooltips |
| `ReclassifyModal.jsx` | `pitch`, `pitchName`, `onConfirm`, `onCancel` | Pitch type selector dropdown |

### UI bits

| Component | Key props | Purpose |
|---|---|---|
| `GameTabs.jsx` | `games`, `selectedGame`, `onSelectGame` | Row of game tabs at top |
| `DatePicker.jsx` | `date`, `onChangeDate` | Date input |
| `Scoreboard.jsx` | `linescoreData` | Linescore + inning hover tooltips |
| `SearchBar.jsx` | `onSearch` | Pitcher typeahead |
| `PitchFilterDropdown.jsx` | `filters`, `selected`, `onSelect` | Filter by pitch type |
| `UsageBar.jsx` | — | Small inline usage bar visualization |

---

## Utilities (`frontend/src/utils/`)

### `api.js` — all backend fetch calls

Base URL logic:
- Electron → `http://localhost:${window.__BACKEND_PORT__}`
- Dev → `http://localhost:8000`
- Prod → `""` (same origin)

| Function | Endpoint hit |
|---|---|
| `fetchDefaultDate()` | `GET /api/default-date` |
| `fetchInitialLoad()` | `GET /api/initial-load` |
| `fetchGames(date)` | `GET /api/games?date=` |
| `fetchPitchData(date, gamePk?)` | `GET /api/pitch-data?date=[&game_pk=]` |
| `fetchPitcherResults(date, gamePk?)` | `GET /api/pitcher-results?date=[&game_pk=]` |
| `fetchPitcherCard(date, pitcherId, gamePk)` | `GET /api/pitcher-card?...` |
| `fetchSeasonAverages(pitcherId, season, { beforeDate, excludeGamePk, autoFallback })` | `GET /api/season-averages?...` |
| `fetchPitcherSeasonTotals(pitcherId, startDate="2026-03-25", endDate="")` | `GET /api/pitcher-season-totals?...` |
| `fetchGameLinescore(gamePk)` | `GET /api/game-linescore?game_pk=` |
| `reclassifyPitch({ game_pk, pitcher_id, at_bat_number, pitch_number, new_pitch_type, date })` | `POST /api/pitch-reclassify` |
| `undoReclassify({ game_pk, pitcher_id, at_bat_number, pitch_number, date })` | `DELETE /api/pitch-reclassify` |
| `fetchRefresh()` | `POST /api/refresh` |
| `fetchLastRefresh()` | `GET /api/last-refresh` |
| `fetchPitcherSchedule(name, gameDate?)` | `GET /api/pitcher-schedule?name=[&game_date=]` |

### `pitchFilters.js` — pitch classification + tooltip logic

| Function | Purpose |
|---|---|
| `classifyPitchResult(pitch)` | Returns one of: `HR`, `Single`, `Double`, `Triple`, `Strikeout`, `Walk`, `Whiff`, `Foul`, `Called Strike`, `Ball`, `HBP`, `Out`, `Other` |
| `getTooltipResult(pitch, opts?)` | **Shared tooltip result builder.** Returns `{ label, color, isK?, isCalledStrikeThree?, subLabel?, isError?, errorOutType? }`. Normalizes Statcast + PBP formats via `.toLowerCase().replace(/\s+/g, "_")` on `desc`/`ev`. Used by StrikeZonePlot, VelocityTrend, PlayByPlayModal, PitcherCard |
| `normalizePitchDesc(desc)` | e.g., `foul_tip` → "Swinging Strike" |
| `getPBPResultColor(result)` | PA-level result color |
| `isCIOrErrorEvent(result)` | Catcher interference / error detection |
| `getPADescriptionSpans(description, opts)` | Colored sentence spans for play descriptions (run-scoring text pink, etc.) |
| `isRunScored(pitch)` | HR or "scores" in description |
| `isStrikeoutPitch(pitch)`, `isWalkPitch(pitch)` | Boolean checks |
| `classifyBattedBallSimple(ev, la)` / `classifyBattedBallFull(ev, la)` | BIP tag (Barrel/Solid/Burner/Flare/etc.) |
| `classifyBIPQuality(launchSpeed, launchAngle)` | "Hard" \| "Weak" \| null |
| `isWeakBIP(pitch)` | Boolean |
| `isBallInPlay(pitch)` | Boolean |

### `formatting.js` — cell formatting + emphasis

| Function | Purpose |
|---|---|
| `fmt(v, decimals=1)` | Number → string, `"--"` for null |
| `fmtPct(v)` | `45` → `"45%"`, null → `"-"` |
| `fmtInt(v)` | Integer formatter |
| `getCellHighlight(key, value, pitchName)` | Returns `"elite"` / `"poor"` / null for red/blue cell backgrounds |
| `getVeloEmphasis(pitchName, velo)` | Velocity-specific elite/poor |
| `getIHBEmphasis(pitchName, ihb, hand)` | IHB emphasis (elite/poor) per pitch × batter hand |
| `getResultColor(result)` | Table result cell color |
| `getZoneLabel(zone)` | Zone number (1–14) → "Zone 1" / "Shadow" / "Outside" |
| `getSprayDirection(hc_x, hc_y)` | "to LF" / "to CF" / "to RF" / "to 1B" etc. from hit coords |
| `classifyBattedBall(ls, la)` | BIP classification |
| `getBIPQuality(tag)` | "Hard BIP" / "Weak BIP" / null |

---

## Constants (`frontend/src/constants.js`)

### `PITCH_COLORS` (exact hex)

```js
{
  "Four-Seamer": "#FF839B",   // warm pink
  "Sinker":      "#ffc277",   // amber
  "Cutter":      "#C59C9C",   // dusty rose
  "Slider":      "#CE66FF",   // purple
  "Sweeper":     "#FFAAF7",   // hot pink
  "Curveball":   "#2A98FF",   // bright blue
  "Changeup":    "#6DE95D",   // lime
  "Splitter":    "#83D6FF",   // sky blue
  "Knuckleball": "#A0A0A0",   // grey
  "Eephus":      "#A0A0A0",   // grey
  "Screwball":   "#90C890",   // muted green
  "Forkball":    "#78E0AE",   // teal (between Changeup green and Splitter blue)
}
```

### `PITCH_TYPE_FILTERS`
`["Four-Seamer", "Sinker", "Cutter", "Slider", "Sweeper", "Curveball", "Changeup", "Splitter", "Knuckleball", "Unclassified"]`

### `THRESHOLDS`
Elite/poor cutoffs per metric × pitch type. E.g., `ivb: { "Four-Seamer": [16, 12] }` means IVB ≥16 is elite, ≤12 is poor. `ext._all: [6.9, 5.8]` applies to all pitch types.

### Column definitions (used by tables)

- `PITCH_DATA_COLUMNS` — Pitcher/Team/Hand/Opp/Type/#/Velo/Usage/Vs R/Vs L/Ext/IVB/IHB/HAVAA/Strike%/CS%/SwStr%/CSW%
- `CARD_PITCH_DATA_COLUMNS` — same metrics, with `dividerRight: true` inserted at group breaks, no pitcher/team columns
- `CARD_RESULTS_COLUMNS` — Type/#/Whiffs/CS/Fouls/CSW%/Strike%/Foul%/Zone%/O-Swing%/BB/K/Hits/HRs/Outs/BIP/GB%/FB%/Weak%/Hard%
- `CARD_USAGE_COLUMNS` — Type × (vs LHB: #/0-0/Early/Behind/Two-Strikes) × (vs RHB: same) × PAR%
  - "Early" = 0-1, 1-0, 1-1
  - "Behind" = 2-0, 2-1, 3-0, 3-1
  - "Two-Strikes" = 0-2, 1-2, 2-2, 3-2
- `PITCHER_RESULTS_COLUMNS` — Pitcher/Team/Hand/Game/IP/R/ER/H/BB/K/CSW%/Whfs/#/HR

### Team mappings

- `TEAM_FULL_NAMES` — `{ "ARI": "Arizona Diamondbacks", ... }` (includes WBC nations + both `OAK`/`ATH` for the Athletics)
- `TEAM_ABBREV_DISPLAY` — display override: `KC` → `KCR`, `TB` → `TBR`, `AZ` → `ARI`, `CWS` → `CHW`, etc.
- `displayAbbrev(abbr)` — applies display overrides

### Pitch dot shapes (strikezone)

| Result | Shape |
|---|---|
| Called strike | Filled circle |
| Ball | Outline circle |
| Swinging strike / Whiff | Square |
| Foul | Triangle |
| Hit into play | Star |
| HBP | Diamond |

### Offense tier colors

`#ff8282` (Top) → `#ffa04b` (Solid) → `#d3b3ab` (Average) → `#9ed1f5` (Weak) → `#6de95d` (Poor)

---

## Hooks

- `useIsMobile()` — returns boolean based on viewport width. Used for conditional mobile layouts.

---

## CSS patterns (`frontend/src/styles.css`)

Key classes to know:

| Class | Purpose |
|---|---|
| `.pp-total-row` | TOTALS row bold + tinted bg + top border. Used in PitchDataTable, ResultsTable, Box Score |
| `.pp-total-label` | Label styling within totals row |
| `.card-gameline-table` | Box Score table on pitcher card |
| `.pitch-tooltip` | Base tooltip container |

Tooltip positioning uses `position: fixed` with viewport clamping (`window.innerWidth`/`window.innerHeight`). Set `transform: "none"` to override the default CSS `translate(-50%, -100%)`. See [07-BUSINESS-LOGIC.md](07-BUSINESS-LOGIC.md#tooltip-positioning) for details.
