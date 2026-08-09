# Changelog

## Unreleased

### Changed — Rehab is its own page at `/rehab`
The Rehab view was a toggle button inside the daily slate's filter row, which
made it un-linkable: it answered a question about a two-week window across every
level, but you could only reach it by loading a date and pressing a button.

- Promoted to a path route, `/rehab`, reachable from the top nav (a real anchor,
  so it can be middle-clicked and shared). `vercel.json` rewrites it to
  `/index.html`; without that rewrite the URL 404s in production.
- `homePath()` in `utils/navigation.js` is now the base for every hash URL and
  every "back to the games page" target, so a link built while on `/rehab`
  doesn't inherit that path.
- Table rework: date first (`MM-DD` + level tag), bold pitcher names, SwStr%
  before CSW% with Str% after it, a new average-velocity column (hyphen wherever
  the level isn't pitch-tracked), whole-number rates, dimmed zeros, Affiliate
  dropped, Opp hidden by default, and a Columns dropdown that can add Team.
- SwStr%/CSW%/velo are filled from the start's play-by-play feed, enriching only
  the latest start per pitcher (the one row rendered) under a 40s budget.

### Added — MLB Green toggle
A checkbox (games page and Rehab page, persisted) turns the green tint on
pitchers with major-league service on and off. Applied via an `.mlb-exp-on`
class at the app root, so every table follows one switch.

### Added — Regular Season pitch-mix display modes
Three optional ways to read the Regular Season pitch-mix table (the `Pitch Mix`
view with no pitch-type filter), live on both the game card and the player page
(shared `RegularSeasonTable`):

- **Distribution bar** — a `Raw columns | Distribution bar` dropdown (shown only
  in the Pitch Mix view) collapses the per-pitch usage columns into one
  100%-width stacked composition bar per start, in canonical arsenal order. An
  explicit faint "other" segment accounts for untracked mass (tracked usage
  summing to < 100). A one-row legend maps color → pitch.
- **Heatmap** — independent toggle tinting each usage cell by where its value
  falls within that pitch's own range across the displayed starts
  (column-relative; square cells; numbers stay legible, velo dims under tint).
  Disabled while Distribution bar is selected (no numeric cells to tint).
- **Approach-shift divider** — independent toggle drawing one labeled amber rule
  between two usage phases, gated to the vs LHB / vs RHB splits only, with a
  per-game pitch-to-side sample gate, a phase-length gate, and a significance
  floor (permutation test + total-variation-distance magnitude floor). Reports
  "no shift" rather than inventing a line on a flat/noisy pitcher.

Display choices persist as one shared preference (localStorage) across both
surfaces and every pitcher. Config constants live in
`frontend/src/utils/approachShift.js` (`MIN_SIDE_PITCHES=15`,
`MIN_PHASE_GAMES=3`, `MIN_TVD=8`).

No data-layer changes: per-game pitch-to-side counts were already available
client-side as `_handTotal` in the pitch-mix rows.
