import { classifyBIPQuality } from "./pitchFilters";
import { roundPercentParts } from "./formatting";

// Shared per-slice stat computations for the Regular Season game-log views.
// Definitions deliberately mirror the game card tabs so a game-log row always
// agrees with the card for the same game: Results = the card's ResultsTable,
// Usage = the card's UsageTable buckets, Overview hand splits = the backend
// game_log definitions (whiffs by description, strikes by Statcast type,
// PA-based 2Str%/PAR%).

export const WHIFF_DESCS = new Set(["swinging_strike", "swinging_strike_blocked", "foul_tip"]);
const K_EVENTS = new Set(["strikeout", "strikeout_double_play"]);

// Count bucket for a pitch (balls/strikes BEFORE the pitch was thrown) —
// same buckets as the card's Usage tab.
export function bucketFor(balls, strikes) {
  if (balls == null || strikes == null) return null;
  if (balls === 0 && strikes === 0) return "firstpitch";
  if (strikes === 2) return "two_str";
  if (balls >= 2 && strikes < 2) return "behind";
  if (strikes < 2 && balls < 2) return "early";
  return null;
}

// Filter raw pitches by batter hand ("all" | "L" | "R") + pitch type (null = all).
export function pitchSlice(pitches, hand, pitchName) {
  let arr = pitches || [];
  if (hand === "L" || hand === "R") arr = arr.filter(p => p.stand === hand);
  if (pitchName) arr = arr.filter(p => p.pitch_name === pitchName);
  return arr;
}

// Group a pitch slice by game_pk (string keys, matching per_game_summaries).
export function groupByGame(arr) {
  const m = new Map();
  for (const p of arr) {
    const k = String(p.game_pk);
    let g = m.get(k);
    if (!g) { g = []; m.set(k, g); }
    g.push(p);
  }
  return m;
}

// ===== Results view: identical per-pitch classification to the card's
// ResultsTable (which also calls this — one implementation, no drift). =====
export function computeResultsRow(pitchArr) {
  let total = 0;
  let zone = 0, oSwing = 0, oTotal = 0;
  let whiffs = 0, cs = 0, fouls = 0, strikes = 0;
  let bbs = 0, ks = 0;
  let bip = 0, hits = 0, outs = 0, hrs = 0;
  let weakBIP = 0, hardBIP = 0, gbCount = 0, fbCount = 0;

  for (const p of pitchArr) {
    if (!p.pitch_name) continue;
    total++;
    const desc = (p.description || "").toLowerCase();
    const ev = (p.events || "").toLowerCase();

    // Zone: plate_x between -0.83 and 0.83, plate_z between sz_bot and sz_top
    const inZone = p.plate_x != null && p.plate_z != null &&
      Math.abs(p.plate_x) <= 0.83 &&
      p.plate_z >= (p.sz_bot || 1.5) && p.plate_z <= (p.sz_top || 3.5);
    if (inZone) zone++;

    // O-Swing: swing outside zone
    const isOutside = p.plate_x != null && p.plate_z != null && !inZone;
    const isSwing = desc === "swinging_strike" || desc === "swinging_strike_blocked" ||
      desc === "foul_tip" || desc === "foul" || desc === "foul_bunt" ||
      desc === "hit_into_play" || desc === "missed_bunt";
    if (isOutside) { oTotal++; if (isSwing) oSwing++; }

    if (WHIFF_DESCS.has(desc)) { whiffs++; strikes++; }
    else if (desc === "called_strike") { cs++; strikes++; }
    else if (desc.includes("foul") && desc !== "foul_tip") { fouls++; strikes++; }
    else if (desc === "hit_into_play") { strikes++; }

    if (ev === "walk" || ev === "intent_walk") bbs++;
    if (K_EVENTS.has(ev)) ks++;

    if (ev && desc === "hit_into_play") {
      bip++;
      if (ev === "home_run") { hrs++; hits++; }
      else if (ev === "single" || ev === "double" || ev === "triple") hits++;
      else outs++;
      const quality = classifyBIPQuality(p.launch_speed, p.launch_angle);
      if (quality === "Weak") weakBIP++;
      else if (quality === "Hard") hardBIP++;
      if (p.launch_angle != null) {
        if (p.launch_angle < 10) gbCount++;
        else if (p.launch_angle > 25) fbCount++;
      }
    }
  }

  const csw = whiffs + cs;
  const [weakPct, hardPct] = roundPercentParts([weakBIP, hardBIP], bip);
  return {
    count: total,
    zone_pct: total > 0 ? Math.round((zone / total) * 100) : 0,
    o_swing_pct: oTotal > 0 ? Math.round((oSwing / oTotal) * 100) : 0,
    whiffs,
    cs,
    csw_pct: total > 0 ? Math.round((csw / total) * 100) : 0,
    strike_pct: total > 0 ? Math.round((strikes / total) * 100) : 0,
    fouls,
    foul_pct: total > 0 ? Math.round((fouls / total) * 100) : 0,
    bbs,
    ks,
    bip,
    hits,
    outs_bip: outs,
    hrs,
    gb_pct: bip > 0 ? Math.round((gbCount / bip) * 100) : 0,
    fb_pct: bip > 0 ? Math.round((fbCount / bip) * 100) : 0,
    weak_pct: weakPct,
    hard_pct: hardPct,
  };
}

