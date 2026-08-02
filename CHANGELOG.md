# Changelog

## Unreleased

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
