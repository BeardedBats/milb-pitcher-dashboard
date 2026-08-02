# BUILD REPORT — MiLB Pitcher Dashboard

A fork of the MLB Pitcher Dashboard, converted to cover minor-league pitchers
(AAA through Rookie, plus the Arizona Fall League) and nothing else.

Built in five gated phases. Every gate below was executed against the running
app, not reasoned about.

> **Status.** Phases 1–5 below built this as a local-only app. It was
> subsequently deployed to Vercel + Upstash — see "Deployment" at the end for
> what that changed. `main` is now the deployed branch; local dev still works
> unchanged.

---

## Headline finding: the spec's data source was wrong

The spec described the AAA pitch source as
`https://baseballsavant.mlb.com/statcast-search-minors/csv` with the existing
MLB query params and `hfLevel` empty, and reported that it "misses some AAA
games (tested: 10 of ~15 on 2026-07-30)."

That URL returns **major-league** data. Verified: for 2026-07-30 it produced 10
game_pks, and `game_pk 824568` resolves via statsapi to *Yankees @ White Sox,
sportId 1*. All ten were MLB games — the "10 of ~15" was the MLB slate, not a
partial AAA one.

The missing piece is **`&minors=true`**, which Savant's own search bundle
appends to every CSV download (`…/csv?<query>&type=details&all=true&minors=<isMinors>&wbc=<isWbc>`).
With it:

| Query | Result for 2026-07-30 |
|---|---|
| Spec's URL | 10 game_pks — all MLB |
| `+ minors=true` | 23 game_pks — all MiLB (18 AAA + 5 Single-A FSL) |
| `+ minors=true&hfLevel=AAA\|` | **18 game_pks — exactly the AAA schedule** |

So **AAA Savant coverage is complete, not partial**. The MLB-live-feed backfill
was still built exactly as specified (the coverage rule is locked), and it does
fire on the dates that genuinely have gaps — see the Phase 2 gate.

Two smaller corrections, same category:
- **Minors gameTypes are only `R` and `PO`.** The MLB set (`S|E|W|D|L|F`) returns nothing.
- **AFL has no Savant Statcast at all.** Checked 2025-10-15: 3 AFL games on the schedule, 0 CSV rows. The spec's "try savant first, else box score" ordering is implemented as written, but the box-score fallback is the operative AFL path in practice, not an edge case.

---

## Phase 1 — Fork cleanup + local run

**Deleted:** `vercel.json`, `api/` (both files), `.github/workflows/` (CI +
trigger-warmup), `.vercelignore`, the weather endpoint and its stadium-coords
tables, the next-three-starts feature end to end (`NextStartsStrip.jsx`, the
Google-Sheets schedule scraper, `/api/pitcher-schedule`, `fetchPitcherSchedule`,
and the PlayerPage next-starts block), all 8 cron endpoints, the
materialize-range/status admin endpoints, `_IS_SERVERLESS`, and the Savant
arm-angle leaderboard fetch.

**Kept but relocated:** `api/requirements.txt` → `backend/requirements.txt`
(it is the canonical pinned dep set; `requirements-dev.txt` now includes it
from there).

**Rewritten:** range materialization now runs **in-process** — a daemon thread
per range with status in a module dict. Upstream it queued into Redis for a
Vercel cron to drain; with the crons gone and Redis optional locally, that queue
would never drain and every season-range endpoint would have returned a
permanent 202 "rebuilding."

**Launchers:** `start-dashboard.bat` and `MiLB Pitcher Dashboard.vbs` (renamed
from `Pitcher Dashboard.vbs`), both with distinct window titles.

**Pre-existing `milb`/`minor`/`sport_id` exclusion logic:** grepped for; none
present. This copy does not contain the `codex/skip-milb-for-mlb-only-pitchers`
merge or a `milb_constants.py`, and no `.pyc` files exist.

**GATE — passed.** `python -c "import app"` OK · 46 backend tests pass (the 20
cron/materialize bearer-auth cases were deleted with their endpoints; the
date-validation cases were kept) · 25 frontend tests pass · `npx react-scripts
build` succeeds · uvicorn boots and serves `/api/default-date`.

*(node_modules was absent in the fresh copy — `npm ci` was needed before the
first build.)*

---

## Phase 2 — Data layer

**New `backend/levels.py`** — the single owner of the level registry (AAA=11,
AA=12, A+=13, A=14, R=16, AFL=17+leagueId 119), per-level schedule URLs, the MLB
parent-org map from `/api/v1/teams?sportId=N`, and `(org, level)` team display
names. Nothing else hardcodes a sportId. MLB (sportId 1) appears nowhere.

