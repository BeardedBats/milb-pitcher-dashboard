# Browser DevTools Capture — pitcher-dashboard.vercel.app

**Captured:** 2026-05-21, non-game window (no live games running)
**Source:** Chrome DevTools Network tab, hard reload, cache disabled
**Purpose:** Layer 3 (React frontend) baseline data for the perf audit

---

## Non-Game-Window Baseline (THIS IS THE CLEAN BASELINE)

### Total initial load
- **Page weight:** ~285 kB total
- **Load time:** All resources complete by ~500 ms
- **Verdict:** Healthy baseline. Layer 3 baseline is NOT the problem.

### Resource breakdown

| Resource | Type | Size | Time |
|---|---|---|---|
| `pitcher-dashboard.vercel.app` | HTML document | 0.7 kB | 22 ms |
| `main.3b771680.js` | Main JS bundle | 96.2 kB | 168 ms |
| `main.ec4e8e1f.css` | Main CSS | 11.1 kB | 39 ms |
| Google Fonts CSS (DM Sans) | stylesheet | 0.7 kB | 84 ms |
| `/api/initial-load` | fetch (xhr) | 41.7 kB | 142 ms |
| `/api/last-refresh?date=2026-05-20` | fetch | 0.2 kB | 41 ms |
| `rP2y2ywxg089...woff2` font | font | 37.0 kB | 40 ms |
| `QGYsz_wNah...woff2` font | font | 50.4 kB | 37 ms |
| **`favicon.ico`** | **icon** | **46.8 kB** | **42 ms** |

Browser-extension noise excluded (`injection_script.js`, `content.min.css`).

### Key observations

1. **Main JS bundle is only 96.2 kB.** That's lean for a React app with
   components/hooks/utils directories. Code-splitting is probably already
   happening (CRA or Vite production build). **Bundle bloat is NOT a
   Layer 3 finding.**

2. **`favicon.ico` is 46.8 kB.** That's 10x larger than a typical favicon.
   Worth a 5-minute fix — re-export as optimized .ico with appropriate
   resolutions (16/32/64), should drop to <5 kB. Small impact but free win.

3. **`/api/initial-load` returned 41.7 kB in 142 ms.** This is the cache-hit
   happy path. Backend is fast when Upstash has the data. The audit's
   Layer 2 investigation must focus on the cache-MISS path, since the hit
   path clearly works.

4. **Only 2 API calls on initial load.** `/api/initial-load` and
   `/api/last-refresh`. No polling visible because no live games. Clean.

5. **No third-party scripts** in the trace. No ads, analytics, or
   trackers contributing weight.

---

## What this rules OUT of the audit

The non-game baseline cleanly eliminates these Layer 3 hypotheses:

- ❌ Main JS bundle too large
- ❌ HTML/CSS overhead
- ❌ Third-party script weight
- ❌ Slow initial backend response (when cache is filled)
- ❌ Static asset delivery (fonts, images on initial paint)

Do NOT spend audit cycles on these. Static delivery is already healthy.

---

## What the audit should focus on (Layer 3)

The user-facing slowness must be **dynamic and game-day-specific**:

1. **Polling fan-out under live game load** — each game card polling
   independently, multiplicative request count, possibly redundant fetches
