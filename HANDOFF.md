# HANDOFF — two open issues

Repo: `BeardedBats/milb-pitcher-dashboard` (private), branch `main`, hosted on
Vercel (Pitcher List team) + Upstash. Read `CLAUDE.md` first — it holds the
non-obvious invariants (level rules, the two cache versions, the
`&minors=true` Savant trap).

Both issues below were surfaced while fixing "team pages never load" (fixed in
`bdd4a2e`..`HEAD`). Neither is currently breaking a user-facing page, but both
are real and issue 2 is actively burning money.

---

## Issue 1 — 202 responses trigger an unbounded client polling loop

### What happens

`frontend/src/hooks/useWarmupBackedResource.js` backs `TeamPage` and
`PlayerPage`. When an endpoint answers **202** ("cache rebuilding") it polls
warmup status and retries, with **no backoff, no attempt cap, and no give-up
state**.

Measured on production while `/api/org-page` was permanently 202:
**473 requests in 45 minutes** from ordinary browsing. Every one hit a
serverless function and Upstash. The user's experience was a spinner that never
resolved — the request wasn't failing, it was succeeding at "not ready" forever.

### Why it still matters

Team pages no longer 202 (they were decoupled from the season range), so the
loop isn't firing today. But the mechanism is unchanged: any endpoint that
returns 202 for a sustained period turns every open tab into a request
generator. `_loading_response` in `backend/app.py` is still used by
`/api/team-pitchers` and `/api/materialize-*`.

### Where to look

- `frontend/src/hooks/useWarmupBackedResource.js` — the polling loop
- `frontend/src/components/TeamPage.jsx`, `PlayerPage.jsx` — consumers
- `backend/app.py` → `_loading_response()` — what emits the 202

### Suggested direction (not prescriptive)

1. **Exponential backoff with a ceiling** — e.g. 2s → 4s → 8s … capped at ~30s.
2. **An attempt/time budget**, after which the hook surfaces a terminal state
   with a manual "Retry" affordance rather than polling forever. The app
   already has this pattern: `App.jsx` uses a `retryNonce` + Retry button on
   the error banner.
3. **Stop polling when the tab is hidden** (`document.visibilityState`) — a
   backgrounded tab currently polls at full rate indefinitely.
4. Consider having `_loading_response` return a `retry_after` hint the client
   honours, so the server controls pacing.

### How to verify a fix

Make an endpoint return 202 deliberately (easiest: point `useWarmupBackedResource`
at `/api/materialize-status?...` without a bearer, or temporarily force the
202 branch in `org_page`), open the page, and confirm in the Network panel
that request spacing grows and the loop terminates. Then check Vercel runtime
logs: `get_runtime_logs(group_by="statusCode", since="30m")` should not show
hundreds of 202s.

---

## Issue 2 — `/api/cron/materialize-ranges` is OOM-killed

### What happens

The cron 500s repeatedly. Vercel logs end with:

```
Savant range total: 611987 rows across 110 dates
Vercel Runtime Error: instance was killed because it ran out of available memory
```

**611,987 rows in a single pandas DataFrame** at `memory: 3009` (the max
configured in `vercel.json`). It also produced one 504.

Rate at the time of writing: **16 × 500 in 90 minutes** — it fires every 5
minutes and dies every time. That is continuous wasted function time and
Upstash commands.

### Diagnosis correction

An earlier message in the prior session called these timeouts. They are
**OOM**. The 504 was real but is a separate, less frequent symptom. Trust the
log line above.

### What has already been done (may be sufficient — verify before rebuilding)

Commits `HEAD~1`..`HEAD` changed `drain_pending_materializations` in
`backend/data.py` to be incremental:

- Bakes at most `MATERIALIZE_DAYS_PER_RUN` (12) missing days per invocation,
  under a deadline, calling `fetch_date(day)` per day so only one day is in
  memory at a time.
- Writes a heartbeat after each day; only marks the job `ready` when no days
  remain. Progress lives in the per-day `range_day` snapshots, so a killed
  invocation is harmless — the next tick resumes.
- `queue_range_materialization` now re-queues a `running` job whose heartbeat
  is older than `MATERIALIZE_STALE_AFTER` (15 min), so a killed run can't
  wedge the queue permanently (which is what made team pages unloadable).
- Day presence is a Redis membership set (`_baked_days_key`), not a snapshot
  load — loading 110 snapshots to test presence was itself part of the memory
  problem.

**This has NOT been confirmed working in production yet.** The last deploy went
out minutes before this handoff was written.

### First thing to do

Confirm whether the OOM is actually gone:

```
get_runtime_logs(projectId="prj_3Bv8FrPDl4lPQLw2K1LepdWuPW0c",
                 teamId="team_slidRWCy38f4VIO5qhov37Hg",
                 since="30m", statusCode="500", limit=3)
```

and check progress:

```bash
curl -s "https://milb-pitcher-dashboard.vercel.app/api/org-page?org=BOS" | head -c 200
```

The AAA block should eventually flip to `"statcast": true` with `csw_pct` /
`whiffs` present once enough days are baked. Until then it renders box-score
columns, which is correct and intentional.

### If it is still OOM-ing

The remaining hazard is `_fetch_savant_range_raw` in `backend/data.py`, which
concatenates every 5-day chunk into one frame before returning. Even 12 days is
fine, but any caller that still asks for a wide range will rebuild the big
frame. Check:

- `fetch_date_range(start, end)` — who else calls it with a season-wide window?
  `warmup_range_data` does, and `/api/cron/warmup` calls that. That cron may
  hit the same wall.
- Consider making `fetch_date_range` itself day-chunked and snapshot-backed
  rather than building one frame, or lowering `MATERIALIZE_DAYS_PER_RUN`.

### Related, worth a look while in there

`_load_persisted_range` reconstructs the whole season frame in memory for
`fetch_date_range_materialized`, which `/api/team-pitchers` and the season
context on `/api/pitcher-results` both use. If the season frame is genuinely
too big for 3009 MB, those endpoints are on borrowed time too, and the fix is
architectural: aggregate per-day and combine the aggregates, rather than
concatenating raw pitch rows.

---

## Context you will want

- **Verify commands**: `python -m pytest backend/tests -q` (82 passing),
  `cd frontend && npx react-scripts build` (allow ~3 min).
- **Two cache versions must move together** — `CARD_SCHEMA_VERSION`
  (`backend/data.py`, currently 47) and `_METRICS_VERSION`
  (`backend/boxscore_levels.py`, currently 3). See CLAUDE.md; getting this
  wrong has already caused stale production data twice. A bump is only real if
  the resulting key STRING changes.
- **Vercel IDs**: project `prj_3Bv8FrPDl4lPQLw2K1LepdWuPW0c`, team
  `team_slidRWCy38f4VIO5qhov37Hg`.
- **Deployment protection is off**, so production endpoints can be curled
  anonymously.
- Wide runtime-log queries time out; scope to `since="20m"` or a
  `deploymentId`, or use `group_by`.
