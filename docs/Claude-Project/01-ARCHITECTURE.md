# Baseball Dashboard — Architecture

> **Purpose of this doc:** Tech stack, directory layout, deployment topology, build/dev commands. Read this before touching infra or adding a new surface (new page, new cron job, new deploy target).

## Tech stack

| Layer | Tech | Notes |
|---|---|---|
| Frontend | React 18 (Create React App) | Port 3847 in dev. `BROWSER=none` set in `frontend/.env` to prevent double browser windows |
| Backend | Python 3 + FastAPI | Data aggregation, caching, MLB/Savant integration |
| Cache L1 | Python in-memory dicts | Per-process (`_cache`, `_season_cache`, `_batter_name_cache`) |
| Cache L2 | Redis (Upstash) | Persistent, cross-process, TTL-configured |
| Data sources | Baseball Savant CSV, MLB Stats API, Savant `/gf` endpoint (live WebSocket-style) | |
| Deploy | Vercel (serverless Python runtime) | Also runs scheduled cron jobs |

## Directory tree (top-level)

```
baseball-dashboard/
├── backend/                      # FastAPI app
│   ├── app.py                    # All endpoints
│   ├── aggregation.py            # Pitch + results aggregation, card builder
│   ├── data.py                   # Fetching, caching, boxscore lookups, warmup
│   ├── redis_cache.py            # Upstash Redis wrapper
│   └── pitch_overrides.json      # Reclassification JSON fallback
│
├── frontend/                     # React app (CRA)
│   ├── src/
│   │   ├── components/           # All UI components (see 04-FRONTEND.md)
│   │   ├── utils/                # api.js, pitchFilters.js, formatting.js
│   │   ├── hooks/                # useIsMobile, etc.
│   │   ├── App.jsx               # Root component, holds global state
│   │   ├── constants.js          # PITCH_COLORS, column defs, team mappings
│   │   ├── styles.css            # All CSS (dark theme, tables, tooltips)
│   │   └── index.js              # Entry
│   ├── build/                    # Production output (deployed by Vercel)
│   ├── .env                      # PORT=3847, BROWSER=none (copy from .env.example)
│   └── package.json
│
├── api/
│   ├── index.py                  # Vercel serverless entry — wraps backend app
│   └── requirements.txt          # Python deps installed by Vercel
│
├── docs/Claude-Project/          # ← this directory (schema docs for Claude Projects)
├── docs/archive/                 # Completed plans + past audit docs
│
├── vercel.json                   # Vercel config + cron schedule
├── CLAUDE.md                     # Project-specific Claude instructions
├── README.md                     # Stack, deployment, local-dev steps
└── design.md                     # Design token source of truth
```

## Deployment

### Vercel

`vercel.json`:

```json
{
  "buildCommand": "cd frontend && npm install && npm run build",
  "outputDirectory": "frontend/build",
  "rewrites": [
    { "source": "/api/:path*", "destination": "/api/index.py" }
  ]
}
```

- All `/api/*` requests are rewritten to `api/index.py` (Vercel Python serverless function).
- Frontend build output served from `frontend/build`.
- Auto-deploy on push to `origin/main`.

### Vercel cron schedule (UTC)

| Path | Schedule (cron) | Purpose |
|---|---|---|
| `/api/cron/materialize-ranges` | `*/5 * * * *` | Incrementally materialize season-range day snapshots |
| `/api/cron/warmup` | `0 0-4,17-23 * * *` | Off-season hourly warmup |
| `/api/cron/stat-corrections` | `50 7 * * *` | 3:50 AM ET (EDT) — re-fetch recent days to pick up stat corrections |
| `/api/cron/warmup-daily` | `0 8 * * *` | 4:00 AM ET (EDT) — daily homepage-cache refresh |
| `/api/cron/warmup-daily-2` | `5 8 * * *` | 4:05 AM ET (EDT) — season-wide team aggregations (Phase 2) |
| `/api/cron/warmup-daily-players` | `15 8 * * *` | 4:15 AM ET (EDT) — player pages for yesterday |
| `/api/cron/warmup-daily-cards` | `30 8 * * *` | 4:30 AM ET (EDT) — game feeds + season avgs + cards |
| `/api/cron/warmup-live-cards` | `*/10 16-23,0-5 * * *` | live card refresh during game hours |
| `/api/cron/warmup-live-game-views` | `*/2 16-23,0-5 * * *` | live game-view refresh during game hours |

All cron + materialize endpoints require `Authorization: Bearer $CRON_SECRET` (env var set in Vercel) — callers without the secret are rejected.

### Local dev

```bash
# Backend
cd backend && uvicorn app:app --reload --port 8000

# Frontend (separate terminal)
cd frontend && npm start     # serves on port 3847
```

Frontend API base URL logic (`utils/api.js`):
- Dev (`NODE_ENV === "development"`): `http://localhost:8000`
- Prod: `""` (same origin — Vercel rewrites handle routing)

## Scripts at repo root

| File | Purpose |
|---|---|
| `requirements-dev.txt` | Local dev/CI deps (`-r api/requirements.txt` + uvicorn + pytest) |
| `start-dashboard.bat` / `Pitcher Dashboard.vbs` | Local dev launch helpers |

## Cache busting version

`CARD_SCHEMA_VERSION` in `backend/data.py`. Bump whenever the cached card/season-totals payload shape changes — the version is embedded in Redis keys, so a bump invalidates all cached payloads safely.

## Environment variables

| Var | Used for |
|---|---|
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | L2 cache — the ONLY Redis env vars the code reads (`backend/redis_cache.py`); unset = graceful L1-only fallback |
| `CRON_SECRET` | Bearer token required by `/api/cron/*` + materialize endpoints on Vercel |

(Check `backend/redis_cache.py` for exact env lookup.)
