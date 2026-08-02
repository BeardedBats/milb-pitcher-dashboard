/**
 * Classify a pitch into a result category for filtering.
 * Each pitch gets ONE category based on description + events.
 *
 * Categories:
 *  HR, Single, Double, Triple, Strikeout, Walk,
 *  Whiff, Foul, Called Strike, Ball, HBP, Out
 *
 * Overlay categories (checked separately):
 *  Run(s) — any PA-ending pitch where runs scored
 */
export function classifyPitchResult(pitch) {
  const desc = (pitch.description || "").toLowerCase();
  const ev = (pitch.events || "").toLowerCase();

  // Whiff: swinging_strike, swinging_strike_blocked, foul_tip, missed_bunt
  if (desc === "swinging_strike" || desc === "swinging_strike_blocked" || desc === "foul_tip" || desc === "missed_bunt") {
    return "Whiff";
  }
  // Called Strike
  if (desc === "called_strike") return "Called Strike";
  // Ball
  if ((desc.includes("ball") && !desc.includes("in_play")) || desc === "pitchout") return "Ball";
  // Foul (not foul tip — already caught above)
  if (desc.includes("foul") && desc !== "foul_tip") return "Foul";
  // HBP
  if (desc === "hit_by_pitch" || ev === "hit_by_pitch") return "HBP";

  // PA-ending events
  if (ev === "strikeout" || ev === "strikeout_double_play") return "Strikeout";
  if (ev === "walk" || ev === "intent_walk") return "Walk";
  if (ev === "home_run") return "HR";
  if (ev === "single") return "Single";
  if (ev === "double") return "Double";
  if (ev === "triple") return "Triple";

  // Out (remaining in-play events)
  if (ev && (ev.includes("out") || ev.includes("play") || ev.includes("force")
    || ev.includes("sac") || ev === "fielders_choice" || ev === "fielders_choice_out"
    || ev === "field_error" || ev === "catcher_interf")) {
    return "Out";
  }

  // Fallback for hit_into_play without matching event
  if (desc === "hit_into_play") return "Out";

  return "Other";
}

/**
 * Number of runs scored as a result of this pitch — the single source of truth
 * for every tooltip's "x Run(s)" line. Prefers the backend's authoritative
 * per-pitch `runs_scored` (computed once from the play, so all tooltips agree
 * and mid-AB action runs aren't mis-attributed to the final pitch). Falls back
 * to a word-boundary `des` parse only for records that predate that field.
 */
export function runsScoredOnPitch(pitch) {
  if (pitch.runs_scored != null) return pitch.runs_scored;
  const ev = (pitch.events || "").toLowerCase();
  if (!ev) return 0;
  const des = (pitch.des || "").toLowerCase();
  let runs = (des.match(/\bscores\b/g) || []).length;
  if (ev === "home_run") runs += 1;
  return runs;
}

/** True when this pitch's play scored at least one run. */
export function isRunScored(pitch) {
  return runsScoredOnPitch(pitch) > 0;
}

/**
 * Check if a pitch is the last pitch of a strikeout PA.
 */
export function isStrikeoutPitch(pitch) {
  const ev = (pitch.events || "").toLowerCase();
  return ev === "strikeout" || ev === "strikeout_double_play";
}

/**
 * Check if a pitch is the last pitch of a walk PA.
 */
export function isWalkPitch(pitch) {
  const ev = (pitch.events || "").toLowerCase();
  return ev === "walk" || ev === "intent_walk";
}

// Mid-AB events worth surfacing in the PA summary even when no run scored.
const _MID_AB_SUMMARY_EVENTS = ["Wild Pitch", "Caught Stealing", "Pickoff CS", "Passed Ball", "Balk"];

/**
 * Notable mid-at-bat action events for a PA (wild pitches, caught stealing,
 * balks, anything that scored). Rendered as their own italic lines between
 * PAs rather than appended to the batter's result.
 */
export function getNotableMidAbActions(pa) {
  return (pa.pitches || []).filter(p => p.is_action && (p.scored || _MID_AB_SUMMARY_EVENTS.some(e =>
    (p.event_type || "").toLowerCase().includes(e.toLowerCase()) || (p.desc || "").toLowerCase().includes(e.toLowerCase())
  )));
}

/**
 * Wild pitch / passed ball — these belong inline with the pitch they happened
 * on in the pitch-by-pitch view; other actions (steals, pickoffs, balks) get
 * their own line.
 */
export function isWildPitchOrPassedBall(action) {
  const evt = (action.event_type || "").toLowerCase();
  const dsc = (action.desc || "").toLowerCase();
  return evt.includes("wild_pitch") || evt.includes("passed_ball") || dsc.includes("wild pitch") || dsc.includes("passed ball");
}

