import React from "react";

// A request that FAILED, as opposed to one that succeeded with nothing in it.
//
// Pages backed by useWarmupBackedResource were dropping `error` on the floor
// and falling through to their empty state, so a 500 rendered as "No affiliates
// found for BOS." — indistinguishable from an org that genuinely has no
// affiliates, and it sent debugging in exactly the wrong direction.
export default function LoadError({ message, detail, onRetry }) {
  return (
    <div className="loading-msg" role="alert">
      <div>{message || "Something went wrong loading this page."}</div>
      {detail ? (
        <div style={{ fontSize: 13, opacity: 0.7, textAlign: "center", maxWidth: 460 }}>
          {detail}
        </div>
      ) : null}
      {onRetry ? (
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
      ) : null}
    </div>
  );
}
