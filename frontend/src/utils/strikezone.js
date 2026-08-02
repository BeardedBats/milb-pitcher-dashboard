// Strike-zone normalization shared by every pitch-location plot/tooltip.
//
// Statcast measures each pitch's height (`plate_z`) in absolute feet, and the
// strike zone top/bottom (`sz_top`/`sz_bot`) varies per batter by height. To
// match Baseball Savant — which positions every pitch RELATIVE to that
// batter's own zone while drawing a single fixed-size zone box — we remap each
// pitch's `plate_z` from the batter's zone onto one reference zone.
//
// A pitch at the batter's zone top maps to DISPLAY_SZ_TOP, at the bottom to
// DISPLAY_SZ_BOT, and proportionally beyond for balls. Every plot then draws
// the same fixed box (DISPLAY_SZ_BOT..DISPLAY_SZ_TOP) and plots the returned
// value, so a high strike to a tall hitter and a high strike to a short hitter
// both land at the top of the box.

export const DISPLAY_SZ_TOP = 3.5;
export const DISPLAY_SZ_BOT = 1.5;

// Remap a pitch's true plate_z into the fixed reference zone using the
// batter's individual sz_top/sz_bot. Falls back to the raw value when per-pitch
// zone data is missing (degrades to the old fixed-zone behavior rather than
// throwing or collapsing the point).
export function normalizePlateZ(plateZ, szTop, szBot) {
  if (plateZ == null) return plateZ;
  const top = typeof szTop === "number" && szTop > 0 ? szTop : DISPLAY_SZ_TOP;
  const bot = typeof szBot === "number" && szBot > 0 ? szBot : DISPLAY_SZ_BOT;
  const span = top - bot;
  if (!(span > 0)) return plateZ;
  return DISPLAY_SZ_BOT + ((plateZ - bot) / span) * (DISPLAY_SZ_TOP - DISPLAY_SZ_BOT);
}
