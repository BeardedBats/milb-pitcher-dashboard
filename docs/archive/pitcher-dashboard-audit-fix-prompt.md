# Pitcher Dashboard — Audit Fix Implementation Prompt

**Paste this whole file as the first message to a fresh Claude Code session in the `baseball-dashboard` repo.** It is self-contained: a four-dimension audit was completed 2026-06-10 and this is the execution handoff. Do the work in the PR order below. Do **not** re-run the audit.

---

## 0. Ground rules — read before touching anything

1. **`main` auto-deploys to production** (pitcher-dashboard.vercel.app) and it's baseball season. **Never push unverified code to `main`.** Work on a branch, push the branch, open a PR, let Vercel build the preview, verify, then merge. This matches the repo's existing PR workflow (#9–#36).
2. **Concurrent sessions are common here.** Before starting: `git fetch origin && git status`. Local `main` is often behind `origin/main` — rebase/reset to `origin/main` before branching. The working tree usually carries **unrelated WIP** (e.g. uncommitted `frontend/src/App.jsx` changes: scroll-to-top + remount-key + loading-bar tweaks — leave them alone) and untracked files (`.claude/`, several `pitcher-dashboard-*.md` working docs including this one). **Stage only the specific files your task touches. Never `git add -A`.**
3. **Verify every change.** Frontend: `cd frontend && npx react-scripts build` (180s timeout, slow). Backend: `cd backend && python -c "import app"`. Behavioral/data fixes: verify yourself (live A/B against the deployed preview, or a test). Visual/UI changes: describe what to look at and let Nick confirm.
4. **Bump `CARD_SCHEMA_VERSION`** (`backend/data.py`, currently 38) whenever you change cached-payload shape or cache semantics — it evicts stale Redis entries. The version's changelog comment block doubles as an incident log; add a line.
5. **Line numbers below are as of 2026-06-10 and may have drifted** (uncommitted WIP + concurrent edits). Locate edits by the quoted code, not the line number.
6. **Commit messages** end with the Claude co-author trailer. Keep PRs focused — one milestone per PR unless noted.

---

## 1. Context snapshot (don't re-derive)

- **Stack:** React 18 on Create React App (`react-scripts 5.0.1`, *not* Vite) → static build on Vercel. FastAPI backend in 3 big files (`backend/app.py` ~2242 ln, `data.py` ~3387, `aggregation.py` ~1293) + `redis_cache.py`, deployed as ONE Vercel serverless function at `api/index.py` behind a `/api/*` rewrite. Upstash Redis L2 cache + per-instance dict L1. 8 Vercel crons in `vercel.json`.
- **Deeper context lives in** `docs/Claude-Project/` (8-file pack — good but slightly stale; you'll refresh it) and the session memory file `project_audit_2026_06_10.md`.
- **Audit grade: C.** Works and ships fast; real risks are silent data corruption, open mutating endpoints, and zero CI between a merge and prod.

### Decisions already made by Nick (do not re-ask)
- **Electron desktop path is DEAD** → delete it.
- **`CRON_SECRET` IS set** in Vercel (Production + Preview) → crons are protected today; still ship the fail-closed code fix as hardening.
- **`bulk_warmup.py` → DELETE** (crons handle warmup; the script's keys are stale and it poisons live card caches).
- **Auth → Vercel Deployment Protection** (Nick toggles in dashboard; free tier = team-members-only, fine while solo).
- **CRA→Vite migration is DEFERRED** (it was bundled with the Pitcher Video Viewer merge, now on hold). Add ESLint to CRA now regardless.

### Already verified (don't redo)
The old "every endpoint fetched 2-4× per date change" bug is **largely fixed** — `games`/`pitch-data`/`pitcher-results` each fire exactly once now. The only residual: **`/api/last-refresh` fires twice** per date change (see PR C, task C6).

---

## 2. ⚠️ Vercel env var situation — verify before deleting anything

`backend/redis_cache.py:19-24` resolves Redis creds in this order:

```
url   = Pitcher_Dash_KV_REST_API_URL  or  UPSTASH_REDIS_REST_URL  or  KV_REST_API_URL
token = Pitcher_Dash_KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN or KV_REST_API_TOKEN
```

The Vercel project currently has **13 env vars**:
- **3 clean (Sensitive, encrypted, May 12-13):** `CRON_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- **10 legacy ("Needs Attention", plaintext, Mar 22 + Apr 13):** `Pitcher_Dash_KV_REST_API_URL`, `Pitcher_Dash_KV_REST_API_TOKEN`, `Pitcher_Dash_KV_URL`, `Pitcher_Dash_KV_R…_READ_ONLY_TOKEN`, `Pitcher_Dash_REDIS_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`, `KV_URL`, `REDIS_URL`

**The catch:** because `Pitcher_Dash_KV_REST_API_URL/TOKEN` come **first** in the `or` chain and are set, **those Apr-13 "Needs Attention" vars are the creds actually in use right now** — the clean Sensitive `UPSTASH_*` ones are currently unused fallbacks. So a blind "delete all Needs Attention vars" would switch the app to the `UPSTASH_*` creds, and **if those point to a different/empty Upstash database the cache goes cold** (not catastrophic — crons rewarm — but a visible slowdown during games). Neither you nor I can read the hidden values. The safe consolidation is **PR D** below, gated on Nick confirming the values match.

---

## 3. Work plan (PRs in order)

### PR A — Cleanup & docs (zero behavior risk, do first)

- **A1. Delete the dead Electron/desktop path.** `git rm -r` these tracked files: `electron/`, `.github/workflows/build-mac.yml`, root `package.json` + `package-lock.json`, `build-win.bat`, `build-mac.sh`, `BUILD.md`, `Dockerfile`, `.dockerignore`, root `index.py` (the live entry is `api/index.py`; `.vercelignore` already excludes root `index.py`). Confirm `vercel.json` build (`cd frontend && npm install && npm run build`) doesn't reference root `package.json` (it doesn't). On-disk gitignored cruft to remove (not tracked, just free space): `node_modules/` (root, Electron-only), `dist/`, `frontend-build/`, `baseball-dashboard.rar`, root `__pycache__/`, empty `Old/`.
- **A2. Untrack junk + gitignore it.** `git rm --cached "Baseball Dashboard Terminal.lnk" "Pitcher Dashboard - Shortcut.lnk"` and `git rm -r --cached "HTML Tests/"`. Add `*.lnk` and `HTML Tests/` to `.gitignore`.
- **A3. README.** There is none. Write a concise root `README.md`: what the app is (staff pitcher dashboard), the real stack, that it deploys to Vercel from `main`, local-run steps (frontend `npm install && npm start`; backend deps from `api/requirements.txt`; `frontend/.env` needs `PORT=3847 BROWSER=none` — commit a `frontend/.env.example`), and a pointer to `docs/Claude-Project/`.
- **A4. Fix `CLAUDE.md` lies.** It currently never mentions Vercel/Redis/crons; add a short "Production runtime" section (Vercel serverless `api/index.py`, Upstash Redis, 8 crons, `CRON_SECRET`). Remove the nonexistent `/api/leaderboard` from the endpoint list. Fix "React/Vite" → "React 18 (CRA)" (two spots; also in parent `claude-projects/CLAUDE.md`). Fix the season-start claim: it says `2026-02-10` but the code uniformly uses `-03-25` — correct it.
- **A5. Refresh `docs/Claude-Project/`.** `01-ARCHITECTURE.md` lists 5 crons (real count: 8 in `vercel.json` — add `materialize-ranges`, `stat-corrections`, `warmup-live-game-views`); its "Scripts at repo root" table references 3 files that never existed (`cache_monitor.py`, `setup_scheduler.ps1`, `run_cache_monitor.bat`) — delete those rows; add `CRON_SECRET` to its env table; drop "Vite where noted".
- **A6. Archive completed plan docs.** Move `VERCEL-MIGRATION.md`, `MOBILE-PLAN.md`, and the four `pitcher-dashboard-*.md` working docs (incl. this one once done) into `docs/archive/`. (`MOBILE-PLAN` was implemented in March; `VERCEL-MIGRATION` is a superseded plan.)
- **A7. Shrink the favicon.** `frontend/public/favicon.ico` is **410 KB** (should be <15 KB). If ImageMagick/Pillow is available, downscale to a 32×32/16×16 multi-res ico; otherwise flag for Nick.

*Verify:* frontend build passes, `python -c "import app"` passes (nothing imported the deleted root files). One PR.

### PR B — Safety net (deps + CI + tests)

- **B1. Consolidate + pin Python deps.** Four manifests disagree (`requirements.txt`, `api/requirements.txt`, `backend/requirements.txt`, `pyproject.toml`). Vercel reads `api/requirements.txt`. Make ONE canonical pinned set, copy to `api/`. **Pin exact versions** (keep `pandas<3`, compatible `numpy`). Resolve two gaps the audit found: (a) `pytz` is imported as a tz fallback (`app.py`, `data.py`) but is in no manifest — either add it or drop the fallback since `tzdata`+`zoneinfo` covers it; (b) `pybaseball` is imported at `backend/data.py:632` but is in no manifest — check if that path is reachable; if dead, remove the import; if live, add the dep. Drop dead `mangum` (not used — `api/index.py` exposes the ASGI app directly). *Verify the import still works after pinning.*
- **B2. CI workflow.** Add `.github/workflows/ci.yml` triggered on PR + push to `main`: (1) `cd frontend && npm ci && npm run build`; (2) `pip install -r api/requirements.txt && python -c "import sys; sys.path.insert(0,'backend'); import app"`; (3) `cd frontend && npx eslint src --max-warnings 0`. Keep it under a few minutes.
- **B3. ESLint config (enables B2.3 and PR C hooks fixes).** Add `frontend/.eslintrc.json` extending `react-app` with `"react-hooks/rules-of-hooks": "error"` and `"react-hooks/exhaustive-deps": "warn"`. Note: lint will go red until PR C task C4 fixes the hooks violations — either land C4 in this PR too, or start lint as `warn` and flip to `error` after C4.
- **B4. Minimal tests.** No test infra exists. Add `pytest` (dev dep) + a `backend/tests/` with pure-logic unit tests for the highest-value functions: IP-string parsing, season-totals math, `getTooltipResult` equivalents. **Most important:** the regression test for C1 (forced Savant failure must NOT persist an empty-day snapshot). Wire `pytest` into CI.
- **B5. Required check + branch hygiene (via `gh`).** After CI exists: set the CI workflow as a required status check on `main` (gh api branch protection, or flag for Nick if admin-gated). Enable auto-delete-branch-on-merge (`gh api -X PATCH repos/BeardedBats/Pitcher-Dashboard -f delete_branch_on_merge=true`). Prune the ~8 merged-but-undeleted remote branches and run `git worktree prune`. Delete `push.bat`/`push-update.bat` (they `git add -A` and `del .git/*.lock` — dangerous with concurrent sessions).

### PR C — Critical correctness + exposure

- **C1. ⭐ Fix empty-day cache poisoning (the top correctness risk).** In `backend/data.py`: `_fetch_from_savant` (~629-636) swallows all errors into an empty DataFrame, and `fetch_date` (~1170-1174) then persists that empty frame as a materialized day snapshot (`_persist_range_day_snapshot`, 60-day TTL) — so one transient Savant 5xx silently deletes that day from all season stats. Fix: make `_fetch_from_savant` distinguish **failure** (return `None`) from **genuine empty** (return empty DataFrame); in `fetch_date`, only persist a snapshot when the day is confirmed gameless (cross-check `_get_mlb_schedule` for that date), and on failure return uncached-empty so the next request retries. Bump `CARD_SCHEMA_VERSION` to flush any already-poisoned snapshots. Add the B4 regression test.
- **C2. Fail-closed cron guards.** 8 cron handlers use the fail-**open** pattern `if _IS_SERVERLESS and cron_secret and auth != f"Bearer {cron_secret}"` (app.py ~1479, 1497, 1542, 1607, 1636, 1700, 1859, 2028). If `CRON_SECRET` were ever unset they'd execute for anyone. Change each to fail closed while keeping the local-dev escape: `if _IS_SERVERLESS and (not cron_secret or auth != f"Bearer {cron_secret}")`. (The materialize endpoints at ~1437/1467 already use the correct pattern — match them.)
- **C3. Validate date params.** `_valid_date_param` exists (app.py ~258-263) but is only used on the two materialize endpoints. Apply it to the raw string `date`/`start_date`/`end_date` query params on the public endpoints (`/api/games`, `/api/pitch-data`, `/api/pitcher-results`, `/api/team-pitchers`, `/api/pitcher-season-totals`, etc.) → return 400 on malformed input. Closes the Savant-URL param-injection and the unbounded-cache-key vectors.
- **C4. Fix the two Rules-of-Hooks violations + add an ErrorBoundary.** (a) `frontend/src/components/PlayByPlayModal.jsx` (~141-150) has early `return null` before a `useMemo` — move all hooks above every conditional return. (b) `PitcherCard.jsx` (~80) has the same shape (`if (!cardData) return null;` before ~20 hooks) — currently masked by an external guard but fix it. (c) Add an `ErrorBoundary` component and wrap `<App/>` in `frontend/src/index.js` so a render throw shows a fallback instead of white-screening. (Landing this here lets B3 flip lint to `error`.)
- **C5. Delete `bulk_warmup.py`.** Remove the file and any references (e.g. the phantom `cache_monitor.py` mention in its docstring is already going via A5).
- **C6. Dedup the `last-refresh` double-fetch (verified).** `/api/last-refresh` fires twice per date change because **both** a dedicated `[date]` effect (`App.jsx` ~197-202) and the combined-load `Promise.all` (`App.jsx` ~464) request it. Remove `fetchLastRefresh` from one path (keep it in the combined load; drop the standalone effect, or vice-versa) so it fires once. Low cost but a clean, confirmed fix. *Verify by watching the network on a date change in the preview deploy.*

*Note:* C4/C6 touch `App.jsx`/components that have uncommitted WIP — coordinate carefully; stage only your hunks.

### PR D — Redis env consolidation (code + Nick's dashboard step; do after PR B)

Goal: code reads only the clean `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`, then the 10 legacy vars get deleted. **Safe sequence:**
1. **Nick first** confirms in Vercel/Upstash that `UPSTASH_REDIS_REST_URL`+`UPSTASH_REDIS_REST_TOKEN` point to the **same live Upstash database** as the currently-used `Pitcher_Dash_KV_REST_API_URL`+`Pitcher_Dash_KV_REST_API_TOKEN`. (Simplest: set the `UPSTASH_*` values equal to the `Pitcher_Dash_*` values.)
2. Simplify `redis_cache.py:19-24` to read only `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` (drop the `Pitcher_Dash_*` and `KV_*` aliases).
3. Merge → Vercel deploys → **verify Redis is warm** (cache hits, fast homepage). If cold, the `UPSTASH_*` var points at the wrong DB → revert and re-check step 1.
4. **Then Nick deletes** all 10 legacy "Needs Attention" vars in the Vercel dashboard.

Keep steps 2-3 as the PR; steps 1 and 4 are Nick's manual gates (see §4).

### PR E and beyond — large refactors (each its own PR/session; defer if context runs low)

These are L-effort and deserve focused sessions + review. Don't cram them in with the above.
- **E1. Backend de-dup + de-couple.** Single `SEASON_START` constant (kills 21+ hardcoded `-03-25`); one copy each of season-totals math (×3, one already drifted), IP-parsing (×5), ET-now (×5), accent-strip (×3), HAVAA (×3). Break the `data.py ⇄ aggregation.py` circular private-import cycle (move the shared agg cache to its own module). Bump schema version. Remove dead backend functions (`fetch_all_pitchers_list`, `warmup_player_pages`, `get_earned_runs`, `get_boxscore_ip`, `_fix_name`) and the stranded `elif` at `data.py:1020`.
- **E2. Frontend de-dup.** Port `PlayerPage` to `VelocityTrendV2` and delete v1 (`VelocityTrend.jsx`, ~650 ln, ~70% duplicated). Extract shared `<PitchTooltip>` + `<MiniStrikeZone>` (copy-pasted 8× across 6 files, ~800 ln). Unify `BATTED_BALL_COLORS` (defined 3× with **diverged** values — Flare is `#65ff9c` in `constants.js` but `#8feaff` in `PitcherCard`). Remove dead imports/exports + orphan `UsageBar.jsx`. Move inlined decision/run colors into `constants.js`.
- **E3. Robustness.** AbortController/nonce on navigation fetches (`App.jsx` openCard/popstate/date-change) to kill stale-data races. Route date changes through `/api/initial-load` to drop the 2-round-trip waterfall. Error-semantics pass: real HTTP status codes (stop returning 200-with-empty for failures), distinguish "404 player" from "fetch failed" in `PlayerPage`/`TeamPage` (currently both render "Player not found") + add retry. Swap backend `print` for `logging` with levels so Vercel error-log queries work.
- **E4. Redis hygiene.** Rookie negative-result tombstones (avoid 5 sequential Savant fetches per cold rookie card); fix the write-only live-date L2 asymmetry (`data.py` ~1706-1715); align `cacheidx:*` TTL with the keys it indexes; make `_get_game_weather` reuse the cached feed instead of re-downloading it.

---

## 4. Manual steps for Nick (Claude cannot do these — list them at the end of your run)

1. **Vercel Deployment Protection** — toggle ON in the Vercel dashboard (Settings → Deployment Protection). Protects the UI and every `/api/*` route, closing the open mutating endpoints (`pitch-reclassify`, `clear-cache`, `refresh`).
2. **PR D step 1** — confirm `UPSTASH_REDIS_REST_URL`/`_TOKEN` point to the live Upstash DB (or set them equal to the `Pitcher_Dash_*` values) **before** the PR D code change merges.
3. **PR D step 4** — after PR D deploys and Redis is verified warm, delete the 10 legacy "Needs Attention" env vars.
4. **Branch protection** — if `gh` can't set the required-CI check (admin-gated), do it in GitHub repo settings.

---

## 5. Definition of done

- `curl` without a bearer token returns 401 on all cron/materialize routes; malformed `date` returns 400.
- A forced Savant failure (test) does **not** create a `range_day` snapshot.
- `pip install -r api/requirements.txt` is reproducible (pinned); `python -c "import app"` clean.
- CI runs on every PR and is required to merge; ESLint passes with `react-hooks/rules-of-hooks: error`.
- `grep -rc "2026-03-25\|-03-25"` across backend trends toward 1 constant (full convergence is E1).
- `bulk_warmup.py`, `electron/`, root `package.json`, `Dockerfile`, root `index.py` no longer exist; repo root holds only live-path files.
- `last-refresh` fires once per date change (network tab).
- `CLAUDE.md` contains zero claims contradicted by the code.

Start with `git fetch origin`, reset to `origin/main`, branch, and do PR A.