**All three Savant URLs** switched to the minors endpoint — `SAVANT_CSV_URL`,
`SAVANT_RANGE_URL` *and* `SAVANT_PITCHER_SEASON_URL`. Converting only the daily
one would have left player pages and season averages silently major-league.

**Level resolution:** the minors CSV has no level column, so `_apply_levels`
(single date) and `_apply_levels_multi_date` (range/season) classify each
`game_pk` against the per-level schedules, tag rows, and drop everything outside
AAA/AFL. A total schedule-fetch failure drops the day's rows rather than passing
them through untagged — mislabeling Single-A as AAA is worse than a retry.

**Backfill:** `_fetch_missing_from_mlb_api` now spans every Statcast level and
fills any game the CSV lacks from the MLB live feed.

**Cache keys** all carry a level scope, and `CARD_SCHEMA_VERSION` went 43 → 44
(nothing cached under 43 describes minor-league games).

**GATE — passed**, date 2026-07-30:
- `/api/games?level=AAA` → **18 games**, matching the sportId=11 schedule exactly, `has_data` true on all 18, each row carrying level + `home_org`/`away_org` (e.g. `TOL @ COL | AAA | DET @ CLE`).
- `/api/pitch-data?level=AAA` → **519 rows, 138 pitchers, 18 games**; velo 31.7–100.6, IVB populated on 517/519.
- `/api/pitcher-results?level=AAA` → **138 rows across 18 games**, 36 SP / 102 RP (= 18 games × 2 starters).
- **Backfill proven separately:** on 2026-06-10 Savant had 14 of 15 AAA games; the fallback fetched the missing one and the final frame had all 15.

---

## Phase 3 — Main game log, level + org dropdowns, adapted table

Level and MLB-org dropdowns sit in the existing filter row beside SP/RP. Level
is persisted (`pl_milb_level`) and threaded through every date-scoped fetch;
org is a client-side filter on the `org` field rows already carry. Changing
level re-pulls the slate and clears the selected game (a AAA `game_pk` is
meaningless at AA).

**New `AdaptedResultsTable.jsx`** for non-Statcast levels:
`Date+Lvl | Pitcher | Team | Opp | Dec | IP | H | R | ER | BB | K | HR | BF | P | Str% | GO/AO`.
Deliberately a separate component rather than a stripped-down
`PitcherResultsTable` — that table is built around CSW%/whiffs/velo deltas that
do not exist below AAA. The only derived values are `Str% = strikes/pitches` and
`GO/AO = groundOuts/airOuts`, both from fields the box score supplies directly.
The Pitch Data tab is hidden entirely at those levels.

**SP/RP filter** still reads `row.role === "SP"`; `boxscore_levels.py` sets
`role` from the box score's `gamesStarted` (falling back to first-pitcher-used),
matching the Statcast pipeline's rule.

**GATE — passed.** `/api/pitcher-results?date=2026-07-30&level=AA` → **122 rows
across 15 games** (= the AA schedule), adapted columns present, zero Statcast
keys on the rows, 30 SP / 92 RP, `team_display` = `Akron RubberDucks (CLE, AA)`.
Frontend build passes.

---

## Phase 4 — Player pages

The Regular Season log is now the **merged all-levels** log: one
`/people/{id}/stats?stats=gameLog&sportId=N` call per level (6, in parallel),
deduped on `game_pk`, sorted chronologically, each row tagged with its level.
AAA rows are then enriched in place with the Statcast columns (CSW%, whiffs,
PAR%, pitch mix) from the Savant log, matched on `game_pk`; other levels simply
lack those keys and render as em dashes. AFL rows live inside this same list,
tagged AFL — not a separate section.

The **Savant table is AAA-only**: the frame is filtered to `level == "AAA"`
before any pitch summary is computed (so an AFL outing can't leak into a
regular-season pitch mix), and when a pitcher has zero AAA games the backend
**omits `pitch_summary` / `pitch_summary_vs_l` / `pitch_summary_vs_r` /
`per_game_summaries` / `pitches` from the payload entirely** — no empty state,
no note. `current_level` is the level of the last game played; rosters and
active status are never consulted.

**GATE — passed**, all three required cases:

| Case | Pitcher | Result |
|---|---|---|
| (a) AAA pitcher | 801594 Ryan Gallagher | Savant table present (6 rows); 20-game log tagged AAA×16, AA×4 |
| (b) 2+ levels | 814351 Lucas Braun | 19 games in one log — AAA×10 + AA×9, correctly tagged; Savant table = AAA rows only |
| (c) zero AAA | 814482 Peyton Stumbo | Savant keys **absent** from payload; 20 AA games; `has_aaa_data: false` |

