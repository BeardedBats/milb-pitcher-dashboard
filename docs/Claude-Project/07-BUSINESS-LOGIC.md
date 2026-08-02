# Baseball Dashboard — Business Logic & Edge Cases

> **Purpose of this doc:** The tricky parts — logic that's easy to break if you don't know the rules. Tooltip normalization, pitch classification, date handling, team assignment, totals-row math, reclassification flow. If you hit a weird bug, it's probably covered here.

---

## Spring Training / season date range

**Canonical season start: `2026-03-25`.**

Hardcoded in:
- `backend/app.py` — all endpoint defaults: `start_date: str = Query("2026-03-25")`
- `backend/data.py` — warmup functions: `warmup_range_data(start_date="2026-03-25", ...)`, `start_warmup(start_date="2026-03-25")`
- `frontend/src/utils/api.js` — default parameter in `fetchPitcherSeasonTotals`
- `frontend/src/components/PitcherCard.jsx` — `springStart` constant
- `frontend/src/components/PlayerPage.jsx` — `start_date` prop default

> **Note:** CLAUDE.md mentions `2026-02-10` for WBC inclusion. That's stale. Actual code uses `2026-03-25` everywhere. If you need to add WBC back, update all the files above in lockstep.

**Season end:** Empty string `""` → resolves to today in ET (via `datetime.now(tz=ET)`) at request time.

---

## Pitch reclassification flow

### End-to-end

