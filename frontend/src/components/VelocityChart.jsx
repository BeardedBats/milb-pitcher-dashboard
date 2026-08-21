import React from "react";
import VelocityTrend from "./VelocityTrend";
import VelocityTrendV2 from "./VelocityTrendV2";

// Single public entry point for the velocity-trend chart. Views import this
// instead of reaching for VelocityTrend / VelocityTrendV2 directly.
//
//   mode="game"             → one game, panelled by INNING, with the linescore
//                             play-by-play behind each inning header.
//   mode="season" (default) → many games, panelled by GAME: same chart, same
//                             legend lock, headers carry per-start velo.
//   mode="lanes"            → the original per-pitch-type swim-lane chart.
//
// Both live modes are VelocityTrendV2 — the difference is what one panel means,
// which is the `groupBy` prop. A season cannot be panelled by inning (every
// start has a 3rd inning) and a single game gains nothing from being panelled
// by game, so the caller picks by the data it holds, not by the page it is on.
//
// mode="lanes" is QUARANTINED: VelocityTrend sizes each pitch-type lane at
// ~24.75px per pitch with no ceiling, so a real workload renders a chart
// thousands of pixels tall — a season of four-seamers alone clears 10,000px.
// It is kept for reference and has no callers; don't route a view at it
// without fixing that scaling first.
export default function VelocityChart({
  mode = "season",
  pitches,
  isMobile,
  onReclassify,
  linescoreData,
  pitcherId,
}) {
  if (mode === "lanes") {
    return <VelocityTrend pitches={pitches} isMobile={isMobile} />;
  }
  return (
    <VelocityTrendV2
      groupBy={mode === "game" ? "inning" : "game"}
      pitches={pitches}
      onReclassify={onReclassify}
      isMobile={isMobile}
      linescoreData={linescoreData}
      pitcherId={pitcherId}
    />
  );
}