2. **Re-render churn on polled data updates** — recent commit ("Stop
   polled linescore hook from wiping card data on every cardData change")
   suggests this was a known problem; verify it's fully resolved across
   ALL polling hooks, not just linescore
3. **API response degradation under cache-miss conditions** — when
   Layer 1 cron failures leave the cache empty, what does `/api/games`
   look like on the user side? Latency? Status?
4. **Card render cost at full slate** — rendering 12-15 game cards with
   live data may have N-square or N-times-update render cost
5. **Memoization gaps** in components downstream of polling hooks

---

## MISSING DATA — needs game-day capture

The following measurements require a capture during an actual live MLB
game window:

- Polling cadence (intervals between game-data XHRs)
- Request count over 30-60 seconds with games live
- Concurrent XHR count (is the browser ever waiting on > 6 requests?)
- Long Task durations from the Performance tab during data updates
- Total Blocking Time
- Memory growth over a 5-minute session

If a game-day capture isn't possible before the audit, Nick should at
minimum capture a **populated historical date** via the DatePicker
(e.g., last Saturday with 12-15 games) to see the populated-card initial
load behavior. That won't show polling but will show fetch volume and
initial render cost of the card grid.

---

## Quick wins surfaced by this capture

1. **Shrink favicon** from 46.8 kB to <5 kB. Tiny impact, but free.
2. **Verify font loading strategy.** 87 kB of fonts is fine if
   `font-display: swap` is set (prevents FOIT). If not, fonts can block
   first paint. Worth confirming in the audit.

---

## Performance Tab Capture (same session, 10.44s recording at idle)

### Main thread breakdown

| Category | Time | Read |
|---|---|---|
| Scripting | **11 ms** | App did essentially no JS work over 10s |
| Rendering | 162 ms | Normal |
| Painting | 129 ms | Normal |
| System | 167 ms | Browser internals |
| Total (recording) | 10,439 ms | 10.4 second recording |

### Memory & DOM stability

| Metric | Range | Read |
|---|---|---|
| JS heap | 7.6 – 8.0 MB | Tiny, healthy |
| Documents | 3 – 4 | Normal |
| DOM nodes | 2,076 → 2,083 | Stable, no churn |
| Event listeners | 258 → 276 | +18 over 10s — slight growth worth checking |

### 1st/3rd party attribution

| Source | Main thread time |
|---|---|
| `vercel.app` (1st party) | **1.1 ms** |
| [unattributed] (browser internals) | 467.2 ms |
| Browser extensions (Grammarly, cookie ext) | <1 ms |

### Annotation flagged by Nick during capture

A woff2 font file appears to be render-blocking on first paint. If
confirmed in the CSS (`@font-face` without `font-display: swap`, or
synchronous Google Fonts `<link>` without `media="print" onload`),
this is a real Layer 3 finding — fonts can delay First Contentful Paint
by 100-300 ms. Easy fix.

### What this rules out (additionally)

- ❌ Long tasks on main thread (none > 50ms visible at idle)
- ❌ Memory leak / heap growth
- ❌ DOM node thrashing
- ❌ Layout/style recalc storms at idle

### What it suggests to investigate (Layer 3)

- **Font loading strategy** — confirm `font-display: swap` is set on
  both woff2 files AND on the Google Fonts CSS import
- **Listener growth** — +18 listeners over 10s with no user
  interaction. If this pattern continues during active sessions, it
  could indicate hooks adding listeners without cleanup. Worth a grep
  for `addEventListener` and `useEffect` cleanup functions.

---

## Summary for the audit

The combined Network + Performance baseline establishes that the React
app at rest is healthy. Layer 3 investigation should focus exclusively
on **dynamic behavior under load** (polling, re-render under data
updates, request fan-out with populated game grid) — NOT on static
delivery, bundle size, or baseline rendering cost.

The font-blocking annotation is the one Layer 3 finding that can be
investigated from code alone.

---

## ⚠️ POPULATED DATE CAPTURE — Critical Findings ⚠️

**Captured:** 2026-05-21, ~15:02-15:03 UTC
**Scenario:** Hard refresh, then DatePicker → May 2 → May 1 (past dates
with games). DatePicker doesn't update URL, so refresh reverts to May 20.

This capture surfaced **CONFIRMED USER-FACING FAILURES**, not hypotheses.
These findings supersede the "missing data" notes above.

### FINDING #1 (CRITICAL): `/api/pitcher-results` times out at ~38s with 500

Two requests for `pitcher-results?date=2026-05-02` (today) ran for
**38.71s and 38.65s** before returning **500**. This is reproducible
in the browser AND confirmed in Vercel logs at the same timestamps.

**Vercel log corroboration (15:02-15:03 UTC, this exact session):**

| Time (UTC) | Path | Status |
|---|---|---|
| 15:02:43 | /api/pitcher-results | 500 (paired with 200) |
| 15:02:50 | /api/pitcher-results | 500 |
| 15:02:50 | /api/pitcher-results | 500 |
| 15:03:09 | /api/pitcher-results | 200 |
| 15:03:09 | /api/pitcher-results | 200 |
| 15:03:29 | /api/pitcher-results | 200 |
| 15:03:29 | /api/pitcher-results | 200 |

**Why the ~38s timing matters:**
- NOT the Vercel 60s ceiling (would fail at 60s)
- NOT Cloudflare's 524 timeout (100s)
- NOT standard `httpx` defaults (5s or 30s)
- Likely a custom `asyncio.wait_for(...)`, `httpx.Timeout(...)`, or
  application-level timeout. Audit must locate it in the route handler.

**Why the call pattern matters:**
- After the 500s, subsequent calls return 200 in ~98ms
- Classic cold-cache pattern: first caller eats the upstream latency,
  populates Upstash, subsequent callers hit the cache
- But the first caller's request fails entirely with 500, so they see
  nothing while the cache fills for the next person

### FINDING #2 (CRITICAL): Frontend fires duplicate concurrent requests

Every backend log entry appears in pairs within the same second.
Browser network tab confirms: each endpoint fires twice on a single
date selection. Examples:

- `last-refresh?date=2026-05-01` called 4 times in one date selection
- `pitch-data?date=2026-05-01` called 2 times (33.4 kB + 10.0 kB)
- `pitcher-results?date=2026-05-02` called 2 times (both 500'd)
- `last-refresh?date=2026-05-02` called 4 times

**This is not retry behavior.** Retries would space out by seconds.
These are simultaneous fires from independent React hooks/components
that aren't sharing a fetch layer.

**Likely root causes (for audit to verify):**
- Multiple components calling the same fetch hook without a shared
  cache (no SWR / React Query / homegrown dedupe layer)
- `useEffect` dependency arrays causing dual-mount or re-render
  refetches
- StrictMode double-invocation in development (but this is production)
- Two hooks subscribing to overlapping data (e.g., a list hook AND
  individual item hooks each fetching independently)

**Impact:** Doubles the backend load. When the cron warmup is broken
and the cache is cold, this doubles the cold-cache load too —
multiplying both Layer 2 stress and the chance of hitting the 500
condition.

### FINDING #3 (HIGH): Cold cache cost is 4-8s for successful calls

When the cache misses but the request doesn't 500, users still wait
multiple seconds:

| Endpoint | Cold call | Warm call |
|---|---|---|
| `pitch-data?date=2026-05-01` | 8.51s (10.0 kB) | 77ms (33.4 kB) |
| `pitcher-results?date=2026-05-01` | 7.28s (10.0 kB) | — |
| `pitch-data?date=2026-05-02` | 4.02s (9.7 kB) | 56ms (32.1 kB) |
| `pitcher-results?date=2026-05-02` | 38s+ (500) | 98ms |

**Payload size pattern is suspicious:** Cold calls return SMALLER
payloads (9-10 kB) while warm calls return LARGER payloads (32-33 kB).
This suggests either:
- The handler has a fast/partial path and a slow/full path
- The smaller response is an error envelope or fallback shape
- Different code paths produce different data shapes

Audit must read the route handlers to understand which path produces
which shape, and whether the "fast path" is even returning correct data.

### FINDING #4: DatePicker doesn't persist in URL

Hard refresh loses the selected date. Beyond UX, this means:
- Cannot share or bookmark a specific date's view
- Every fresh session starts on today's date (highest load, most likely
  to hit the broken cron + cold cache combo)
- Defeats CDN caching even if it were configured per-URL

### What changes for the audit based on this capture

**Phase 1 hypotheses now have direct evidence**, not just inference:
- Layer 2 cold-cache cost: confirmed at 4-38s
- Layer 2 application-level timeout near 38s: confirmed, audit must find
- Layer 3 request deduplication failure: confirmed, audit must find the
  cause in the hooks layer
- Layer 1 cron failure → user impact: confirmed via the 500s on today's
  data (which the daily cron failed to warm this morning)

**The audit can skip ahead to root cause analysis on these specific
findings**, since the symptoms are documented. Don't waste cycles
re-establishing whether these problems exist — go find why.