/**
 * Build the ordered render list for the pitch-by-pitch table. Wild pitch /
 * passed ball actions are folded into the preceding pitch (as `inlineAction`);
 * all other actions stay as standalone rows.
 */
export function buildExpandedPitchItems(pitches) {
  const items = [];
  for (const p of pitches || []) {
    if (p.is_action) {
      const prev = items[items.length - 1];
      if (isWildPitchOrPassedBall(p) && prev && !prev.is_action) {
        items[items.length - 1] = { ...prev, inlineAction: p };
      } else {
        items.push(p);
      }
    } else {
      items.push(p);
    }
  }
  return items;
}

/**
 * Shared Result-filter predicate. `effectiveResultFilter` is a Set of the
 * currently-selected RESULT_FILTER_OPTIONS (plus overlay categories
 * Run(s)/Strikeout/Walk). Used by both the plots and the pitch-overview
 * table so they stay in sync.
 */
export function matchesResultFilter(p, effectiveResultFilter) {
  const cat = classifyPitchResult(p);
  if (effectiveResultFilter.has("Run(s)") && isRunScored(p)) return true;
  if (effectiveResultFilter.has("Strikeout") && isStrikeoutPitch(p)) return true;
  if (effectiveResultFilter.has("Walk")) {
    const ev = (p.events || "").toLowerCase();
    const desc = (p.description || "").toLowerCase();
    if (p.balls === 3 && cat === "Ball" && ev === "walk" && desc !== "hit_by_pitch") return true;
  }
  return effectiveResultFilter.has(cat) || cat === "Other";
}

/**
 * Classify batted ball type.
 * Burner: EV >= 93, LA < 10° (hard contact, low angle)
 * Flare: EV >= 80, LA 10-25° (soft liners)
 * Flare + Topped/Under/Poor = "Weak BIP"
 * Burner + Solid + Barrel = "Hard BIP"
 */
export function classifyBattedBallSimple(ev, la) {
  if (ev >= 98) {
    const laMin = Math.max(8, 26 - (ev - 98) * 1.5);
    const laMax = Math.min(50, 30 + (ev - 98) * 1.3);
    if (la >= laMin && la <= laMax) return "Barrel";
  }
  if (ev >= 90 && la >= 10 && la <= 50) return "Solid";
  if (ev >= 93 && la < 10) return "Burner";
  if (ev >= 80 && la >= 10 && la <= 25) return "Flare";
  if (ev >= 90) return "Solid";
  return "Other";
}

/**
 * Classify batted ball into Weak BIP or Hard BIP category.
 * Full classification using launch speed + launch angle.
 * Hard = Barrel, Solid, Burner (EV >= 93, LA < 10).
 * Weak = Flare, Topped, Under, Poor.
 */
export function classifyBIPQuality(launchSpeed, launchAngle) {
  if (launchSpeed == null || launchAngle == null) return null;
  const tag = classifyBattedBallFull(launchSpeed, launchAngle);
  if (tag === "Barrel" || tag === "Solid" || tag === "Burner") return "Hard";
  return "Weak";
}

/**
 * Full batted ball classification for display.
 * Burner: EV >= 93, LA < 10°. Flare: EV >= 80, LA 10-25°.
 */
