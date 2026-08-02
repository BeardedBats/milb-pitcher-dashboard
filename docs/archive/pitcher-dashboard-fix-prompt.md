# pitcher-dashboard Fix Session

Three confirmed user-facing bugs documented with browser + backend
evidence. Your job is to find root causes and ship fixes — not audit,
not hypothesize, not brainstorm.

---

## Required Reading (do not skip)

Read these in order before touching anything:

1. `pitcher-dashboard-browser-data.md` — Browser DevTools captures
   showing the failures. **The "POPULATED DATE CAPTURE — Critical
   Findings" section at the end is the source of truth for this session.**
2. `pitcher-dashboard-vercel-findings.md` — Vercel runtime data
   (especially the cron failure pattern, which is the upstream cause
   for the cold-cache problem)
3. `CLAUDE.md` at repo root (and `frontend/CLAUDE.md` if present)
4. PR #4 diff: `gh pr view 4 --repo BeardedBats/Pitcher-Dashboard --json title,body,files`
   "Fix live range materialization bandwidth loop" — already shipped.
   Do NOT re-propose what this PR did.
5. `git log --oneline -20 main` — read diffs of any recent commit
   touching `hooks/`, `utils/`, `api/`, or anything Upstash-related.
   Recent Layer 3 work: "Stop polled linescore hook from wiping card
   data," "Bandwidth + UX cleanup."

If anything's missing, stop and tell Nick.

---

## The Three Confirmed Bugs

### Bug 1 — `/api/pitcher-results` 500s after ~38 seconds on cold cache
- Reproducible: load any past date with games via DatePicker
- Vercel logs corroborate at 15:02:43 and 15:02:50 UTC on 2026-05-21
- ~38s timing strongly suggests an application-level timeout
  (`asyncio.wait_for`, `httpx.Timeout`, or similar) — not the Vercel
  60s ceiling
- After the 500, subsequent calls to the same endpoint return 200 in
  ~98ms (the failed call did the cache-fill work, then died)

### Bug 2 — Frontend fires duplicate concurrent requests
- Every backend log entry appears in pairs within the same second
- Browser network tab shows each endpoint called 2-4x per date selection:
  `last-refresh` 4x, `pitch-data` 2x, `pitcher-results` 2x, etc.
- Not retry behavior (retries space by seconds) — simultaneous fires
  from independent React hooks/components
- Doubles backend load and amplifies Bug 1

### Bug 3 — Cold-cache cost is 4-8s even when calls succeed
- `pitch-data` cold: 8.51s. Warm: 77ms.
- `pitcher-results` cold: 7.28s. Warm: 98ms.
- Suspicious: cold calls return SMALLER payloads (9-10 kB) than warm
  calls (32-33 kB). Suggests a fast/partial path vs slow/full path
  in the route handler — verify what each is actually returning.

### Bug 4 (related upstream cause) — Daily cron warmup is failing
- `/api/cron/warmup-daily*` routes hit 504 or 500 at ~09:30-09:50 UTC
- When the daily warmup fails, today's data starts the day with a cold
  cache, which is what triggers Bugs 1 and 3 for the first user of the
  day
- Fixing this prevents Bugs 1 and 3 from recurring even after they're
  patched at the route level

---

## Recommended Fix Order

Your call to confirm or argue against, but my read:

1. **Bug 2 (double-fetch) FIRST.** Likely the simplest code fix, cuts
   backend load in half immediately, and reduces the chance of Bug 1
   firing in the first place. Quick win that compounds with everything
   downstream.
2. **Bug 1 (pitcher-results 500).** Find the ~38s timeout, decide
   whether to lower (and degrade gracefully), raise (and fix the slow
   upstream call), or refactor (split into faster + slower endpoints).
3. **Bug 4 (cron warmup).** Upstream cause. Even if Bugs 1/2 are
   fixed, a failed daily cron means today's first user still hits
   cold cache. Likely a sharding or memory-tier fix.
4. **Bug 3 (cold-cache cost).** Should partially resolve after Bug 1
   and Bug 4 are fixed. Remaining work likely involves
   stale-while-revalidate or a fast-fallback shape.

Tell me if you disagree on the order before starting.

---

## Workflow (strict, one bug at a time)

For each bug, in the agreed order:

1. **Investigate root cause in the actual code.** Use `view`, `grep`,
   `bash`. Do NOT guess. For Bug 1, find the timeout config. For
   Bug 2, find the hook(s) firing duplicates. For Bug 4, find the
   cron handler and what it's iterating.
2. **Stop and report findings to Nick.** Brief: "Root cause is X
   in `path/to/file.py:NN`. Here's why it produces the observed
   symptom." Do not propose fixes yet.
3. **Wait for Nick's nod on the diagnosis.** If he disagrees or wants
   you to dig further, do that. Don't rush past disagreement.
4. **Propose ONE fix.** Include:
   - The exact change (file, lines, before/after)
   - Why this fix vs alternatives (be specific about tradeoffs)
   - Effort estimate
   - Expected impact
   - **How you'll verify it worked** (specific metric or repro)
5. **Wait for explicit "yes, proceed."**
6. **Implement on a new branch.** Naming: `fix/bug-N-short-description`.
   Don't touch other bugs in the same branch.
7. **Verify.** Run locally if possible. Hit the route. Check the logs.
   For frontend fixes, capture a new DevTools trace and compare to
   baseline. For backend fixes, hit the endpoint with curl and check
   Vercel logs. Don't claim it works without proof.
8. **Open a PR** with a body that includes: the bug, root cause, fix
   approach, verification evidence. Nick uses Codex for PR review —
   write the PR description so a reviewer can verify your reasoning.
9. **Stop.** Wait for Nick to merge before moving to the next bug.

---

## Constraints

- **One bug per branch, one branch at a time.** No batched fixes.
- **No new dependencies** without explicit approval. If a fix needs
  SWR/React Query/QStash/etc., ask before adding.
- **No new infrastructure spend** without approval.
- **Don't re-propose what PR #4 or recent commits shipped.** If your
  fix overlaps with shipped work, say so explicitly.
- **Push back if you disagree.** If Nick's preferred fix is worse
  than an alternative you'd choose, say so with reasons. Sycophancy
  is a failure mode.
- **Don't touch the Electron wrapper unless a bug clearly involves it.**
  Web users are the priority.
- **Don't add observability/logging just for its own sake** during
  this session. If a fix genuinely needs new logging to verify, fine.
  Otherwise, stay scoped.

---

## What NOT to do in this session

- ❌ Re-investigate whether the bugs exist. They do. Evidence is in
  the docs.
- ❌ Brainstorm new hypotheses unprompted.
- ❌ Run a council / multi-expert review.
- ❌ Produce HTML briefs or status reports.
- ❌ Refactor unrelated code that catches your eye.
- ❌ Implement multiple fixes before Nick reviews any of them.

---

## Communication Style

- Direct. No preamble. No "Great question!"
- When you find something, lead with the finding. Reasoning second.
- Tell Nick what's in the code, not what might theoretically be in
  the code.
- If you can't determine root cause from the code alone, say so and
  ask for what you need (a specific log query, a runtime test, etc.).

---

## Start

Begin by confirming you've read all required documents, then state your
proposed fix order (agree with the recommendation above or argue
against it). Then start on Bug 1 in the agreed order.
