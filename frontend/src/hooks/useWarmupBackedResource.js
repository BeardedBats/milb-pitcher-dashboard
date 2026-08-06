import { useEffect, useState, useRef, useCallback } from "react";
import {
  nextRetryDelay,
  parseRetryAfter,
  jitter,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_MAX_MS,
  DEFAULT_RETRY_BUDGET_MS,
} from "../utils/pollBackoff";

// Loading/polling lifecycle for season-materialized endpoints that may answer
// HTTP 202 ("still warming the cache") before the real payload is ready.
//
// Extracted from the duplicated warmup loops in PlayerPage and TeamPage. The
// `load` function must resolve to { status, body }:
//   - status 200 → body is the payload; resolve immediately.
//   - status 202 → body carries a warmup status:
//       { status: "error", error }  → stop, surface the message as stalled
//       anything else               → retry on a backoff schedule
// `body.retry_after` (seconds) is honoured as a server pacing hint.
//
//   const { data, loading, message, error, stalled, reload } =
//     useWarmupBackedResource({
//       key: [pitcherId],
//       load: () => fetchPlayerPageResource(pitcherId, { startDate }),
//       pollWarmup: fetchWarmupStatus,
//       initialMessage: "Loading player data...",
//     });
//
// RETRY POLICY (see utils/pollBackoff.js for the schedule itself). The loop is
// bounded on three independent axes, because an endpoint that 202s for a
// sustained period used to turn every open tab into a request generator —
// 473 requests in 45 minutes, measured, with no backoff, no cap and no way out:
//
//   1. Backoff. 2s → 4s → 8s … capped at 30s, plus jitter so tabs opened
//      together don't resynchronise on the server.
//   2. Budget. Once the accumulated wait passes retryBudgetMs the hook stops
//      and reports `stalled`, and the caller offers a manual Retry (`reload`)
//      instead of polling forever. A rebuild can legitimately take hours; no
//      client-side poll duration covers that, so handing control back is the
//      honest outcome.
//   3. Visibility. A hidden tab never fires a retry. The scheduled attempt is
//      held until the tab is visible again, and time spent hidden does NOT
//      count against the budget — returning to a background tab should resume
//      polling, not find it already given up.
//
// Warmup progress (`pollWarmup`) is fetched once per retry, not on a timer of
// its own. The old independent 2s poll was a second unbounded request source.
//
// Behavior otherwise matches the original page loops: data is NOT reset to its
// initial value on key change (the loading view hides stale data).
export default function useWarmupBackedResource({
  key,
  load,
  pollWarmup,
  initialMessage = "Loading...",
  initialData = null,
  normalize,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
  retryBudgetMs = DEFAULT_RETRY_BUDGET_MS,
}) {
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(initialMessage);
  const [error, setError] = useState(null);
  // Terminal "gave up / server said error" state. Distinct from `error`, which
  // means the request itself failed: here the request keeps succeeding, it just
  // keeps saying "not ready".
  const [stalled, setStalled] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Refs so changing the inline load/poll/normalize closures each render does
  // NOT retrigger the effect — only the key (or an explicit reload) does.
  const loadRef = useRef(load); loadRef.current = load;
  const pollRef = useRef(pollWarmup); pollRef.current = pollWarmup;
  const normalizeRef = useRef(normalize); normalizeRef.current = normalize;
  const initialMessageRef = useRef(initialMessage); initialMessageRef.current = initialMessage;

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  const keyStr = Array.isArray(key) ? key.join("|") : String(key);

  useEffect(() => {
    setLoading(true);
    setMessage(initialMessageRef.current);
    setError(null);
    setStalled(false);

    let done = false;        // resolved, errored, or gave up — nothing more runs
    let timer = null;
    let pendingFire = null;  // retry deferred because the tab went hidden
    let attempt = 0;
    let waited = 0;          // visible-time spent waiting, vs retryBudgetMs

    const isHidden = () =>
      typeof document !== "undefined" && document.visibilityState === "hidden";

    const clearTimer = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };

    const finish = () => { done = true; clearTimer(); pendingFire = null; };

    const giveUp = (msg) => {
      finish();
      if (msg) setMessage(msg);
      setStalled(true);
      setLoading(false);
    };

    const pollProgress = () => {
      if (!pollRef.current) return;
      Promise.resolve(pollRef.current())
        .then((s) => { if (!done && s && s.progress && s.loading) setMessage(s.progress); })
        .catch(() => {});
    };

    const scheduleRetry = (retryAfterMs) => {
      attempt += 1;
      const delay = jitter(
        nextRetryDelay(attempt, { baseMs: retryBaseMs, maxMs: retryMaxMs, retryAfterMs })
      );
      if (waited + delay > retryBudgetMs) {
        giveUp();
        return;
      }
      const fire = () => {
        timer = null;
        if (done) return;
        // Hidden tabs don't poll. Hold the attempt (and the budget) until the
        // user comes back to this tab.
        if (isHidden()) { pendingFire = fire; return; }
        waited += delay;
        pollProgress();
        run();
      };
      timer = setTimeout(fire, delay);
    };

    const run = () => {
      Promise.resolve(loadRef.current())
        .then(({ status, body }) => {
          if (done) return;
          if (status === 202) {
            if (body && body.status === "error") {
              giveUp((body && body.error) || "Season cache rebuild failed");
              return;
            }
            setMessage((body && body.message) || "Season cache is rebuilding");
            scheduleRetry(parseRetryAfter(body && body.retry_after));
            return;
          }
          finish();
          const fn = normalizeRef.current;
          setData(fn ? fn(body) : body);
          setLoading(false);
        })
        .catch((err) => {
          if (done) return;
          finish();
          setError(err);
          setLoading(false);
        });
    };

    const onVisibility = () => {
      if (done || isHidden() || !pendingFire) return;
      const fn = pendingFire;
      pendingFire = null;
      fn();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    run();

    return () => {
      finish();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [keyStr, reloadNonce, retryBaseMs, retryMaxMs, retryBudgetMs]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, message, error, stalled, reload };
}