export function classifyBattedBallFull(launchSpeed, launchAngle) {
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

/**
 * Check if a pitch result is a "Weak BIP" for filter purposes.
 * Weak BIP = balls in play with Flare, Topped, Under, or Poor batted ball type.
 */
export function isWeakBIP(pitch) {
  const desc = (pitch.description || "").toLowerCase();
  const ev = (pitch.events || "").toLowerCase();
  if (desc !== "hit_into_play" && !ev) return false;
  // Must be a ball in play
  if (!ev || ev === "hit_by_pitch") return false;
  const ls = pitch.launch_speed;
  const la = pitch.launch_angle;
  if (ls == null || la == null) return false;
  const quality = classifyBIPQuality(ls, la);
  return quality === "Weak";
}

/**
 * Check if a pitch is a ball in play (for Contact filter).
 */
export function isBallInPlay(pitch) {
  const desc = (pitch.description || "").toLowerCase();
  const ev = (pitch.events || "").toLowerCase();
  return desc === "hit_into_play" && ev && ev !== "hit_by_pitch";
}

export const RESULT_FILTER_OPTIONS = [
  "HR", "Single", "Double", "Triple", "Strikeout", "Walk",
  "Whiff", "Foul", "Called Strike", "Ball", "HBP", "Out", "Run(s)",
];

const ALL_HITS = new Set(["HR", "Single", "Double", "Triple"]);
const CSW_ONLY = new Set(["Called Strike", "Whiff"]);
const ALL_BIP = new Set(["HR", "Single", "Double", "Triple", "Out"]);
const STRIKES_ONLY = new Set(["HR", "Single", "Double", "Triple", "Strikeout", "Whiff", "Foul", "Called Strike", "Out"]);

export const RESULT_QUICK_ACTIONS = [
  {
    label: "All Hits",
    fn: (_cur, _all) => new Set(ALL_HITS),
  },
  {
    label: "CSW",
    fn: (_cur, _all) => new Set(CSW_ONLY),
  },
  {
    label: "All BIP",
    fn: (_cur, _all) => new Set(ALL_BIP),
  },
  {
    label: "Strikes",
    fn: (_cur, _all) => new Set(STRIKES_ONLY),
  },
];

/**
 * Normalize pitch description for display.
 * foul_tip → "Swinging Strike", swinging_strike_blocked → "Swinging Strike"
 */
export function normalizePitchDesc(desc) {
  if (!desc) return desc;
  const d = desc.toLowerCase();
  if (d === "foul_tip" || d === "swinging_strike_blocked") return "Swinging Strike";
  if (d === "swinging_strike") return "Swinging Strike";
  return desc;
}

/**
 * Detect catcher's interference or error PA results.
 * Handles MLB Live API string variants ("Catcher Interference", "Field Error",
 * "Fielding Error", etc.) plus the truncated Statcast event "catcher_interf".
 */
export function isCIOrErrorEvent(result) {
  if (!result) return false;
  const r = result.toLowerCase().replace(/\s+/g, "_");
  return r === "catcher_interf" || r.includes("interference") || r.includes("error");
}

/**
 * Color for a PA result in the play-by-play tooltips and PBP cards.
 * Single source of truth — used by Scoreboard, VelocityTrendV2 inning tooltip,
 * PitcherCard PBP, and PlayByPlayModal.
 *
 * Catcher's interference and errors return single yellow (#feffa3); the renderer
 * is expected to highlight the "X reaches on..." sentence in walk orange.
 * Returns null if the result doesn't map to a known color.
 */
export function getPBPResultColor(result) {
  if (!result) return null;
  const r = result.toLowerCase().replace(/\s+/g, "_");
  if (r === "strikeout" || r === "strikeout_double_play") return "#65FF9C";
  if (r === "walk" || r === "intent_walk") return "#ffc277";
  if (r === "hit_by_pitch") return "#ffc277";
  if (r === "home_run") return "#FF5EDC";
  if (r === "single" || r === "double" || r === "triple") return "#feffa3";
  // CI / error events render in single yellow with the batter event highlighted
  // in walk orange by the description renderer (see getPADescriptionSpans).
  if (r === "catcher_interf" || r.includes("interference") || r.includes("error")) return "#feffa3";
  if (r.includes("out") || r.includes("play") || r.includes("force") || r.endsWith("_dp") ||
      r === "fielders_choice" || r === "sac_fly" || r === "sac_bunt") return "#65BAFF";
  return null;
}

const _SCORES_RE = /\bscores\b/i;
const _REACHES_ON_RE = /\breaches on\b/i;
const _OUT_PATTERNS_RE = /\bout at\b|\bout advancing\b|\bthrown out\b/i;
const _WP_PB_RE = /\bwild pitch\b|\bpassed ball\b/i;

/**
 * Split a PA description into colored sentence spans.
 *
 * Rules (in priority order):
 *  - Sentences containing "scores" → HR pink (#FF5EDC), bold.
 *  - Sentences mentioning a wild pitch or passed ball → barrel red (#ffa3a3).
 *  - For CI/error events, sentences matching "reaches on ..." → barrel red
 *    (#ffa3a3) so the batter-event sentence pops inside the yellow baseline.
 *  - For hits with subsequent outs, the out sentence is colored blue (#65BAFF).
 *  - Everything else stays default.
 */
export function getPADescriptionSpans(description, { isCIOrError = false, isHitWithOut = false } = {}) {
  if (!description) return [];
  return description.split(/(?<=\.\s+)/).map(text => {
    if (_SCORES_RE.test(text)) return { text, style: { color: "#FF5EDC", fontWeight: 700 } };
    if (_WP_PB_RE.test(text)) return { text, style: { color: "#ffa3a3" } };
    if (isCIOrError && _REACHES_ON_RE.test(text)) return { text, style: { color: "#ffa3a3" } };
    if (isHitWithOut && _OUT_PATTERNS_RE.test(text)) return { text, style: { color: "#65BAFF" } };
    return { text, style: null };
  });
}

/**
 * Get tooltip result label + color for any pitch.
 * PA-ending pitches show the event result; mid-AB pitches show the pitch description.
 * Returns { label, color, isK, isCalledStrikeThree, subLabel }.
 *
 * Works with both Statcast pitches (description/events fields)
 * and PBP pitches (desc field + optional paResult).
 *
 * For PBP pitches, pass { desc, paResult, isLastPitch } in opts.
 */
export function getTooltipResult(pitch, opts) {
  // Normalize: support both Statcast and PBP pitch formats
  let desc, ev;
  if (opts?.desc != null) {
    // PBP format: desc is human-readable like "Called Strike"
    desc = (opts.desc || "").toLowerCase().replace(/\s+/g, "_");
    ev = opts.isLastPitch ? (opts.paResult || "").toLowerCase().replace(/\s+/g, "_") : "";
  } else {
    desc = (pitch.description || "").toLowerCase();
    ev = (pitch.events || "").toLowerCase();
  }

  // PA-ending events take priority
  if (ev) {
    if (ev === "strikeout" || ev === "strikeout_double_play") {
      const isCalledStrikeThree = desc === "called_strike";
      const subLabel = isCalledStrikeThree ? "Called Strike" : "Swinging Strike";
      return { label: "Strikeout", color: "#65FF9C", isK: true, isCalledStrikeThree, subLabel };
    }
    if (ev === "walk" || ev === "intent_walk") return { label: "Walk", color: "#ffc277" };
    if (ev === "hit_by_pitch") return { label: "HBP", color: "#ffc277" };
    if (ev === "home_run") return { label: "Home Run", color: "#FF5EDC" };
    if (ev === "single") return { label: "Single", color: "#feffa3" };
    if (ev === "double") return { label: "Double", color: "#feffa3" };
    if (ev === "triple") return { label: "Triple", color: "#feffa3" };
    if (ev === "sac_fly" || ev === "sac_fly_double_play") return { label: "Sac Fly", color: "#AAB9FF" };
    if (ev === "sac_bunt") return { label: "Sac Bunt", color: "#AAB9FF" };
    if (ev === "field_error" || ev === "fielding_error" || ev === "error") {
      // Trajectory-based out label in blue, "(Error)" suffix in walk orange.
      // Per-PA renderer (getPADescriptionSpans) colors the batter event sentence
      // in walk orange — the label here echoes that for visual consistency.
      const la = pitch.launch_angle != null ? pitch.launch_angle : (opts?.launchAngle ?? null);
      let outType = null;
      if (la != null) {
        if (la < 10) outType = "Groundout";
        else if (la <= 25) outType = "Lineout";
        else if (la <= 50) outType = "Flyout";
        else outType = "Popout";
      }
      const label = outType ? `${outType} (Error)` : "Error";
      return { label, color: "#feffa3", isError: true, errorOutType: outType };
    }
    if (ev === "catcher_interf" || ev === "catcher_interference") {
      return { label: "Catcher Int.", color: "#feffa3", isError: true };
    }
    // Outs with trajectory-based labels (includes fielder's choice, force outs, double plays)
    if (ev.includes("out") || ev.includes("play") || ev.includes("force") || ev.endsWith("_dp") || ev === "fielders_choice") {
      const la = pitch.launch_angle != null ? pitch.launch_angle : (opts?.launchAngle ?? null);
      let label = "Out";
      if (la != null) {
        if (la < 10) label = "Groundout";
        else if (la <= 25) label = "Lineout";
        else if (la <= 50) label = "Flyout";
        else label = "Popout";
      } else {
        // Fallback: derive from the event name when launch angle is missing
        if (ev.includes("ground")) label = "Groundout";
        else if (ev.includes("line")) label = "Lineout";
        else if (ev.includes("fly") || ev.includes("sac_fly")) label = "Flyout";
        else if (ev.includes("pop")) label = "Popout";
      }
      const isDp = ev.includes("double_play") || ev.endsWith("_dp");
      if (isDp) label = label === "Groundout" ? "Groundball DP" : label + " Into Double Play";
      return { label, color: "#65BAFF" };
    }

    return { label: ev.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()), color: "#ccc" };
  }

  // Non-PA pitches — show pitch description
  if (desc === "called_strike") return { label: "Called Strike", color: "#65FF9C" };
  if (desc === "swinging_strike" || desc === "swinging_strike_blocked" || desc === "foul_tip" || desc === "missed_bunt")
    return { label: "Whiff", color: "#65FF9C" };
  if (desc.includes("ball") && !desc.includes("in_play")) return { label: "Ball", color: "#ffc277" };
  if (desc === "pitchout") return { label: "Ball", color: "#ffc277" };
  if (desc.includes("foul")) return { label: "Foul", color: "#AAB9FF" };
  if (desc === "hit_by_pitch") return { label: "HBP", color: "#ffc277" };

  return { label: desc.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()), color: "#ccc" };
}
