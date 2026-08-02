import { useEffect, useState, useRef, useCallback } from "react";

// Loading/polling lifecycle for season-materialized endpoints that may answer
// HTTP 202 ("still warming the cache") before the real payload is ready.
//
// Extracted from the duplicated warmup loops in PlayerPage and TeamPage. The
// `load` function must resolve to { status, body }:
//   - status 200 → body is the payload; resolve immediately.
//   - status 202 → body carries a warmup status:
//       { status: "pending" | "running", message }  → retry after retryMs
//       { status: "error", error }                  → stop, surface the message
// While waiting, `pollWarmup` is polled to surface server-side progress text.
//
//   const { data, loading, message, error, reload } = useWarmupBackedResource({
//     key: [pitcherId],
//     load: () => fetchPlayerPageResource(pitcherId, { startDate }),
//     pollWarmup: fetchWarmupStatus,
//     initialMessage: "Loading player data...",
//   });
//
// Behavior is intentionally identical to the original page loops: data is NOT
// reset to its initial value on key change (the loading view hides stale data),
// and a 202 "error" leaves the view in its loading state showing the message.
export default function useWarmupBackedResource({
  key,
  load,
  pollWarmup,
  initialMessage = "Loading...",
  initialData = null,
  normalize,
  retryMs = 2500,
  warmupPollMs = 2000,
  warmupPollDelayMs = 1000,
}) {
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(initialMessage);
  const [error, setError] = useState(null);
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

    let cancelled = false;
    let pollTimer = null;
    let retryTimer = null;

    const pollStatus = () => {
      Promise.resolve(pollRef.current ? pollRef.current() : null)
        .then((s) => { if (!cancelled && s && s.progress && s.loading) setMessage(s.progress); })
        .catch(() => {});
      if (!cancelled) pollTimer = setTimeout(pollStatus, warmupPollMs);
    };
    if (pollRef.current) pollTimer = setTimeout(pollStatus, warmupPollDelayMs);

    const run = () => {
      Promise.resolve(loadRef.current())
        .then(({ status, body }) => {
          if (cancelled) return;
          if (status === 202) {
            if (body && body.status === "error") {
              setMessage((body && body.error) || "Season cache rebuild failed");
              if (pollTimer) clearTimeout(pollTimer);
              return;
            }
            setMessage((body && body.message) || "Season cache is rebuilding");
            if (!cancelled && body && (body.status === "pending" || body.status === "running")) {
              retryTimer = setTimeout(() => { if (!cancelled) run(); }, retryMs);
            }
            return;
          }
          cancelled = true;
          if (pollTimer) clearTimeout(pollTimer);
          if (retryTimer) clearTimeout(retryTimer);
          const fn = normalizeRef.current;
          setData(fn ? fn(body) : body);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          cancelled = true;
          if (pollTimer) clearTimeout(pollTimer);
          if (retryTimer) clearTimeout(retryTimer);
          setError(err);
          setLoading(false);
        });
    };
    run();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [keyStr, reloadNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, message, error, reload };
}
