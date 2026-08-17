# Changelog

## Unreleased

### Added — "All Levels" filter on the daily pitcher leaderboard
The Level dropdown on the games page now offers **All Levels** alongside the six
real ones: every level's pitchers for the selected date, in one sortable table.
Until now the only way to see who threw well across the system on a given night
was to load six pages and compare them by eye.

- One row shape, one producer. All-Levels takes the box-score/play-by-play path
  at **every** level, AAA and AFL included, rather than Savant rows for those two
  and feed rows for the rest — so SwStr% under one header means one thing and a
  AAA line and an A+ line genuinely sort against each other. AAA's Statcast
  columns are unchanged and still live in the AAA view. Rows render in
  `AdaptedResultsTable`, each tagged with its own level in the Date cell.
- `ALL` is a pseudo-level (`levels.ALL_LEVELS`), deliberately not a member of
  `LEVELS`: it has no sportId. Every level-taking endpoint asks `is_all_levels()`
  **before** `normalize_level()`, which coerces anything unknown to AAA and
  would otherwise answer an all-levels request with Triple-A, silently.
- Leaderboard-only mode: `/api/games` and `/api/pitch-data` answer it with
  nothing, since a game tab and a pitch table each belong to one level. The tab
  strip hides, and the filter row now renders whenever All-Levels is selected —
  gating it on "are there games" alone would strand the user in a mode with no
  way back to a level.
- The fan-out reads the same `daily_results_box_{level}_…` key the single-level
  pages write, so a warm AA homepage makes the AA slice free and vice versa. It
  folds levels sequentially and drops each slate's raw feed payloads before the
  next, keeping peak memory at one slate. `warmup-daily` now also warms AAA/AFL
  box rows for the default date and the past week, so the common case is warm;
  the client allows a cold All-Levels build 120s instead of 45s.
- Org / SP-only / RP-only / MLB Green / Columns and the CSV export all work
  unchanged — the export follows the level like it always has and stamps each
  row's own level.

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
