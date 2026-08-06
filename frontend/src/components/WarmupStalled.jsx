import React from "react";

// Terminal state for a warmup-backed page: the season cache is still
// rebuilding and the client has spent its retry budget (see
// useWarmupBackedResource). Polling has STOPPED — the only way forward is this
// button, which is the point: a rebuild can take hours, and a spinner that
// silently retries forever is what produced 473 requests in 45 minutes.
//
// Mirrors the Retry affordance on App.jsx's error banner.
export default function WarmupStalled({ message, onRetry }) {
  return (
    <div className="loading-msg" role="status">
      <div>{message || "Season cache is rebuilding"}</div>
      <div style={{ fontSize: 13, opacity: 0.75, textAlign: "center", maxWidth: 460 }}>
        This is taking longer than usual, so we&rsquo;ve stopped checking. The
        rebuild continues on the server &mdash; try again in a few minutes.
      </div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          background: "rgba(85, 232, 255, 0.12)",
          border: "1px solid rgba(85, 232, 255, 0.4)",
          color: "#55e8ff",
          padding: "6px 16px",
          borderRadius: 4,
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 13,
        }}
      >
        Retry
      </button>
    </div>
  );
}
