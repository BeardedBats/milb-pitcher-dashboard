# Baseball Dashboard — Data Schemas

> **Purpose of this doc:** Canonical JSON shapes for every non-trivial API response, plus the two pitch formats (Statcast vs PBP) and how they're normalized. Use this when wiring up a new component or debugging a data shape mismatch.

---

## Conventions

- Percentages: numbers 0–100 (e.g., `csw_pct: 67.2`), NOT 0–1
- IP: string (`"7.1"` = 7⅓ innings), Savant convention
- NaN → `null` before JSON serialization
- `pfx_x` / `pfx_z`: returned in **inches** (already × 12). Raw Savant stores feet.
- `ihb`: returned with sign flip (`-pfx_x * 12`). Positive = armside for RHP.
- Dates: `YYYY-MM-DD` strings
- Times: ISO 8601 (`2026-04-21T14:30:00Z`)

---

## Pitcher card response (`GET /api/pitcher-card`)

```json
{
  "pitcher_id": 543037,
  "game_pk": 745804,
  "name": "Gerrit Cole",
  "team": "NYY",
  "hand": "R",
  "opponent": "BOS",

  "pitches": [
    {
      "pitch_type": "FF",
      "pitch_name": "Four-Seamer",
      "plate_x": -0.52,
      "plate_z": 2.34,
      "pfx_x": 12.5,              // inches (already × 12)
      "pfx_z": 18.2,              // inches (already × 12)
      "release_speed": 95.2,
      "release_extension": 2.35,
      "stand": "R",               // batter handedness
      "description": "called_strike",
      "zone": 5,
      "at_bat_number": 1,
      "pitch_number": 1,
      "outs_when_up": 0,
      "balls": 1,
      "strikes": 2,
      "batter_name": "Rafael Devers",
      "events": "strikeout",      // null for mid-AB pitches
      "des": "Gerrit Cole strikes out Rafael Devers looking.",
      "launch_speed": null,
      "launch_angle": null,
      "hc_x": null,
      "hc_y": null,
      "inning": 1,
      "inning_topbot": "Top",
      "on_1b": false,
      "on_2b": false,
      "on_3b": false,
      "release_pos_x": 2.0,
      "release_pos_z": 6.2,
      "vx0": -9.0,
      "vy0": -95.0,
      "vz0": 18.0,
      "ax": -25.0,
      "ay": 32.2,
      "az": -35.0,
      "arm_angle": 51.2,
      "havaa": 3.5,
      "game_pk": 745804,
      "game_date": "2026-04-01"
    }
    // ...all pitches in this start
  ],

  "sz_top": 3.47,
  "sz_bot": 1.52,

  "pitch_table": [
    {
      "pitcher_id": 543037,
      "game_pk": 745804,
      "pitcher": "Gerrit Cole",
      "team": "NYY",
      "hand": "R",
      "opponent": "BOS",
      "pitch_type": "FF",
      "pitch_name": "Four-Seamer",
      "count": 28,
      "velo": 95.1,
      "usage": 60.9,
      "vs_r": 64.3,
      "vs_l": 54.2,
      "usage_vs_r": 62.0,
      "usage_vs_l": 58.8,
      "count_vs_r": 16,
      "count_vs_l": 12,
      "ext": 2.35,
      "ivb": 18.2,
      "ihb": -12.3,
      "havaa": 4.1,
      "whiffs": 8,
      "zone_pct": 67.9,
      "o_swing_pct": 45.3,
      "strike_pct": 72.4,
      "cs_pct": 35.7,
      "swstr_pct": 28.6,
      "csw_pct": 64.3,
      "appearance_order": 1,
      "home_team": "NYY",
      "away_team": "BOS"
    }
    // ...one row per pitch type
  ],

  "pitch_table_vs_l": [ /* same row shape, vs LHB only */ ],
  "pitch_table_vs_r": [ /* same row shape, vs RHB only */ ],

  "result": {
    "pitcher_id": 543037,
    "game_pk": 745804,
    "pitcher": "Gerrit Cole",
    "team": "NYY",
    "hand": "R",
    "opponent": "BOS",
    "ip": "7.1",
    "hits": 4,
    "bbs": 2,
    "ks": 11,
    "whiffs": 9,
    "csw_pct": 67.2,
    "pitches": 107,
    "hrs": 1,
    "er": 1,
    "runs": 1,
    "batters_faced": 24,
    "strike_pct": 68.0,
    "two_str_pct": 82.1,
    "par_pct": 72.2,
    "decision": "W"
  },

  "season_totals": {
    "ip": "34.2",
    "games": 5,
    "hits": 22,
    "bbs": 8,
    "ks": 45,
    "hrs": 3,
    "er": 9,
    "runs": 10,
    "pitches": 510,
    "whiffs": 42,
    "swstr_pct": 25.8,
    "csw_pct": 63.2,
    "strike_pct": 65.1,
    "par_pct": 71.5,
    "two_str_pct": 79.3,
    "batters_faced": 135
  },

  "game_weather": {
    "type": "dome",                // "dome" | "temp"
    "temp": 72,                    // °F (null if dome)
    "precip": null                 // "Rain" | "Snow" | null
  }
}
```

