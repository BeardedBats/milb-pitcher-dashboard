import React from "react";
import VelocityTrend from "./VelocityTrend";
import VelocityTrendV2 from "./VelocityTrendV2";

// Single public entry point for the velocity-trend chart. Views import this
// instead of reaching for VelocityTrend / VelocityTrendV2 directly.
//
//   mode="game"             → rich single-game chart with inning overlays and
//                             linescore-aware PBP hints (VelocityTrendV2).
//   mode="season" (default) → simpler multi-game season trend (VelocityTrend).
//
// Full consolidation onto one implementation is intentionally deferred, not
// done here: VelocityTrendV2 is built around a single game's inning structure
// and linescore overlays, while the season page needs a multi-game trend.
// Collapsing them is a canvas-chart rewrite — out of scope for a
// behavior-preserving refactor. This wrapper gives the destination app one
// import + one prop to flip, so the eventual merge touches one seam.
export default function VelocityChart({
  mode = "season",
  pitches,
  isMobile,
  onReclassify,
  linescoreData,
  pitcherId,
}) {
  if (mode === "game") {
    return (
      <VelocityTrendV2
        pitches={pitches}
        onReclassify={onReclassify}
        isMobile={isMobile}
        linescoreData={linescoreData}
        pitcherId={pitcherId}
      />
    );
  }
  return <VelocityTrend pitches={pitches} isMobile={isMobile} />;
}
