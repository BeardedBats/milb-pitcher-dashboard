# MiLB Pitcher Dashboard

Staff-facing **minor-league** pitcher stats dashboard for PitcherList — a local-only fork of the MLB Pitcher Dashboard covering Triple-A through Rookie ball plus the Arizona Fall League. Game cards, season totals, strike-zone plots, velocity trends and play-by-play for the levels that have Statcast; box-score tables for the ones that don't.

**This app is local-only and has no deploy target.** No Vercel, no crons, no Upstash, no CI. It never shows major-league games.

## Stack

- **Frontend:** React 18 on Create React App (`react-scripts`), port 3847
- **Backend:** Python FastAPI on uvicorn, port 8000
- **Cache:** per-process in-memory L1 (Upstash Redis L2 is still supported if the env vars happen to be set, but nothing requires it)
- **Data:** Baseball Savant minor-league Statcast (`/statcast-search-minors/csv` with `minors=true`) + the MLB Stats API (schedules, box scores, live feeds, per-level game logs)

## Levels

| Level | sportId | Pitch data? |
|---|---|---|
| AAA | 11 | Yes — full Statcast |
| AA | 12 | No — box score only |
| A+ | 13 | No — box score only |
| A | 14 | No — box score only |
| R | 16 | No — box score only |
| AFL | 17 + leagueId 119 | Tried, but Savant publishes none — box-score card |

`backend/levels.py` is the single source of truth for this table, the MLB parent-org map, and `(org, level)` team display names.

## Running it

Double-click **`MiLB Pitcher Dashboard.vbs`** (starts both servers hidden, then opens the browser) or **`start-dashboard.bat`** (starts both in minimized windows).

Manually:

```bash
pip install -r requirements-dev.txt
```

Backend (port 8000):

```bash
cd backend && python -m uvicorn app:app --reload --port 8000
```

Frontend (port 3847), in a second terminal:

```bash
cd frontend && npm install && npm start
```

The frontend talks to `http://localhost:8000` in dev. On startup the backend kicks off a background warmup that pulls the season's AAA Statcast — the homepage works immediately, but org/team pages and season-context columns fill in once it finishes (a few minutes on a cold run).

Both servers use the same ports as the MLB dashboard, so run only one of the two at a time.

## Verify

- Frontend build: `cd frontend && npx react-scripts build` (slow — allow ~3 min)
- Frontend tests: `cd frontend && npx react-scripts test --watchAll=false`
- Backend import check: `cd backend && python -c "import app"`
- Backend tests: `python -m pytest backend/tests -q`

## Docs

- [BUILD-REPORT.md](BUILD-REPORT.md) — what this fork changed, per phase, and known gaps
- [DECISIONS.md](DECISIONS.md) — every judgment call made during the fork, with reasons
- [CLAUDE.md](CLAUDE.md) — working conventions: build commands, cache schema-version rules, component notes
- [docs/Claude-Project/](docs/Claude-Project/) — architecture, API surface, data schemas, business logic (written for the MLB app; the level-aware differences are in BUILD-REPORT.md)
