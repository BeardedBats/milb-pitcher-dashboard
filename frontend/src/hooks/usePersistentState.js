import { useState, useEffect, useCallback } from "react";

// useState backed by localStorage. One shared value per key — the pitch-mix
// display modes use this so an analyst's choice (raw columns vs distribution
// bar, heatmap, approach-shift divider) survives navigation across both the
// game card and the player page, and across every pitcher they page through.
// Falls back to plain in-memory state if storage is unavailable (private mode,
// SSR, quota) so it never throws.
export default function usePersistentState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw == null ? defaultValue : JSON.parse(raw);
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
  }, [key, value]);

  // Stable setter identity so it can sit in effect/memo deps without churn.
  const set = useCallback((v) => setValue(v), []);
  return [value, set];
}