---

## Player page response (`GET /api/player-page`)

```json
{
  "info": {
    "pitcher_id": 543037,
    "name": "Gerrit Cole",
    "team": "NYY",
    "hand": "R",
    "position": "P",
    "mlbam_id": 543037
  },

  "pitch_summary": [
    // Same row shape as card.pitch_table, aggregated over full season
  ],
  "pitch_summary_vs_l": [ /* vs LHB */ ],
  "pitch_summary_vs_r": [ /* vs RHB */ ],

  "results_summary": {
    "ip": "219.2",
    "games": 33,
    "games_started": 33,
    "hits": 168,
    "bbs": 52,
    "ks": 288,
    "hrs": 25,
    "er": 89,
    "runs": 101,
    "pitches": 3462,
    "whiffs": 892,
    "swstr_pct": 25.8,
    "csw_pct": 63.2,
    "strike_pct": 65.1,
    "par_pct": 71.5,
    "two_str_pct": 79.3,
    "wins": 16,
    "losses": 4
  },

  "game_log": [
    {
      "date": "2026-03-25",
      "game_pk": 745804,
      "opponent": "BOS",
      "home": true,                // true = home game, false = away (use @ prefix)
      "ip": "7.1",
      "hits": 4,
      "bbs": 2,
      "ks": 11,
      "hrs": 1,
      "er": 1,
      "runs": 1,
      "pitches": 107,
      "whiffs": 9,
      "csw_pct": 67.2,
      "strike_pct": 68.0,
      "par_pct": 72.2,
      "decision": "W"              // "W" | "L" | "ND" | "S" | "BS" | "HLD"
    }
    // ...one per game started/appeared
  ]
}
```

---

## Pitch data aggregation (`GET /api/pitch-data`)

Array of rows (same row shape as `card.pitch_table[]` above). Each row = one pitcher × one pitch type × one game.

---

## Pitcher results (`GET /api/pitcher-results`)

Array of result rows (same row shape as `card.result` above), one per pitcher × game.

---

## Season averages (`GET /api/season-averages`)

```json
{
  "season": 2025,
  "averages": {
    "FF": {
      "count": 892,
      "velo": 95.1,
      "usage": 61.2,
      "vs_r": 64.3,
      "vs_l": 58.1,
      "usage_vs_r": 62.0,
      "usage_vs_l": 60.0,
      "count_vs_r": 545,
      "count_vs_l": 347,
      "ext": 2.35,
      "ivb": 18.1,
      "ihb": -12.4,
      "havaa": 4.0,
      "whiffs": 267,
      "zone_pct": 68.1,
      "o_swing_pct": 44.2,
      "strike_pct": 66.8,
      "cs_pct": 36.1,
      "swstr_pct": 29.9,
      "csw_pct": 66.0
    },
    "CH": { /* ... */ },
    "SL": { /* ... */ }
  }
}
```

With `auto_fallback=true`: if current season has no data, falls back to prior MLB season. Response `season` reflects the year actually returned.

---

## Game linescore (`GET /api/game-linescore`)

```json
{
  "home_team": "NYY",
  "away_team": "BOS",
  "home_score": 5,
  "away_score": 3,
  "inning": 7,
  "top_bottom": "Top",             // "Top" | "Bot" | "Mid" | "End"
  "status": "In Progress",         // or "Final", "Scheduled", "Postponed", etc.
  "innings": [
    { "num": 1, "home_runs": 0, "away_runs": 1 },
    { "num": 2, "home_runs": 2, "away_runs": 0 }
    // ...
  ],
  "play_by_play": [
    {
      "inning": 1,
      "is_top": true,
      "result": "Strikeout",
      "description": "Rafael Devers strikes out looking.",
      "pitches": [ /* pitch objects — see PBP format below */ ]
    }
    // ...one per plate appearance
  ]
}
```

