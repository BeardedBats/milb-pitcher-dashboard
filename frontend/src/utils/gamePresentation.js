// Shared game-presentation helpers — pure display formatting used by the
// scoreboard, charts, and PBP views. No React imports.
//
// Source of truth for inning ordinals and base-state strings. Previously these
// were copy-pasted into StrikeZonePlot, MovementPlot, VelocityTrend,
// VelocityTrendV2, Scoreboard, PitcherCard, PlayByPlayModal, and GameTabs.

// 1 -> "1st", 2 -> "2nd", 11 -> "11th", etc.
export function ordinalInning(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Base occupancy -> human string. Accepts the raw pitch/PA object (or any
// object exposing on_1b/on_2b/on_3b). "Bases Empty", "Man on 2nd", "1st & 3rd".
export function formatBaseState({ on_1b, on_2b, on_3b } = {}) {
  const bases = [];
  if (on_1b) bases.push("1st");
  if (on_2b) bases.push("2nd");
  if (on_3b) bases.push("3rd");
  if (bases.length === 0) return "Bases Empty";
  if (bases.length === 1) return "Man on " + bases[0];
  return bases.join(" & ");
}