Case (c) initially rendered nameless — a pitcher with no AAA games has no Savant
rows, and identity came only from that frame. Fixed by falling back to the MLB
people endpoint (`get_person_info`) and deriving `teams` from the log.

---

## Phase 5 — Game cards + team pages

**Cards** exist for AAA and AFL only. The Statcast card is unchanged apart from
carrying `level`, `team_display`, `opponent_display`, `org` and
`card_type: "statcast"`. When `get_pitcher_card` finds no Statcast rows for a
game that belongs to a card-eligible level, `_build_boxscore_card_payload`
renders the box-score card instead (`card_type: "boxscore"`, empty pitch
collections so downstream `.map`s stay safe).

**Team pages route per MLB org** via a new `/api/org-page`: one block per
affiliate, highest level first, formatted like the main table's team-separation
mode. AFL never appears (its clubs report `parentOrgName: "Office of the
Commissioner"` and have no parent org). The header Teams dropdown now lists the
30 real orgs from the backend rather than `TEAMS_LIST`, which still carried WBC
and legacy-MLB entries with no farm system.

Sub-AAA affiliate blocks are filled from one
`/api/v1/stats?stats=season&group=pitching&teamId=…&sportId=…` call per team.
The alternative — walking each affiliate's schedule and pulling a box score per
game — would have been several hundred requests per org page.

**GATE — passed.**
- `/api/pitcher-card?date=2026-07-30&pitcher_id=687060&game_pk=815355` → full card: `card_type: statcast`, level AAA, **48 pitches**, 6 pitch types (4 vs L / 4 vs R), box score `IP 4.1 · 3 H · 2 K · 2 ER · CSW% 25.0 · Str% 66.67`, season totals `13 G / 42.1 IP / 36 K`, 21-game player-page log, per-pitch `sz_top`/`arm_angle`/`batter_name` present. `team_display` = `Albuquerque Isotopes (COL, AAA)`.
- `/api/org-page?org=LAD` → every affiliate populated, highest level first:

  | Level | Team | Statcast | Pitchers |
  |---|---|---|---|
  | AAA | Oklahoma City Comets | yes | 34 |
  | AA | Tulsa Drillers | no | 25 |
  | A+ | Great Lakes Loons | no | 26 |
  | A | Ontario Tower Buzzers | no | 37 |
  | R | ACL Dodgers | no | 39 |
  | R | DSL LAD Bautista | no | 22 |
  | R | DSL LAD Mega | no | 24 |

- Frontend build passes; 46 backend + 25 frontend tests green.

---

## Final smoke test (both servers running)

Backend on 8000, CRA on 3847, driven through a real browser:

- **Homepage loads AAA** for the current slate (2026-08-02) — 8 starters across live AAA games, all affiliate teams: `BUF 0 - LHV 3 (T3)`, `IND 1 - LOU 3 (T4)`, `WOR 1 - NOR 1 (T4)`, `TOL 1 - COL 5 (B3)`. Statcast columns populated (CSW%, STR%, PAR%, FB MPH, EXT). Zero console errors.
- **Live updates work** — between two reads the scores and IP advanced (Keller 2.0 → 2.2 IP, WOR/NOR B3 → T4).
- **Switching Level to AA** re-pulled the slate and rendered the adapted table: `DATE(+AA tag) | PITCHER | TEAM(+org tag) | OPP | DEC | IP | H | R | ER | BB | K | HR | BF | P | STR% | GO/AO`, with the Pitch Data tab correctly hidden. Switching back to AAA restored the Statcast table and the tab.
- **Level choice persists** across reloads (localStorage), as designed.
- Titles updated: browser tab → "MiLB Pitcher Dashboard", header → "MiLB Pitch Dashboard", FastAPI title → "MiLB Pitcher Dashboard API".

---

## Known gaps

