import { THRESHOLDS, RESULT_COLORS, VELO_THRESHOLDS, IHB_THRESHOLDS } from "../constants";

export function getCellHighlight(key, value, pitchName) {
  if (value == null) return null;
  const thresholds = THRESHOLDS[key];
  if (!thresholds) return null;
  const t = thresholds[pitchName] || thresholds._all;
  if (!t) return null;
  const [eliteMin, poorMax] = t;
  if (value >= eliteMin) return "elite";
  if (value <= poorMax) return "poor";
  return null;
}

export function fmt(v, decimals = 1) {
  if (v == null || v === "" || isNaN(v)) return "--";
  return Number(v).toFixed(decimals);
}

export function fmtPct(v) {
  if (v == null || v === "" || isNaN(v)) return "--";
  const n = Math.round(Number(v));
  if (n === 0) return "-";
  return n + "%";
}

// rgba() string from a hex color (3- or 6-digit). Passes falsy input and
// already-rgba() strings through unchanged, so it is safe to call on any CSS
// color value. Single source — was duplicated across the velocity charts and
// the game-log helpers.
export function hexToRgba(hex, a) {
  if (!hex || hex.startsWith("rgba")) return hex;
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function roundPercentParts(parts, denominator = null, targetTotal = 100) {
  const numericParts = parts.map(v => (Number.isFinite(Number(v)) ? Number(v) : 0));
  const denom = denominator == null
    ? numericParts.reduce((sum, v) => sum + v, 0)
    : Number(denominator);

  if (!Number.isFinite(denom) || denom <= 0) return numericParts.map(() => 0);

  const exact = numericParts.map(v => (v / denom) * targetTotal);
  const floors = exact.map(Math.floor);
  const roundedTarget = Math.round(numericParts.reduce((sum, v) => sum + v, 0) / denom * targetTotal);
  let remainder = roundedTarget - floors.reduce((sum, v) => sum + v, 0);

  // Largest remainder rounding keeps displayed percentage groups additive.
  const order = exact
    .map((value, index) => ({ index, value, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || b.value - a.value || a.index - b.index);

  const result = [...floors];
  for (let i = 0; i < order.length && remainder > 0; i++, remainder--) {
    result[order[i].index]++;
  }
  return result;
}

export function fmtInt(v) {
  if (v == null || v === "" || isNaN(v)) return "--";
  return Math.round(Number(v)).toString();
}

export function getResultColor(result) {
  if (!result) return "rgba(255,255,255,0.45)";
  const key = result.toLowerCase().replace(/ /g, "_");
  return RESULT_COLORS[key] || "rgba(255,255,255,0.45)";
}

export function getZoneLabel(zone) {
  if (zone >= 1 && zone <= 9) return `Zone ${zone}`;
  if (zone >= 11 && zone <= 14) return "Shadow";
  return "Outside";
}

export function getSprayDirection(hc_x, hc_y) {
  if (hc_x == null || hc_y == null) return "";
  // Baseball Savant coordinates: home plate ~125, center field ~125
  const cx = 125;
  const angle = Math.atan2(cx - hc_y, hc_x - cx) * (180 / Math.PI);
  const dist = Math.sqrt((hc_x - cx) ** 2 + (cx - hc_y) ** 2);
  // Infield vs outfield threshold (~150 in Savant coords)
  const isInfield = dist < 110;
  if (isInfield) {
    // Infield positions by angle
    if (angle < -25) return "to 1B";
    if (angle < -5) return "to 2B";
    if (angle < 10) return "to SS";
    if (angle < 30) return "to 3B";
    // Extreme pull: catcher/pitcher territory
    if (angle >= 30) return "to 3B";
    return "to 1B";
  }
  // Outfield positions
  if (angle < -20) return "to RF";
  if (angle < -5) return "to RF";
  if (angle < 10) return "to CF";
  if (angle < 25) return "to LF";
  return "to LF";
}

export function getVeloEmphasis(pitchName, velo) {
  if (!velo || !pitchName) return null;
  const t = VELO_THRESHOLDS[pitchName];
  if (!t) return null;
  if (velo >= t.red) return "elite";
  if (velo <= t.blue) return "poor";
  return null;
}

// Savant batted ball classification based on launch speed/angle
// Burner: EV >= 93, LA < 10°. Flare: EV >= 80, LA 10-25°.
export function classifyBattedBall(launchSpeed, launchAngle) {
  if (launchSpeed == null || launchAngle == null) return null;
  const ev = launchSpeed, la = launchAngle;
  if (ev >= 98) {
    const laMin = Math.max(8, 26 - (ev - 98) * 1.5);
    const laMax = Math.min(50, 30 + (ev - 98) * 1.3);
    if (la >= laMin && la <= laMax) return "Barrel";
  }
  if (ev >= 90 && la >= 10 && la <= 50) return "Solid";
  if (ev >= 93 && la < 10) return "Burner";
  if (ev >= 80 && la >= 10 && la <= 25) return "Flare";
  if (la < 10) return "Topped";
  if (la > 50) return "Under";
  if (la > 25 && ev < 80) return "Under";
  if (ev < 80) return "Poor";
  if (ev >= 90) return "Solid";
  return "Flare";
}

// Hard BIP vs Weak BIP from batted ball tag
// Hard = Barrel, Solid, Burner. Weak = Flare, Topped, Under, Poor.
export function getBIPQuality(tag) {
  if (!tag) return null;
  if (tag === "Barrel" || tag === "Solid" || tag === "Burner") return "Hard BIP";
  return "Weak BIP";
}

// Fastball types where +iVB = elite (red)
const FASTBALL_TYPES = ["Four-Seamer", "Sinker"];
// Pitch types where +iHB (arm-side) = red, -iHB (glove-side) = blue
const IHB_ARM_SIDE_TYPES = ["Four-Seamer", "Sinker", "Changeup"];

// Color logic for iHB DELTA values (change from season avg). Values are in
// DISPLAY space (already negated from pfx_x).
// Four-seamer special: Cut zone (|val| < 6): more cut (negative) = red, less cut (positive) = blue
//                      Run zone (|val| > 6): more run (positive) = red, less run (negative) = blue
// Others: RHP arm-side = Red+/Blue-, LHP arm-side = Red-/Blue+
export function getIhbDeltaColor(delta, pitchName, hand, prevVal, currentVal) {
  if (delta == null || isNaN(delta) || delta === 0) return null;
  if (Math.abs(delta) < 1.0) return null;
  const isPositive = delta > 0;

  if (pitchName === "Four-Seamer" && prevVal != null && currentVal != null) {
    const absPrev = Math.abs(prevVal);
    const absCur = Math.abs(currentVal);
    if (absPrev < 6 || absCur < 6) {
      // Cut zone: negative delta = more cut = elite (red)
      return isPositive ? "#55e8ff" : "#FF839B";
    }
    if (absPrev > 6 && absCur > 6) {
      // Run zone: positive delta = more run = elite (red)
      return isPositive ? "#FF839B" : "#55e8ff";
    }
  }

  const isArmSide = IHB_ARM_SIDE_TYPES.includes(pitchName);
  const isLHP = hand === "L";
  const armSidePositiveIsRed = isArmSide !== isLHP;
  if (armSidePositiveIsRed) {
    return isPositive ? "#FF839B" : "#55e8ff";
  } else {
    return isPositive ? "#55e8ff" : "#FF839B";
  }
}

// Color logic for iVB DELTA values (change from season avg)
// Sinker special: If prev > 10 OR new > 8 → red for increase, blue for decrease
//                 If prev < 10 OR new < 8 → blue for increase, red for decrease
// FF: + = red, - = blue. Others: + = blue, - = red
export function getIvbDeltaColor(delta, pitchName, prevVal, currentVal) {
  if (delta == null || isNaN(delta) || delta === 0) return null;
  if (Math.abs(delta) < 1.0) return null;
  const isPositive = delta > 0;

  if (pitchName === "Sinker" && prevVal != null && currentVal != null) {
    if (prevVal > 10 || currentVal > 8) {
      return isPositive ? "#FF839B" : "#55e8ff";
    }
    if (prevVal < 10 || currentVal < 8) {
      return isPositive ? "#55e8ff" : "#FF839B";
    }
  }

  const isFastball = FASTBALL_TYPES.includes(pitchName);
  if (isFastball) {
    return isPositive ? "#FF839B" : "#55e8ff";
  } else {
    return isPositive ? "#55e8ff" : "#FF839B";
  }
}

export function getIHBEmphasis(pitchName, ihb, hand) {
  // ihb is the DISPLAY value (already negated from pfx_x)
  if (ihb == null || !pitchName || !hand) return null;
  const t = IHB_THRESHOLDS[pitchName];
  if (!t) return null;
  const h = t[hand];
  if (!h) return null;

  if (pitchName === "Four-Seamer") {
    if (hand === "R") {
      // RHP FF: Red if >12" OR <4"
      return (ihb > h.red_above || ihb < h.red_below) ? "elite" : null;
    }
    if (hand === "L") {
      // LHP FF: Red if |iHB| >= 16, Blue if |iHB| <= 14
      if (ihb <= h.red) return "elite";   // more negative = more movement
      if (ihb >= h.blue) return "poor";   // less negative = less movement
    }
  }
  if (pitchName === "Sinker") {
    if (hand === "R") {
      if (ihb > h.red) return "elite";
      if (ihb < h.blue) return "poor";
    }
    if (hand === "L") {
      // LHP SI: Red if |iHB| >= 16, Blue if |iHB| <= 14
      if (ihb <= h.red) return "elite";   // more negative = more movement
      if (ihb >= h.blue) return "poor";   // less negative = less movement
    }
  }
  return null;
}