// ===== Usage view: count buckets + PAR%, same math as the card's Usage tab.
// Bucket %s denominate by all (named) pitches in the slice. PAR% = Ks on the
// slice's 2-strike pitches / its 2-strike pitches. =====
export function computeUsageRow(pitchArr) {
  let count = 0, firstpitch = 0, early = 0, behind = 0, twoStr = 0, twoStrKs = 0;
  for (const p of pitchArr) {
    if (!p.pitch_name) continue;
    count++;
    const b = bucketFor(p.balls, p.strikes);
    if (b === "firstpitch") firstpitch++;
    else if (b === "early") early++;
    else if (b === "behind") behind++;
    else if (b === "two_str") {
      twoStr++;
      if (K_EVENTS.has((p.events || "").toLowerCase())) twoStrKs++;
    }
  }
  const [fpPct, earlyPct, behindPct, twoPct] = roundPercentParts([firstpitch, early, behind, twoStr], count);
  return {
    count,
    firstpitch_pct: count > 0 ? fpPct : null,
    early_pct: count > 0 ? earlyPct : null,
    behind_pct: count > 0 ? behindPct : null,
    two_str_pct: count > 0 ? twoPct : null,
    par_pct: twoStr > 0 ? Math.round((twoStrKs / twoStr) * 100) : null,
  };
}

// ===== Overview right block for a vs-LHB / vs-RHB slice =====
// Matches the backend game_log definitions: whiffs by description, strikes by
// Statcast type (S/X), 2Str% = PAs that reached 2 strikes / PAs, PAR% =
// Ks / two-strike PAs — restricted to the slice's batters. PAs are keyed by
// game + at_bat_number so a season-wide slice aggregates correctly.
export function computeOverviewSplitRow(pitchArr) {
  let whiffs = 0, cs = 0, strikes = 0, ks = 0, hrs = 0;
  const paMaxStrikes = new Map();
  for (const p of pitchArr) {
    const desc = (p.description || "").toLowerCase();
    if (WHIFF_DESCS.has(desc)) whiffs++;
    else if (desc === "called_strike") cs++;
    if (p.type === "S" || p.type === "X") strikes++;
    const ev = (p.events || "").toLowerCase();
    if (K_EVENTS.has(ev)) ks++;
    if (ev === "home_run") hrs++;
    if (p.at_bat_number != null && p.strikes != null) {
      const key = `${p.game_pk}|${p.at_bat_number}`;
      const prev = paMaxStrikes.get(key);
      if (prev == null || p.strikes > prev) paMaxStrikes.set(key, p.strikes);
    }
  }
  const count = pitchArr.length;
  const paCount = paMaxStrikes.size;
  let twoStrikePas = 0;
  for (const s of paMaxStrikes.values()) if (s >= 2) twoStrikePas++;
  return {
    pitches: count,
    whiffs,
    ks,
    hrs,
    swstr_pct: count > 0 ? (whiffs / count) * 100 : null,
    csw_pct: count > 0 ? ((cs + whiffs) / count) * 100 : null,
    strike_pct: count > 0 ? (strikes / count) * 100 : null,
    two_strike_pas: twoStrikePas,
    two_str_pct: paCount > 0 ? (twoStrikePas / paCount) * 100 : null,
    par_pct: twoStrikePas > 0 ? (ks / twoStrikePas) * 100 : null,
  };
}

// ===== Pitch Mix innings view =====
// Literal innings the pitcher appeared in across the season (column union),
// sorted ascending — a starter shows 1..N, a reliever shows e.g. 7, 8, 9.
export function buildInningCols(pitches) {
  const set = new Set();
  for (const p of pitches || []) if (p.inning != null) set.add(p.inning);
  return [...set].sort((a, b) => a - b);
}

// Per-inning usage% + avg velo for one pitch type within a pitch slice (a
// single game's pitches, or a whole-season slice for the Season Total row).
// Usage denominator = ALL pitches thrown in that inning within the slice.
export function computeInningsCells(pitchArr, pitchName) {
  const m = new Map();
  for (const p of pitchArr) {
    if (p.inning == null) continue;
    let rec = m.get(p.inning);
    if (!rec) { rec = { total: 0, n: 0, veloSum: 0, veloN: 0 }; m.set(p.inning, rec); }
    rec.total++;
    if (p.pitch_name === pitchName) {
      rec.n++;
      if (p.release_speed != null) { rec.veloSum += p.release_speed; rec.veloN++; }
    }
  }
  const out = {};
  for (const [inning, r] of m) {
    out[inning] = {
      usage: r.total > 0 ? (r.n / r.total) * 100 : null,
      velo: r.veloN > 0 ? r.veloSum / r.veloN : null,
    };
  }
  return out;
}