---

## Games list (`GET /api/games?date=`)

```json
[
  {
    "game_pk": 745804,
    "home": "NYY",
    "away": "BOS",
    "status": "Final",
    "home_score": 5,
    "away_score": 3,
    "start_time": "2026-04-21T19:05:00Z"
    // plus additional MLB Stats API fields
  }
]
```

---

## Pitch data formats (two variants)

The dashboard handles two pitch formats depending on source.

### Statcast format (from Savant CSV)

Used by: pitcher card pitches, pitch data aggregation
```js
{
  pitch_type: "FF",
  pitch_name: "Four-Seamer",
  release_speed: 95.2,
  description: "called_strike",     // snake_case descriptor
  events: "strikeout",              // PA-level event on last pitch, null otherwise
  stand: "R",                       // batter handedness
  zone: 5,
  plate_x: -0.52,
  plate_z: 2.34,
  // ...all the Savant columns
}
```

### PBP format (from MLB Stats API play-by-play)

Used by: play-by-play modal, pitches nested inside game-linescore's PBP array
```js
{
  type: "FF",                       // Note: `type` not `pitch_type`
  pitchName: "Four-Seamer",
  speed: 95.2,                      // Note: `speed` not `release_speed`
  desc: "Called Strike",            // Title Case not snake_case
  result: "Strikeout",              // PA-level result (on parent PA, not pitch)
  isInPlay: false,
  zone: 5,
  // ...fewer fields than Statcast
}
```

### Normalization (`getTooltipResult` in `pitchFilters.js`)

Handles both by:
1. Reading `pitch.description` (Statcast) OR `opts.desc` override (PBP)
2. Reading `pitch.events` (Statcast) OR `opts.paResult` override (PBP)
3. Normalizing: `.toLowerCase().replace(/\s+/g, "_")` on both desc and event strings
4. Returning unified `{ label, color, isK, isCalledStrikeThree, subLabel, isError, errorOutType }`

See [07-BUSINESS-LOGIC.md](07-BUSINESS-LOGIC.md#tooltip-result-normalization) for the decision tree.

---

## Pitcher search / resolve

`GET /api/pitchers-search?q=cole`:
```json
[
  { "pitcher_id": 543037, "name": "Gerrit Cole" },
  { "pitcher_id": 600869, "name": "A.J. Cole" }
]
```

`GET /api/resolve-pitcher?name=Gerrit%20Cole`:
```json
{ "pitcher_id": 543037, "name": "Gerrit Cole" }
```

Both are accent-insensitive (`José` matches `Jose`).

---

## Pitch overrides (`GET /api/pitch-overrides`)

```json
{
  "745804_543037_3_2": { "new_type": "FC", "new_name": "Cutter" },
  "745804_543037_7_4": { "new_type": "FF", "new_name": "Four-Seamer" }
}
```

Key format: `{game_pk}_{pitcher_id}_{at_bat_number}_{pitch_number}`.

---

## Warmup status (`GET /api/warmup-status`)

```json
{
  "ready": true,
  "loading": false,
  "error": null,
  "progress": {
    "dates_loaded": 32,
    "dates_total": 32,
    "current_date": "2026-04-21"
  }
}
```

---

## Last refresh (`GET /api/last-refresh`)

```json
{ "timestamp": "2026-04-21T14:30:00Z" }
```

---

## Pitch type code ↔ display name

| Code | Display | Hex (from PITCH_COLORS) |
|---|---|---|
| FF | Four-Seamer | `#FF839B` |
| SI | Sinker | `#ffc277` |
| FC | Cutter | `#C59C9C` |
| SL | Slider | `#CE66FF` |
| ST | Sweeper | `#FFAAF7` |
| CU / KC | Curveball / Knuckle Curve | `#2A98FF` |
| CH | Changeup | `#6DE95D` |
| FS | Splitter | `#83D6FF` |
| FO | Forkball | `#78E0AE` |
| SC | Screwball | `#90C890` |
| KN | Knuckleball | `#A0A0A0` |
| EP | Eephus | `#A0A0A0` |