1. User clicks a pitch in any plot (StrikeZonePlot, MovementPlot, VelocityTrendV2 canvas dot).
2. `ReclassifyModal` opens with the pitch preselected.
3. User picks a new pitch type from the dropdown.
4. Frontend calls `reclassifyPitch({ game_pk, pitcher_id, at_bat_number, pitch_number, new_pitch_type, date })` from `utils/api.js`.
5. `POST /api/pitch-reclassify` → backend:
   - Saves to Redis `overrides` dict under key `{game_pk}_{pitcher_id}_{at_bat}_{pitch_num}` with value `{ new_type, new_name }`
   - Writes to `backend/pitch_overrides.json` as fallback
   - Increments `override_version` counter in Redis
   - Deletes `daily_pitch_{date}` and `daily_results_{date}` keys (those don't embed version)
6. Backend returns `{ status: "ok", key }`.
7. Frontend refetches the pitcher card. Cache miss (new `_v{override_version}` in key) → recomputes.
8. Card re-renders with updated pitch type + color + aggregated metrics.

### Undo

`DELETE /api/pitch-reclassify?game_pk=&pitcher_id=&at_bat_number=&pitch_number=&date=` — same flow but removes from overrides dict. Version still bumps, caches still clear.

### Why bump version instead of surgically invalidating?

Simpler, no-brainer invalidation. The only caches that embed the version are card + season totals + player page (the heavy ones). Everything else uses schema version or manual clearing. The bump cost is a full recompute for that one pitcher on next access, which is cheap.

---

## Team assignment (pitcher vs opponent)

Savant doesn't directly give you "pitcher's team" — you derive it from `inning_topbot`:

- **Top of inning** → pitching team is home team, batting team is away team
- **Bottom of inning** → pitching team is away team, batting team is home team

Implemented in `_assign_teams_vectorized()` in `backend/data.py`. Result: each pitch row has `pitcher_team` and `opponent` populated, never empty.

---

## Tooltip result normalization

### Two incoming pitch formats

| Format | Source | Key fields |
|---|---|---|
| Statcast | Savant CSV | `description`, `events`, `release_speed`, `pitch_name` |
| PBP | MLB Stats API | `desc`, `result` (PA-level, on parent), `speed`, `pitchName` |

### `getTooltipResult(pitch, opts)` in `utils/pitchFilters.js`

Handles both. Logic:

1. Take `desc` from `opts.desc` (PBP override) OR `pitch.description` (Statcast).
2. Take `ev` (event) from `opts.paResult` OR `pitch.events`.
3. Normalize both: `.toLowerCase().replace(/\s+/g, "_")`.
4. Route based on normalized value:
   - `hit_into_play` + events match → HR / Single / Double / Triple / Out
   - `strikeout` → green `#65FF9C`, isK = true, subLabel = "Swinging" or "Called"
   - `walk` / `hit_by_pitch` → amber
   - Foul → lavender
   - `called_strike` → amber (if not also events)
   - `swinging_strike` / `foul_tip` → red/Whiff color
   - etc.

Returns `{ label, color, isK?, isCalledStrikeThree?, subLabel?, isError?, errorOutType? }`.

### Special cases

- **Strikeout on called third strike** — `isK: true, isCalledStrikeThree: true, subLabel: "Called Strike"`. Tooltip shows sub-label right-aligned on same line as "vs Batter".
- **Fielder's choice / force out** — trajectory-based out with `(FC)` or `(DP)` suffix. Launch angle decides groundout/lineout/flyout/popout:
  - `<10°` → Groundout
  - `10°–25°` → Lineout
  - `25°–50°` → Flyout
  - `>50°` → Popout
- **Error** — `isError: true, errorOutType` specifies what kind of out it would've been. Description spans render error text in a distinctive color.
- **Run-scoring play** — description contains "scores" → pink `#FF5EDC` span in the description.

### Mini strikezone SVG in tooltip

When `result.isK && result.subLabel`, the mini SVG container gets `paddingTop: 16` to make room for the sub-label line above.

---

## Tooltip positioning

All four tooltip locations (StrikeZonePlot, VelocityTrendV2, PlayByPlayModal, PitcherCard) use the same pattern:

```js
// Container style:
{
  position: "fixed",
  left: clampedX,
  top: clampedY,
  transform: "none",   // Override CSS .pitch-tooltip's translate(-50%, -100%)
}
```

Viewport clamping:
```js
const clampedX = Math.min(Math.max(clientX, TOOLTIP_WIDTH / 2), window.innerWidth - TOOLTIP_WIDTH / 2);
const clampedY = Math.min(clientY - TOOLTIP_HEIGHT - 8, window.innerHeight - TOOLTIP_HEIGHT - 8);
```

StrikeZonePBP passes `clientX`/`clientY` through its `onPitchHover` callback — that's the hook every tooltip consumer uses.

### Desktop body zoom

Body zoom is 125% on desktop (commit `fca3be8`). The fixed-position math is in CSS pixels so compensation is automatic — but if you zoom differently, retest tooltip edge clamping.

---

## Totals row math

`.pp-total-row` is used in three places: `PitchDataTable`, `ResultsTable`, Box Score season totals.

### Rules for PitchDataTable totals

| Column | Total |
|---|---|
| Type | "Total" label |
| `count` (#) | Simple sum |
| `velo`, `usage`, `ivb`, `ihb`, `ext` | `—` (no sensible aggregate) |
| `vs_r`, `vs_l` | **Overall hand split percentage** (not average of rows) |
| `cs_pct`, `swstr_pct`, `csw_pct`, `strike_pct` | **Weighted average** by pitch count |

### Weighted-average pattern

```js
weightedAvg = sum(row.count * row.metric) / sum(row.count)
```

Never average percentages naively — rows with 1 pitch would skew the total. Always weight.

---

## Batter name resolution

Savant only gives batter ID. We resolve to names via MLB Stats API `/api/v1/people?personIds=...`, batched.

1. On any data fetch, collect unique batter IDs not in cache.
2. Single batched API call: `https://statsapi.mlb.com/api/v1/people?personIds=1,2,3,...`
3. Cache result in Redis `batter_names` dict.
4. Apply to pitches during JSON serialization.

Fallback: empty string `""` if lookup fails (so frontend concatenation doesn't crash on null).

---

## Cache bust triggers

What invalidates what:

| Event | Invalidates |
|---|---|
| `POST /api/pitch-reclassify` | `daily_pitch_{date}`, `daily_results_{date}` + all card/totals/player keys via `_v{override_version}` bump |
| `DELETE /api/pitch-reclassify` | Same as above |
| `GET /api/clear-cache?date=` | `daily_pitch_{date}`, `daily_results_{date}` |
| Bumping `CARD_SCHEMA_VERSION` in `data.py` | All `_s{CARD_SCHEMA_VERSION}` keys (cards, season totals, player pages) |
| Cron `warmup-daily` | Pre-populates `daily_pitch_{yesterday}`, `daily_results_{yesterday}` |
| Cron `warmup-live-cards` | Refreshes live game cards every 10 min during game hours |

---

## Pitcher name highlighting and warmup priority

The dashboard used to maintain a hardcoded "Top 400" list of priority pitchers
for both name highlighting and pre-computation priority. That concept was
removed — both behaviors are now driven by the SP/RP role assigned per game.

**Highlighting:** `PitcherResultsTable` adds the `.pitcher-sp-highlight`
class when `row.role === "SP"`. The role is set by `classify_pitcher_roles`
in `backend/aggregation.py` (with opener-swap detection via
`_check_opener_swap`).

**Caching:** Player pages are pre-computed for every pitcher who pitched
yesterday by `/api/cron/warmup-daily-players`. Pitcher cards are
pre-computed for every (pitcher, game_pk) combination yesterday by
`/api/cron/warmup-daily-cards`. There is no separate Top-400 batched warmup.

**Search:** `SearchBar` queries `/api/pitchers-search?q=...` on the
fly (debounced 150 ms) instead of filtering a hardcoded client-side list.
Server-side search is accent-insensitive.

---

## Game log formatting

- Home games: shown as `OPP` (e.g., "BOS")
- Away games: shown as `@OPP` (e.g., "@BOS") — the `@` prefix was added in commit `4bb48f9`
- Logic: check `log.home` boolean on each row

---

## Decision string codes

In `result.decision` and game log:

| Code | Meaning |
|---|---|
| `W` | Win |
| `L` | Loss |
| `ND` | No decision |
| `S` | Save |
| `BS` | Blown save |
| `HLD` | Hold |
| `""` / `null` | Relief appearance with no decision |

---

## Pitch classification filter categories

`classifyPitchResult(pitch)` returns one of:

```
HR, Single, Double, Triple, Strikeout, Walk, Whiff, Foul,
Called Strike, Ball, HBP, Out, Other
```

Used by result-outcome tooltips and BIP quality tagging. `classifyBattedBallFull(ev, la)` further categorizes contact (Barrel / Solid / Burner / Flare / Topped / Under / Poor).

---

## HAVAA / arm angle quirks

### HAVAA (Height Adjusted Vertical Approach Angle)

Derived from `vy0, vz0, ay, az, plate_z` plus the batter's strike zone (`sz_top`, `sz_bot`). Measures the pitch's effective vertical angle relative to where it crosses the plate relative to the batter's zone — a "flatter vs. steeper" feel. Positive = flatter / riding; negative = steeper / dropping. Arm slot matters — high-slot guys run more negative HAVAA on 4-seamers.

### Arm angle

Prefer Savant's native Hawk-Eye `arm_angle`. When missing, approximate from release position:

```
arm_angle ≈ 4.45 * abs(release_pos_x) + 23.64 * release_pos_z - 106.0
```

(Empirical approximation. Good enough for display, don't use for scouting decisions.)

---

## VelocityTrendV2 interaction model

- **Hover legend item:** dim all other pitch types to 20% opacity. Only active when no pitch is locked.
- **Click legend item:** lock that pitch type. Shows swim lane overlay: top/bottom boundary lines, dotted average line, right-side labels (max/avg/min) with anti-overlap vertical stacking.
- **Click legend item again:** unlock.
- **Click canvas dot:** open ReclassifyModal (same as StrikeZonePlot and MovementPlot).
- `activeHighlight = lockedType || highlightType` — lock beats hover.

Legend items use `padding: 2px 10px` with `gap: 0` on parent to eliminate hover jitter between items.

---

## Dynamic swim lane heights (V1 only)

VelocityTrend v1 (pre-V2) used dynamic per-pitch-type lane heights:

```
laneHeight = max(50, round(24.75 * pitchCount))
```

4-pitch baseline = 99px. V2 uses a single lane with overlay instead.

---

## MLB-API count tracker quirk

Foul balls count as strikes (in the `strikes` field) until the count reaches 2. A recent fix (commit `1045dcd`) corrected the count tracker to include the foul-ball strike code (`F`). If count display ever looks off on foul balls, check that.

---

## Gotchas worth remembering

- **Sign of IHB:** returned with sign flip. Positive = armside for RHP. Don't double-flip.
- **pfx values in response:** already in inches (× 12 applied server-side). Don't multiply again in the frontend.
- **IP is a string, not a number:** `"7.1"` = 7⅓ innings. Don't do math on it directly.
- **Percentages are 0–100, not 0–1.** Don't multiply by 100 in display.
- **Team abbreviation display overrides** in `TEAM_ABBREV_DISPLAY` — always run MLB abbrevs through `displayAbbrev(abbr)` for UI (KC → KCR, TB → TBR, AZ → ARI, CWS → CHW).
- **Alphabetical team sort** should always use `TEAM_FULL_NAMES[abbr]` for the sort key, not the abbreviation itself.
- **Empty batter names** are empty strings, not null. Don't null-check; default-check `""`.
- **Forkball is teal `#78E0AE`** (between Changeup green and Splitter blue). Knuckleball is grey `#A0A0A0`. Don't swap.
- **`game_pk` identifies a game** for `/api/game-linescore`, `boxscore:`, `feed:`, and `gamestate:` Redis keys. When applying overrides or filtering pitch rows, pair it with the pitcher and pitch identifiers, not `game_pk` alone.
