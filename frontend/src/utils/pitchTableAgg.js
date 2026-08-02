// Client-side pitch-overview aggregation.
//
// Mirrors the backend `_aggregate_pitch_df` for a single pitcher/game so the
// Pitch Overview table can react to the Result and Inning filters (which are
// applied client-side to the raw pitch list). Note: on the frontend, pfx_x /
// pfx_z are already converted to inches in `build_pitches_list`, so iVB/iHB are
// plain means (no ×12). Percentage columns are returned UNROUNDED to match the
// server payload — the table's display layer rounds once at render time.

function mean(values) {
  const nums = values.filter((v) => v != null && !Number.isNaN(v));
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return Math.round((sum / nums.length) * 10) / 10;
}

/**
 * Aggregate a flat list of pitch records into per-pitch-type rows shaped like
 * the server's pitch_table (the rows PitchDataTable consumes).
 *
 * @param {Array} pitches raw pitch records (already filtered as desired)
 * @returns {Array} rows sorted by count descending
 */
export function aggregatePitchTable(pitches) {
  if (!pitches || pitches.length === 0) return [];

  const grandTotal = pitches.length;
  const grandVsR = pitches.filter((p) => p.stand === "R").length;
  const grandVsL = pitches.filter((p) => p.stand === "L").length;

  const groups = new Map();
  for (const p of pitches) {
    // Bucket unclassified pitches under "Unclassified" (matching the backend's
    // _str_defaults) instead of dropping them — otherwise they'd still count in
    // grandTotal and the per-row Usage would no longer sum to 100%.
    const name = p.pitch_name || "Unclassified";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(p);
  }

  const rows = [];
  for (const [pitchName, arr] of groups.entries()) {
    const total = arr.length;
    const vsR = arr.filter((p) => p.stand === "R").length;
    const vsL = arr.filter((p) => p.stand === "L").length;

    let whiffs = 0, cs = 0, strikes = 0;
    let appearanceOrder = 999;
    for (const p of arr) {
      const desc = (p.description || "").toLowerCase();
      const isWhiff = desc === "swinging_strike" || desc === "swinging_strike_blocked" || desc === "foul_tip";
      if (isWhiff) whiffs++;
      if (desc === "called_strike") cs++;
      // Strike count: prefer the Statcast `type` (S = strike incl. foul/whiff/
      // called/bunt, X = in play) so it matches the backend's `type IN ('S','X')`
      // exactly — including bunt strikes (missed_bunt/foul_bunt) the description
      // list would miss. Fall back to a description reconstruction only for
      // records that predate the shipped `type` field.
      if (p.type === "S" || p.type === "X") {
        strikes++;
      } else if (!p.type && (isWhiff || desc === "called_strike" || (desc.includes("foul") && desc !== "foul_tip") || desc === "hit_into_play")) {
        strikes++;
      }
      if (p.at_bat_number != null && p.at_bat_number < appearanceOrder) {
        appearanceOrder = p.at_bat_number;
      }
    }

    rows.push({
      pitch_name: pitchName,
      pitch_type: arr[0].pitch_type || "",
      count: total,
      velo: mean(arr.map((p) => p.release_speed)),
      // Usage is intentionally relative to the FILTERED set (grandTotal = the
      // pitches passed in), so under a Result/Inning filter it reads as "share
      // of the matching pitches" and the column sums to 100%. This differs from
      // the unfiltered server table's game-relative usage — by design.
      usage: grandTotal > 0 ? (total / grandTotal) * 100 : 0,
      vs_r: total > 0 ? Math.round((vsR / total) * 1000) / 10 : 0,
      vs_l: total > 0 ? Math.round((vsL / total) * 1000) / 10 : 0,
      usage_vs_r: grandVsR > 0 ? (vsR / grandVsR) * 100 : 0,
      usage_vs_l: grandVsL > 0 ? (vsL / grandVsL) * 100 : 0,
      count_vs_r: vsR,
      count_vs_l: vsL,
      ext: mean(arr.map((p) => p.release_extension)),
      ivb: mean(arr.map((p) => p.pfx_z)),
      ihb: mean(arr.map((p) => p.pfx_x)),
      havaa: mean(arr.map((p) => p.havaa)),
      whiffs,
      strike_pct: total > 0 ? (strikes / total) * 100 : 0,
      cs_pct: total > 0 ? (cs / total) * 100 : 0,
      swstr_pct: total > 0 ? (whiffs / total) * 100 : 0,
      csw_pct: total > 0 ? ((cs + whiffs) / total) * 100 : 0,
      appearance_order: appearanceOrder,
    });
  }

  rows.sort((a, b) => (b.count || 0) - (a.count || 0));
  return rows;
}
