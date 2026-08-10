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

### Added — player pool mapped to current clubs, not last appearances
The pool the search bar loads (and the player-page header) knew only where a
pitcher had *appeared*. After a trade deadline that is the wrong answer for
weeks: a prospect who changes organizations keeps a last game played for his
old affiliate until he takes the ball for the new one — and never moves at all
if he is hurt.

- Every pool row is now stamped with the club the pitcher is on **right now**
  (`team`, `org`, `team_level`, `mlb_roster`), resolved from the MLB
  transaction feed via `mlb_status.get_current_teams` / `tag_current_team`.
  Season history (`teams`, `orgs`, `levels`) is kept intact and reordered
  current-first — the old affiliate is still where those innings were thrown.
- `current_level` and every stat are untouched: last game played remains the
  rule for anything derived from games. Only the club mapping consults the
  transaction feed, and `team_level` is deliberately named apart from it.
- Savant-side rows order `teams` by most recent appearance instead of first, so
  the head of the list is the current club even for pitchers the feed can't
  resolve. An unresolved pitcher is never blanked out.
- Search results now show the current club (`SWB · AA`, or `TB · MLB` for a
  pitcher who has been called up).
- `/api/cron/refresh-player-pool` (cron-secret guarded, on-demand) rebuilds the
  pool past every cache tier and reports the org changes it found, so a
  deadline-day refresh can be verified rather than assumed.

Both directory cache versions were bumped (`_DIRECTORY_VERSION`,
`PITCHER_DIR_VERSION`) — the `pitcher_dir:` key never expires, so without a
bump the old pool would have been served indefinitely.

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
