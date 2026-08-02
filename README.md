# MiLB Pitcher Dashboard

Staff-facing **minor-league** pitcher stats dashboard for PitcherList — a fork of the MLB Pitcher Dashboard covering Triple-A through Rookie ball plus the Arizona Fall League. Game cards, season totals, strike-zone plots, velocity trends and play-by-play for the levels that have Statcast; box-score tables for the ones that don't.

It never shows major-league games.

## Stack

- **Frontend:** React 18 on Create React App (`react-scripts`), port 3847 in dev
- **Backend:** Python FastAPI — uvicorn locally, one Vercel serverless function (`api/index.py`) in production
- **Cache:** per-process in-memory L1 + Upstash Redis L2 (`backend/redis_cache.py`)
- **Jobs:** 9 Vercel crons (schedules in `vercel.json`) for warmup and range materialization, authenticated with `CRON_SECRET`
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

## Deployment

Hosted on Vercel (Pitcher List team) at `milb-pitcher-dashboard.vercel.app`, backed by Upstash Redis. Pushing to `main` auto-deploys to production; branches get preview deployments.

Requires Vercel **Pro** — `maxDuration: 300` and the sub-daily cron schedules are not available on Hobby.

Env vars (Vercel → Settings → Environment Variables):

| Var | Purpose |
|---|---|
| `UPSTASH_REDIS_REST_URL` | L2 cache — REST URL, not the `redis://` string |
| `UPSTASH_REDIS_REST_TOKEN` | L2 cache |
| `CRON_SECRET` | Bearer token the cron + `/api/materialize-*` endpoints require. Vercel sends it automatically on cron invocations. |

Without Redis the app still serves (L1-only), but season-range endpoints will report the cache as unavailable.

**Gotcha:** `vercel.json` must exist in the deployed branch. A branch without it builds to an empty output in ~99ms and still reports READY — the import screen's suggested multi-service config is only a proposal and does nothing unless committed.

## Running it locally

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

The frontend talks to `http://localhost:8000` in dev; in production the API is same-origin via the Vercel rewrite. On startup the backend kicks off a background warmup that pulls the season's AAA Statcast — the homepage works immediately, but org/team pages and season-context columns fill in once it finishes (a few minutes on a cold run). That warmup is skipped on Vercel (`_IS_SERVERLESS`); the crons handle it there.

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
