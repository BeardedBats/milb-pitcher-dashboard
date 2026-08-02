# Vercel Runtime Data Findings — pitcher-dashboard

**Pulled:** 2026-05-21 13:59 UTC
**Window:** Last 24-48 hours
**Source:** Vercel MCP

---

## Project Identity (confirmed)

- **Project ID:** `prj_R59B2n4Ux3ItHMma6VoBHaOCFRgM`
- **Team:** Pitcher List (`team_slidRWCy38f4VIO5qhov37Hg`)
- **GitHub repo:** `BeardedBats/Pitcher-Dashboard` (private)
- **Production domain:** pitcher-dashboard.vercel.app
- **Plan:** Vercel Pro (60s function timeout)

## CRITICAL: Stack Discovery (CONFIRMED)

**This is a monorepo: React frontend + FastAPI Python backend + Electron
desktop wrapper, all in one repo.**

Confirmed via GitHub repo inspection:
- `lambdaRuntimeStats: {"python": 1}` on every Vercel deployment
- `framework: null` on the Vercel project (custom `vercel.json` routes
  the static React build + Python functions)
- `frontend/` directory contains a vanilla **React + JSX** app (NOT
  Next.js — no `pages/`, no `app/`, just standard React structure with
  `src/App.jsx`, `src/components/`, `src/hooks/`, `src/utils/`)
- `frontend/public/index.html` confirms standard CRA or Vite structure
- Initial commit message: "Initial commit: Pitcher Dashboard (React +
  FastAPI + Electron)"

**Implications for the audit:**
- Frontend is pure CSR React — no SSR, no ISR, no hydration model.
  Initial paint depends on JS bundle load + client-side data fetch.
- Backend is FastAPI Python serverless — cold start sensitive, scales
  CPU with memory tier
- Cache strategy uses Upstash Redis directly (no Vercel Data Cache, no
  Next.js cache primitives)
- "Slow loading" complaints can originate at ANY of three layers:
  cron-fed cache fill, FastAPI cache read/upstream fallback, or React
  frontend (bundle, polling, re-renders)
- Electron wrapper exists but is likely out of scope for web-user
  complaints; flag if it shares code paths

### Recent perf-related commits worth reading (Layer 3)

These show active work on React performance — the audit must NOT
re-propose what's already shipped:

- "Stop polled linescore hook from wiping card data on every cardData
  change" (~last week) — React state churn fix in a polling hook
- "Bandwidth + UX cleanup: boxscore churn, today-str memo, retry button"
  (~last week) — memoization + bandwidth + retry UX
- "DatePicker: drop readOnly, intercept clicks via onMouseDown instead"
  (~last week) — input handler fix

Plus the Layer 1/2 commit:
- PR #4: "Fix live range materialization bandwidth loop"
  (`codex/bandwidth-timeout-followup`) — backend bandwidth fix

## CRITICAL: Where Timeouts Actually Live

**All 504s in the last 24h are on cron warmup routes. User-facing routes
returned 200 on every observed request.**

### Failures observed (last 24h):

| Time (UTC) | Route | Status |
|---|---|---|
| 09:50:50 | `/api/cron/warmup-daily-cards` | 500 |
| 09:40:12 | `/api/cron/warmup-daily-players` | 504 |
| 09:30:37 | `/api/cron/warmup-daily` | 504 |
| 04:00:45 | `/api/cron/warmup` | 504 |
| 02:50:24 | `/api/cron/warmup-live-cards` | 504 |

### User-facing route health (same window):

`/api/games` — observed ~26 hits, **all 200**, no failures or slow hits
captured. Sample timestamps: 09:29, 08:31, 08:29, 08:24, 03:29, 02:30, etc.

### What this means

The user-perceived "slow loading" is most likely a **cold cache symptom**,
not a slow user-facing route. The cron jobs exist to pre-populate Upstash
Redis with game data. When they time out (especially the daily batch),
the cache stays empty or stale, and the next user request has to fetch
from Baseball Savant / MLB Stats live — which is slow.