1. **AFL is structurally implemented but unexercised.** The 2026 AFL season runs in October, after today's date (2026-08-02), so no AFL game exists to render. The savant-first / box-score-fallback path was verified by construction and against the 2025 AFL schedule (which confirmed 0 Savant rows), but no AFL card has been rendered end to end.
2. **`/api/org-page` returns 202 until the season warmup finishes.** AAA blocks read the materialized season range, which takes a few minutes to build on a cold start (and, without Redis, rebuilds each time the backend restarts). The endpoint returns a loading response rather than an empty table, and the frontend shows the rebuild message — but the first org-page view after a restart is a wait.
3. **`arm_angle` is absent from pitch-*table* rows.** This is pre-existing upstream behavior (`_aggregate_pitch_df` never emitted it — only the card's `build_pitches_list` resolves arm angle), not a MiLB regression. Card arm angles work and come from the CSV's native per-pitch values (99.5% populated on AAA).
4. **Sub-AAA rows fetched then discarded.** With `hfLevel` empty per spec, the minors CSV also returns Single-A Florida State League tracked-park rows, which are filtered out after level tagging. Harmless, but it is bandwidth spent on data the app never shows. Setting `hfLevel=AAA|` would avoid it at the cost of deviating from the spec.
5. **Ports are unchanged (8000 / 3847).** The spec locks 3847, so this app and the MLB dashboard cannot run at the same time.
6. **Pre-existing lint warnings remain** (unused vars, exhaustive-deps) in `VelocityTrend*`, `TeamPage` and others. They predate this work and the build treats them as warnings.

---

## Running it

Double-click **`MiLB Pitcher Dashboard.vbs`** (starts both servers hidden, waits
for the frontend, opens the browser), or **`start-dashboard.bat`** (both in
minimized windows).

Manually:

```bash
pip install -r requirements-dev.txt
```

```bash
cd backend && python -m uvicorn app:app --reload --port 8000
```

```bash
cd frontend && npm install && npm start
```

Then open **http://localhost:3847**.

Verification commands:

```bash
cd backend && python -c "import app"
```

```bash
python -m pytest backend/tests -q
```

```bash
cd frontend && npx react-scripts build
```

---

## Deployment

The app is hosted on Vercel + Upstash. This section records what had to change
from the local-only build to make that work.

### The three rewrites that had to be undone

Each of these worked locally and would have failed **silently** on serverless —
no error, just wrong or absent behavior.

| Local-only build | Why it breaks on Vercel | Fix |
|---|---|---|
| Materialization ran in a `threading.Thread` | The function is frozen once its response is sent, so the thread may never finish; status lived in a per-instance dict the next invocation can't see | Redis queue + `drain_pending_materializations`, drained by `/api/cron/materialize-ranges` |
| `on_startup` called `start_warmup()` unconditionally | Every cold start would begin a full-season Savant fetch across all Statcast levels | `_IS_SERVERLESS` guard restored |
| `boxscore_levels` caches were module-level dicts | Every cold start re-ran 6 gameLog calls per player page and one request per affiliate per org page | All four caches are L1 dict + Redis L2 |

The cache rework stores **derived rows** rather than raw payloads: a box score
is hundreds of KB and would exceed Upstash's per-request limit for a full slate,
while one game's adapted rows are a few KB. Final games cache for a day, live
games for a minute.

### Level-aware crons

The MLB crons assumed one slate a day. Six levels changes that:

- `_final_game_pks_for_date` no longer hardcodes `sportId=1` — it sweeps the Statcast levels
- `warmup-daily` loops all six levels under a deadline; Statcast levels get pitch + results, the rest get the box-score table
- `warmup-daily-2` warms per-affiliate season stats across all 30 orgs (org pages are the expensive page in this build)
- `warmup-daily-players` collects pitchers from every level, not just AAA
- `warmup-daily-cards` and both live crons are restricted to AAA + AFL, where cards exist at all
- `stat-corrections` drops the box-score levels' daily caches for the swept window (they have no pitch lines to diff)
- the `game_view` cache key carries the level

### Schedule

Daily jobs run 07:00–08:20 UTC at 20-minute spacing. Two constraints set that
window: each job now does ~6x the work so the old 5-minute gaps would overlap,
and 09:00 UTC is 5:00 AM EDT — exactly the `get_default_date()` rollover, where
a job would warm the wrong slate. Live windows widened to `15-23,0-6` UTC to
cover West Coast AAA.

Requires Vercel **Pro**: the sub-daily schedules and `maxDuration: 300` are not
available on Hobby.

### Known deployment gotchas

1. **`vercel.json` must be in the deployed branch.** Deploying `main` (which has none) produces an empty build — Vercel runs for ~99ms, writes no output, and reports READY. The import screen's suggested multi-service config is only a proposal; it does nothing unless committed.
2. **`.gitignore` had a bare `public/`**, which also matched `frontend/public/` and kept `index.html` out of the repo. Any fresh clone failed with "Could not find a required file: index.html". Fixed on `main` in `7cb7b55` by anchoring the rule to `/public/`.
3. **Deployment Protection** (team SSO) 302s every anonymous request. That is correct for an internal tool, and Vercel crons bypass it — but browser verification needs a protection-bypass token or a logged-in session.
