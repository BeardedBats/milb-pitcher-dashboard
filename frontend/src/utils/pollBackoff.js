// Retry pacing for endpoints that answer HTTP 202 ("cache still rebuilding").
//
// These are pure so the schedule can be unit-tested without a DOM or timers;
// useWarmupBackedResource holds the state and does the actual waiting.
//
// Why this exists: the 202 loop used to retry on a flat 2.5s timer with no cap
// and no give-up state. Measured on production while /api/org-page was
// permanently 202, that was 473 requests in 45 minutes from ordinary browsing —
// every one a serverless invocation plus Upstash commands, against an endpoint
// that could not succeed. A backgrounded tab polled at the same rate forever.

export const DEFAULT_RETRY_BASE_MS = 2000;
export const DEFAULT_RETRY_MAX_MS = 30000;
// Total time the hook will spend WAITING between retries before it gives up and
// hands the user a Retry button. Only time the tab was actually visible counts —
// see useWarmupBackedResource.
export const DEFAULT_RETRY_BUDGET_MS = 5 * 60 * 1000;
// Hard ceiling on a server-supplied Retry-After, so a bad hint can't park the
// page on a multi-hour timer.
export const MAX_SERVER_RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * Parse a Retry-After style hint into milliseconds.
 *
 * Accepts a number or numeric string of SECONDS (the `retry_after` field
 * _loading_response sends). Anything else — null, NaN, negative, a HTTP-date —
 * yields null, meaning "no hint, use the computed backoff".
 */
export function parseRetryAfter(value) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_SERVER_RETRY_AFTER_MS);
}

/**
 * Delay before retry number `attempt` (1-based: the wait after the 1st 202).
 *
 * Exponential from baseMs, doubling each attempt, capped at maxMs. A server
 * hint can only SLOW the client down (`Math.max`), never speed it up — the
 * server knows its own pacing, but it must not be able to talk a client into
 * hammering it.
 */
export function nextRetryDelay(attempt, {
  baseMs = DEFAULT_RETRY_BASE_MS,
  maxMs = DEFAULT_RETRY_MAX_MS,
  retryAfterMs = null,
} = {}) {
  const n = Math.max(1, Math.floor(attempt));
  // 2^30 ms is already ~12 days; clamping the exponent keeps the intermediate
  // finite for absurd attempt counts before maxMs clamps it anyway.
  const grown = baseMs * Math.pow(2, Math.min(n - 1, 30));
  const backoff = Math.min(grown, maxMs);
  if (retryAfterMs === null || retryAfterMs === undefined) return backoff;
  return Math.max(backoff, Math.min(retryAfterMs, MAX_SERVER_RETRY_AFTER_MS));
}

/**
 * Spread a delay so that N tabs that all started polling together stop landing
 * on the server in the same instant. Returns a value in
 * [delay * (1 - ratio), delay], never below zero.
 *
 * `rand` is injectable purely so tests can pin it.
 */
export function jitter(delay, ratio = 0.2, rand = Math.random) {
  const r = Math.min(Math.max(ratio, 0), 1);
  if (!r) return delay;
  return Math.max(0, Math.round(delay * (1 - r * rand())));
}