**Audit reframing:**
- Primary problem: cron warmup jobs failing to fill the cache
- Secondary problem: user-facing routes have no fallback when the cache
  is empty (they just wait on upstream APIs)
- The fix is upstream of where the slow load is observed

## Cron Cadence (observed pattern)

| Cron Route | Cadence | Status |
|---|---|---|
| `/api/cron/warmup-live-game-views` | every ~2 minutes | always 200 |
| `/api/cron/warmup-live-cards` | every ~10 minutes | mostly 200, occasional 504 |
| `/api/cron/warmup-daily*` | ~09:30-09:50 UTC daily | **all failed today** |
| `/api/cron/warmup` | ~04:00 UTC | 504 today |

**Suspect pattern:** the daily batch processes a much larger payload than
the 2-minute live jobs (which fan-out per active game). The daily jobs
likely loop over the full player or game roster in a single function
invocation and hit the 60s ceiling.

## Recent Deployment Activity

Four deployments in the last 24 hours, all `state: READY`:

| Time | Branch | Commit |
|---|---|---|
| Today 10:01 | main | "Remove stale MiLB references (#5)" |
| Today 09:00 | codex/remove-milb-remnants | "Remove stale MiLB references" |
| Today 08:43 | main | **"Fix live range materialization bandwidth loop"** (PR #4) |
| Today 08:41 | codex/bandwidth-timeout-followup | (same fix) |

**Important context:** Codex has already done at least one round of
timeout fixes on this project (PR #4, "bandwidth-timeout-followup").
The audit must not repropose the same fix. Read the PR diff and CLAUDE.md
to understand what was already tried.

## Data Caveats

- Broad 48h queries against `get_runtime_logs` timed out server-side
  before fetching all pages. The audit session should re-query with
  narrower windows (6-12h chunks) to ensure no 504s were missed.
- Error/fatal LEVEL queries returned no logs even when status-code-based
  queries did. The Python functions may not be emitting structured log
  levels — fixing log emission is itself a finding (you can't fix what
  you can't see).
- No Speed Insights data pulled here (Vercel MCP does not expose it
  directly). Confirm in the Vercel dashboard whether it's enabled.

## Pre-Audit Questions for Nick

Before the audit session starts, get answers to:

1. **What did the "bandwidth-timeout-followup" PR change?**
   Read the diff. Knowing what was already tried prevents wasted cycles.
2. **What's the expected payload size of the daily warmup vs the live
   warmup?** The asymmetry in failure rate suggests the daily job is
   doing too much in one invocation.
3. **Is there an Upstash MCP connected?** If yes, the audit session can
   pull cache hit ratio and slow command logs directly. If not, Nick
   should add it (https://github.com/upstash/mcp-server) before starting.
4. **Browser-side data during a live game.** Nick should capture from
   DevTools: bundle weight, slowest XHR, count of XHRs in first 10s,
   longest Long Task on Performance tab. Layer 3 cannot be audited
   from code alone.

## Recommended Audit Refocus (THREE LAYERS)

Original scope: "homepage, live game cards, game card pages, last 2 days"

Recommended revised scope (Nick confirmed user-facing slowness is real):

1. **LAYER 1 — Cron warmup machinery (PRIMARY suspect by data):**
   why is the daily batch timing out, what's it doing in 60+ seconds,
   can it be sharded or moved off serverless
2. **LAYER 2 — FastAPI cache read + upstream fallback:** how does the
   backend behave on cache miss? Is there stale-while-revalidate? Are
   upstream fetches concurrent? Region-aligned with Upstash?
3. **LAYER 3 — React frontend:** bundle size, polling cadence, re-render
   patterns, request deduplication, waterfall fetches, hook dependency
   correctness. Recent commits show active work here — verify state.

The three layers are connected (broken crons → cold cache → slow
backend → frontend waits → user sees slow load), but the FIXES are
independent. Rank cross-layer by impact-per-effort, not within layers.

**Nick must capture browser-side data during a live game** for Layer 3
investigation — DevTools Network/Performance tabs. The audit cannot
measure Layer 3 from code alone.
