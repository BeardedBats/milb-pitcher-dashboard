// In Electron, the backend runs on a dynamic port passed via window.__BACKEND_PORT__
// In dev mode (React dev server on :3000), proxy to localhost:8000
// In production web deploy, API is on the same origin (empty string)
const BASE = window.__BACKEND_PORT__
  ? `http://localhost:${window.__BACKEND_PORT__}`
  : process.env.NODE_ENV === "development"
    ? "http://localhost:8000"
    : "";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(url, { timeoutMs = 45000, ...options } = {}) {
  // Cold serverless card/player-page builds for un-warmed past dates can take
  // 15-30s (fetch_date Savant CSV + boxscore lookups + card extras compute).
  // The previous 20s default tripped an AbortController error mid-build —
  // users saw "signal is aborted without reason" on first click of a cold date.
  // 45s gives the backend room to actually finish.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    // Translate the cryptic browser AbortError into something a user can act on.
    if (err && (err.name === "AbortError" || /aborted/i.test(err.message || ""))) {
      const friendly = new Error(
        "The server took too long to respond. The season cache may still be rebuilding — try again in a few seconds."
      );
      friendly.cause = err;
      friendly.isTimeout = true;
      throw friendly;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, { errorMessage, retries = 0, retryDelayMs = 250, shouldRetry, timeoutMs } = {}) {
  let attempt = 0;
  while (true) {
    const res = await fetchWithTimeout(url, timeoutMs ? { timeoutMs } : undefined);
    if (res.ok) return res.json();
    if (attempt >= retries || !shouldRetry || !shouldRetry(res)) {
      throw new Error(errorMessage || "Request failed");
    }
    attempt += 1;
    await wait(retryDelayMs);
  }
}

// Every date-scoped request carries the level — AAA and AA both play on the
// same date, so omitting it would silently mix levels.
export const DEFAULT_LEVEL = "AAA";

// The leaderboard's "All Levels" filter. A pseudo-level, not a member of the
// registry: the backend answers it by folding all six levels' box-score rows
// into one table, and returns nothing for the game- and pitch-scoped endpoints
// (see /api/games in backend/app.py).
export const ALL_LEVELS = "ALL";
export const ALL_LEVELS_LABEL = "All Levels";
export const isAllLevels = (level) => String(level || "").toUpperCase() === ALL_LEVELS;

// A cold All-Levels slate builds six levels' worth of rows in one request —
// one live feed per game across every level, ~90 games on a full summer night.
// Each level is cached the moment it finishes, so the cost is paid once per
// date, but the FIRST caller has to be allowed to wait for it. The default 45s
// would abort a build that was going to succeed and leave nothing warmed.
const ALL_LEVELS_TIMEOUT_MS = 120000;

export async function fetchLevels() {
  return fetchJson(`${BASE}/api/levels`, {
    errorMessage: "Failed to fetch levels",
  });
}

export async function fetchGames(date, level = DEFAULT_LEVEL) {
  return fetchJson(`${BASE}/api/games?date=${date}&level=${encodeURIComponent(level)}`, {
    errorMessage: "Failed to fetch games",
  });
}

export async function fetchPitchData(date, gamePk, level = DEFAULT_LEVEL) {
  const params = new URLSearchParams({ date, level });
  if (gamePk != null) params.set("game_pk", gamePk);
  return fetchJson(`${BASE}/api/pitch-data?${params}`, {
    errorMessage: "Failed to fetch pitch data",
  });
}

export async function fetchPitchersDirectory(startDate = "2026-03-25", endDate = "") {
  // Full lightweight pitcher list (~600 records). Fetched once and filtered
  // client-side — see SearchBar.jsx. Records carry name_norm + ranking signals.
  const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
  return fetchJson(`${BASE}/api/pitchers-directory?${params}`, {
    errorMessage: "Failed to fetch pitcher directory",
    retries: 2,
    retryDelayMs: 400,
    shouldRetry: (res) => res.status >= 500 || res.status === 429,
  });
}

export async function fetchPitcherResults(date, gamePk, level = DEFAULT_LEVEL) {
  const params = new URLSearchParams({ date, level });
  if (gamePk != null) params.set("game_pk", gamePk);
  return fetchJson(`${BASE}/api/pitcher-results?${params}`, {
    errorMessage: "Failed to fetch pitcher results",
    retries: gamePk == null ? 1 : 0,
    shouldRetry: (res) => res.status >= 500 || res.status === 429,
    ...(isAllLevels(level) ? { timeoutMs: ALL_LEVELS_TIMEOUT_MS } : {}),
  });
}

export async function fetchGameView(date, gamePk, level = DEFAULT_LEVEL) {
  const params = new URLSearchParams({ date, game_pk: gamePk, level });
  return fetchJson(`${BASE}/api/game-view?${params}`, {
    errorMessage: "Failed to fetch game view",
  });
}

export async function fetchPitcherCard(date, pitcherId, gamePk) {
  const url = `${BASE}/api/pitcher-card?date=${date}&pitcher_id=${pitcherId}&game_pk=${gamePk}`;
  return fetchJson(url, {
    errorMessage: "Failed to fetch pitcher card",
  });
}

// Season totals. `/api/pitcher-season-totals` is season-materialized, so it can
// answer 202 with a warmup status body instead of totals — and `res.ok` is TRUE
// for a 202, so the old `if (!res.ok) throw` guard let that status body through
// as if it were data. Status-backed like its siblings below: callers branch on
// `status`, or hand this straight to useWarmupBackedResource.
export async function fetchPitcherSeasonTotals(pitcherId, startDate = "2026-03-25", endDate = "") {
  const params = new URLSearchParams({ pitcher_id: pitcherId, start_date: startDate, end_date: endDate });
  return fetchStatusBacked(`${BASE}/api/pitcher-season-totals?${params}`);
}

export async function fetchPlayerPage(pitcherId, startDate = "2026-03-25") {
  const params = new URLSearchParams({ pitcher_id: pitcherId, start_date: startDate });
  const res = await fetchWithTimeout(`${BASE}/api/player-page?${params}`, { timeoutMs: 30000 });
  if (!res.ok) throw new Error("Failed to fetch player page");
  return res.json();
}

export async function fetchGameLinescore(gamePk) {
  const res = await fetch(`${BASE}/api/game-linescore?game_pk=${gamePk}`);
  if (!res.ok) throw new Error("Failed to fetch linescore");
  return res.json();
}

export async function reclassifyPitch({ game_pk, pitcher_id, at_bat_number, pitch_number, new_pitch_type, date }) {
  const res = await fetch(`${BASE}/api/pitch-reclassify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ game_pk, pitcher_id, at_bat_number, pitch_number, new_pitch_type, date }),
  });
  if (!res.ok) throw new Error("Failed to reclassify pitch");
  return res.json();
}

export async function undoReclassify({ game_pk, pitcher_id, at_bat_number, pitch_number, date }) {
  const params = new URLSearchParams({ game_pk, pitcher_id, at_bat_number, pitch_number, date: date || "" });
  const res = await fetch(`${BASE}/api/pitch-reclassify?${params}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to undo reclassification");
  return res.json();
}

export async function fetchDefaultDate() {
  const res = await fetch(`${BASE}/api/default-date`);
  if (!res.ok) throw new Error("Failed to fetch default date");
  const data = await res.json();
  return data.date;
}

export async function fetchInitialLoad(level = DEFAULT_LEVEL) {
  // Cold serverless starts can easily exceed 10s on this endpoint (full
  // Savant fetch + aggregations + boxscore lookups). The previous 8s timeout
  // guaranteed a broken fallback path on every cold load: AbortController
  // would cancel the request, the catch handler would set loading=false and
  // kick off a separate fetchDefaultDate → fetchGames → fetch* waterfall —
  // all racing the original request that the backend was still computing.
  // 60s gives us a realistic cold-start budget while still bounding stuck
  // connections.
  const res = await fetchWithTimeout(
    `${BASE}/api/initial-load?level=${encodeURIComponent(level)}`,
    { timeoutMs: isAllLevels(level) ? ALL_LEVELS_TIMEOUT_MS : 60000 },
  );
  if (!res.ok) throw new Error("Failed to fetch initial load");
  return res.json();
}

export async function fetchRefresh(date = "", gamePk = null) {
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  if (gamePk != null) params.set("game_pk", gamePk);
  const qs = params.toString();
  const res = await fetch(`${BASE}/api/refresh${qs ? `?${qs}` : ""}`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to refresh data");
  return res.json();
}

// MLB pitchers on an IL who have made a minor-league start recently. Heavy on
// a cold cache (MLB rosters, a per-level date-range sweep, then one live feed
// per rehabbing pitcher for the pitch rates), so allow a long timeout; the
// backend caps its own feed pulls and caches the assembled list.
export async function fetchRehabStarts(days = 14) {
  const res = await fetchWithTimeout(`${BASE}/api/rehab-starts?days=${days}`, { timeoutMs: 90000 });
  if (!res.ok) throw new Error("Failed to fetch rehab starts");
  return res.json();
}

export async function fetchLastRefresh(date = "") {
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  const qs = params.toString();
  const res = await fetch(`${BASE}/api/last-refresh${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("Failed to fetch last refresh");
  return res.json();
}

// --- Warmup-backed endpoints ---------------------------------------------
// Season-materialized endpoints (player page, team pitchers) can return HTTP
// 202 with a JSON status body while the season cache is still being built —
// a loading response, NOT an error. These wrappers return the raw
// { status, body } so callers (see useWarmupBackedResource) can branch on it.
async function fetchStatusBacked(url, { timeoutMs = 30000 } = {}) {
  const res = await fetchWithTimeout(url, { timeoutMs });
  // A 202 is a "still warming" response carrying a JSON status body; any other
  // non-2xx is a genuine error. Parse the body defensively either way.
  const body = await res.json().catch(() => null);
  if (!res.ok && res.status !== 202) {
    throw new Error(`Request failed (${res.status})`);
  }
  return { status: res.status, body };
}

// Lightweight progress poll shared by the warmup-backed views.
export async function fetchWarmupStatus() {
  const res = await fetch(`${BASE}/api/warmup-status`);
  if (!res.ok) throw new Error("Failed to fetch warmup status");
  return res.json();
}

// Team pitcher table. Returns { status, body }: status 202 means the season
// cache is still materializing (body carries a status/message), 200 means
// body is the pitcher array. startDate/endDate are optional and only sent when
// provided, preserving the original team-pitchers query shape.
export async function fetchTeamPitchers(teamAbbrev, { startDate = "", endDate = "", view = "results" } = {}) {
  const params = new URLSearchParams({ team: teamAbbrev, view });
  if (startDate) params.set("start_date", startDate);
  if (endDate) params.set("end_date", endDate);
  return fetchStatusBacked(`${BASE}/api/team-pitchers?${params}`);
}

// Whole-org page: one block per affiliate, highest level first. Team pages
// route per MLB org in this build, so this is what TeamPage loads.
export async function fetchOrgPage(org, { startDate = "", endDate = "" } = {}) {
  const params = new URLSearchParams({ org });
  if (startDate) params.set("start_date", startDate);
  if (endDate) params.set("end_date", endDate);
  return fetchStatusBacked(`${BASE}/api/org-page?${params}`);
}

// Player page payload, warmup-aware. Returns { status, body } so the season
// page can show the rebuild progress on 202. (PitcherCard uses the plain
// fetchPlayerPage above, which always treats the body as data.)
export async function fetchPlayerPageResource(pitcherId, { startDate = "2026-03-25" } = {}) {
  const params = new URLSearchParams({ pitcher_id: pitcherId, start_date: startDate });
  return fetchStatusBacked(`${BASE}/api/player-page?${params}`, { timeoutMs: 30000 });
}

// Server-side pitcher search (fallback when the client directory can't load).
export async function fetchPitchersSearch(query, { startDate = "", endDate = "" } = {}) {
  const params = new URLSearchParams({ q: query });
  if (startDate) params.set("start_date", startDate);
  if (endDate) params.set("end_date", endDate);
  const res = await fetch(`${BASE}/api/pitchers-search?${params}`);
  if (!res.ok) throw new Error("Failed to search pitchers");
  return res.json();
}

// Resolve a pitcher name → record (with pitcher_id) via the backend.
export async function resolvePitcher(name, { startDate = "", endDate = "" } = {}) {
  const params = new URLSearchParams({ name });
  if (startDate) params.set("start_date", startDate);
  if (endDate) params.set("end_date", endDate);
  const res = await fetch(`${BASE}/api/resolve-pitcher?${params}`);
  if (!res.ok) throw new Error("Failed to resolve pitcher");
  return res.json();
}
