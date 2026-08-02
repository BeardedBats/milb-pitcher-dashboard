import React from "react";
import { fmt, fmtPct, fmtInt, getIhbDeltaColor, getIvbDeltaColor, hexToRgba } from "./formatting";

// Shared logic for the game-log "pitch type + handedness" view, used by both the
// player-page game log and the single game card's Regular Season log. Every value
// is read from the same `per_game_summaries` / `pitch_summary` data that feeds the
// Pitch Overview table, so the two views always agree.

// Stable key for a game-log row — shared by the results view, the pitch-data
// view, and shift-selection so the same game maps to the same key everywhere.
export const getGameKey = (row, index) => `${row.game_pk || row.date || "game"}-${index}`;

// Pitch Overview's columns minus the Vs L / Vs R splits (Date and Opp are
// supplied by the table, in place of the pitch-type column).
export const GL_PITCH_COLS = [
  { key: "count", label: "#" }, { key: "velo", label: "Velo" }, { key: "usage", label: "Usage" },
  { key: "ext", label: "Ext" }, { key: "ivb", label: "IVB" }, { key: "ihb", label: "IHB" },
  { key: "havaa", label: "HAVAA" }, { key: "cs_pct", label: "CS%" }, { key: "swstr_pct", label: "SwStr%" },
  { key: "csw_pct", label: "CSW%" }, { key: "strike_pct", label: "Strike%" },
  { key: "two_str_pct", label: "2-Str" }, { key: "par_pct", label: "PAR%" },
];
const GL_PHYS_KEYS = ["velo", "ext", "ivb", "ihb", "havaa"];
const GL_PCT_KEYS = new Set(["usage", "cs_pct", "swstr_pct", "csw_pct", "strike_pct", "two_str_pct", "par_pct"]);

// Per-game value vs the season average for the same pitch + hand slice —
// same delta thresholds + colors as Pitch Overview's (±x.x) parentheticals,
// applied to the value itself. iVB/iHB use the directional color helpers.
const GL_DELTA_THRESHOLDS = {
  velo: { up: 1.0, down: -1.0 },
  usage: { up: 5, down: -5 },
  ext: { up: 0.3, down: -0.2 },
};

// 2-Str: share of this slice's pitches thrown in 2-strike counts.
// PAR%: Ks recorded on those 2-strike pitches (putaway rate). Computed from
// the raw counters so shift-selected subsets re-aggregate exactly.
function addTwoStrikeRates(row) {
  if (row == null || row.two_str_pitches == null) return row;
  const n = row.count || 0;
  return {
    ...row,
    two_str_pct: n > 0 ? (row.two_str_pitches / n) * 100 : null,
    par_pct: row.two_str_pitches > 0 ? ((row.two_str_ks || 0) / row.two_str_pitches) * 100 : null,
  };
}

export const glSliceKey = (glHand) => glHand === "L" ? "vs_l" : glHand === "R" ? "vs_r" : "all";

export const glSeasonSlice = (data, glHand) =>
  glHand === "L" ? (data.pitch_summary_vs_l || [])
    : glHand === "R" ? (data.pitch_summary_vs_r || [])
      : (data.pitch_summary || []);

// Count-weighted aggregate of pitch-data rows — matches Pitch Overview's totals
// math. keepPhysical=false dashes velo/usage/movement (meaningless to average
// across different pitch types).
export function aggregatePitchRows(rows, keepPhysical) {
  let count = 0, hand = 0, strikes = 0, cs = 0, sw = 0, csw = 0;
  let twoStr = 0, twoStrKs = 0;
  const phys = { velo: [0, 0], ext: [0, 0], ivb: [0, 0], ihb: [0, 0], havaa: [0, 0] };
  for (const r of rows) {
    const n = r.count || 0;
    count += n; hand += r._handTotal || 0;
    if (r.strike_pct != null) strikes += (r.strike_pct / 100) * n;
    if (r.cs_pct != null) cs += (r.cs_pct / 100) * n;
    if (r.swstr_pct != null) sw += (r.swstr_pct / 100) * n;
    if (r.csw_pct != null) csw += (r.csw_pct / 100) * n;
    twoStr += r.two_str_pitches || 0;
    twoStrKs += r.two_str_ks || 0;
    for (const k of GL_PHYS_KEYS) { if (r[k] != null) { phys[k][0] += r[k] * n; phys[k][1] += n; } }
  }
  const pct = (s) => count > 0 ? Math.round((s / count) * 100) : 0;
  const out = {
    count, cs_pct: pct(cs), swstr_pct: pct(sw), csw_pct: pct(csw), strike_pct: pct(strikes),
    two_str_pitches: twoStr, two_str_ks: twoStrKs,
    two_str_pct: count > 0 ? (twoStr / count) * 100 : null,
    par_pct: twoStr > 0 ? (twoStrKs / twoStr) * 100 : null,
  };
  if (keepPhysical) {
    for (const k of GL_PHYS_KEYS) out[k] = phys[k][1] > 0 ? phys[k][0] / phys[k][1] : null;
    out.usage = hand > 0 ? Math.round((count / hand) * 100) : null;
  }
  return out;
}

// One pitch-data row per game for the selected pitch + handedness.
export function buildGlRows(sortedLog, perGameSummaries, sliceKey, glPitch) {
  return sortedLog.map((g, i) => {
    const pg = perGameSummaries && perGameSummaries[String(g.game_pk)];
    const slice = (pg && pg[sliceKey]) || [];
    const handTotal = slice.reduce((s, r) => s + (r.count || 0), 0);
    let row;
    if (glPitch) { const f = slice.find(r => r.pitch_name === glPitch); row = f ? addTwoStrikeRates({ ...f }) : { count: 0 }; }
    else { row = aggregatePitchRows(slice.map(r => ({ ...r, _handTotal: handTotal })), false); }
    return {
      ...row, _handTotal: handTotal, date: g.date, game_pk: g.game_pk, _i: i,
      // Opp column — from the game-log entry, same fields the results view uses.
      opponent: g.opponent, team: g.team, home_team: g.home_team,
    };
  });
}

// Totals row: the full season reuses the exact backend summary (identical to
// Pitch Overview); a shift-selected subset re-aggregates only the chosen games.
export function computeGlTotal(selectedRows, hasSelection, seasonSlice, glPitch) {
  if (hasSelection) return aggregatePitchRows(selectedRows, glPitch != null);
  if (glPitch) return addTwoStrikeRates(seasonSlice.find(r => r.pitch_name === glPitch)) || { count: 0 };
  const handTot = seasonSlice.reduce((s, r) => s + (r.count || 0), 0);
  return aggregatePitchRows(seasonSlice.map(r => ({ ...r, _handTotal: handTot })), false);
}

// ===== Pitch Mix view =====
// Game-log view with one column per pitch type the pitcher has thrown this
// season; each cell is that game's usage% with the pitch's velocity in parens.

// Fallback when a summary row is missing its Statcast pitch_type code.
// Mirrors PITCH_NAME_TO_CODE in backend/data.py.
const PITCH_NAME_TO_CODE = {
  "Four-Seamer": "FF", "Sinker": "SI", "Cutter": "FC",
  "Slider": "SL", "Sweeper": "ST", "Curveball": "CU",
  "Changeup": "CH", "Splitter": "FS", "Knuckleball": "KN",
  "Eephus": "EP", "Screwball": "SC", "Forkball": "FO",
};

// One column per season pitch type, ordered by season count (primary pitch first).
export function buildPitchMixCols(pitchSummary) {
  return [...(pitchSummary || [])]
    .filter(r => r.pitch_name)
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .map(r => ({
      name: r.pitch_name,
      code: r.pitch_type || PITCH_NAME_TO_CODE[r.pitch_name] || r.pitch_name.slice(0, 2).toUpperCase(),
    }));
}

// Velocity coloring mirrors the game card's Pitch Overview velo delta: each
// game's velo is compared against the season-to-date average BEFORE that game
// (count-weighted across prior games' "all" slice — the card's delta baseline
// is overall, not hand-split, even when a vs L/R filter is active). The
// season's first game falls back to the previous season's averages, like the
// card's compareTo auto-switch. ±1.0 mph = the same delta-up/delta-down
// thresholds as DELTA_THRESHOLDS.velo in PitchDataTable.
export function buildPitchMixRows(sortedLog, perGameSummaries, sliceKey, pitchCols, prevSeasonAvgs) {
  const running = {}; // pitch_name -> [sum(velo*count), sum(count)] over prior games
  let priorGames = 0;
  return sortedLog.map((g, i) => {
    const pg = perGameSummaries && perGameSummaries[String(g.game_pk)];
    const slice = (pg && pg[sliceKey]) || [];
    const allSlice = (pg && pg.all) || [];
    const handTotal = slice.reduce((s, r) => s + (r.count || 0), 0);
    const cells = {};
    for (const col of pitchCols) {
      const r = slice.find(x => x.pitch_name === col.name);
      let veloClass = null;
      if (r && r.velo != null) {
        let baseline = null;
        if (priorGames > 0) {
          const run = running[col.name];
          baseline = run && run[1] > 0 ? run[0] / run[1] : null; // null = new pitch → no color
        } else if (prevSeasonAvgs && prevSeasonAvgs[col.name]) {
          baseline = prevSeasonAvgs[col.name].velo ?? null;
        }
        if (baseline != null) {
          const delta = r.velo - baseline;
          if (delta >= 1.0) veloClass = "delta-up";
          else if (delta <= -1.0) veloClass = "delta-down";
        }
      }
      cells[col.name] = {
        usage: r && r.usage != null ? r.usage : null,
        velo: r && r.velo != null ? r.velo : null,
        count: (r && r.count) || 0,
        veloClass,
      };
    }
    for (const r of allSlice) {
      if (r.pitch_name && r.velo != null && r.count) {
        const run = running[r.pitch_name] || (running[r.pitch_name] = [0, 0]);
        run[0] += r.velo * r.count;
        run[1] += r.count;
      }
    }
    if (allSlice.length > 0) priorGames++;
    return { cells, _handTotal: handTotal, date: g.date, game_pk: g.game_pk, _i: i };
  });
}

// Totals per pitch column: the full season reuses the backend summary slice
// (identical to Pitch Overview); a shift-selected subset re-aggregates only
// the chosen games, count-weighted.
export function computePitchMixTotal(selectedRows, pitchCols, seasonSlice, hasSelection) {
  const out = {};
  if (!hasSelection) {
    for (const col of pitchCols) {
      const r = (seasonSlice || []).find(x => x.pitch_name === col.name);
      out[col.name] = {
        usage: r && r.usage != null ? r.usage : null,
        velo: r && r.velo != null ? r.velo : null,
      };
    }
    return out;
  }
  for (const col of pitchCols) {
    let count = 0, handTotal = 0, veloSum = 0, veloN = 0;
    for (const row of selectedRows) {
      handTotal += row._handTotal || 0;
      const c = row.cells[col.name];
      if (!c) continue;
      count += c.count || 0;
      if (c.velo != null && c.count) { veloSum += c.velo * c.count; veloN += c.count; }
    }
    out[col.name] = {
      usage: handTotal > 0 && count > 0 ? (count / handTotal) * 100 : null,
      velo: veloN > 0 ? veloSum / veloN : null,
    };
  }
  return out;
}

// Render one Pitch Mix cell: "54% (92.0)" — velo colored when it clears the
// per-game delta threshold, totals velo uncolored. Rounds inline instead of
// fmtPct so a sub-0.5% usage shows "0%" rather than fmtPct's "-". The velo
// parenthetical is wrapped so the heatmap tint can drop it to ~0.55 opacity
// without dimming the usage number.
export function renderPitchMixCell(cell) {
  if (!cell || cell.usage == null) return "—";
  return (
    <>
      {Math.round(Number(cell.usage))}%
      {cell.velo != null && (
        <span className="gl-mix-velo"> (<span className={cell.veloClass || undefined}>{cell.velo.toFixed(1)}</span>)</span>
      )}
    </>
  );
}

// Per-pitch min/max of usage% across the displayed game mix rows (excludes the
// season-total row, which isn't part of mixRows). Drives the column-relative
// heatmap tint, so an 8% sinker reads "low for him", not "low absolutely".
export function pitchMixHeatRanges(mixRows, pitchCols) {
  const ranges = {};
  for (const col of pitchCols) {
    let min = Infinity, max = -Infinity;
    for (const r of mixRows) {
      const v = r.cells[col.name] && r.cells[col.name].usage;
      if (v == null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ranges[col.name] = min === Infinity ? null : { min, max };
  }
  return ranges;
}

// Heatmap background for one usage value within its column's range. Layered
// linear-gradient so the tint composites over the cell's opaque base color
// (cells stay square-edged — the tint reads as one continuous column).
export function pitchMixHeatStyle(color, range, v) {
  if (!color || !range || v == null) return undefined;
  const { min, max } = range;
  if (max <= 0) return undefined; // never thrown across the displayed starts — leave untinted
  const t = max === min ? 0.5 : (v - min) / (max - min);
  const tint = hexToRgba(color, 0.06 + t * 0.46); // 0.06 .. 0.52
  return { backgroundImage: `linear-gradient(${tint}, ${tint})` };
}

// Segments for one game's distribution bar, in canonical arsenal order. Widths
// are the displayed usage%; any untracked remainder (sum < 100, from arsenal
// pitches not shown + rounding) becomes a faint neutral "other" segment so the
// bar is always honest about what it isn't showing.
export function buildMixBarSegments(cells, pitchCols, colorOf) {
  if (!cells) return null;
  const segments = [];
  let sum = 0;
  for (const col of pitchCols) {
    const c = cells[col.name];
    const pct = c && c.usage != null ? Number(c.usage) : 0;
    if (pct <= 0) continue;
    sum += pct;
    segments.push({ name: col.name, code: col.code, pct, velo: c.velo, color: colorOf(col.name) });
  }
  return { segments, other: Math.max(0, 100 - sum) };
}

// Render one pitch-data cell, matching Pitch Overview formatting. When a
// pitch type is selected, values that move off the season average (the
// `baseline` row — same pitch + hand slice) take the delta colors instead of
// the old red/blue percentile frames. The Season Total row IS the baseline,
// so it renders uncolored (a shift-selected subset still colors vs season).
export function renderGlCell(row, key, glPitch, pitcherHand, baseline) {
  const v = row[key];
  if (key === "count") return fmtInt(v);
  const isPct = GL_PCT_KEYS.has(key);
  if (v == null || v === "" || isNaN(v)) return isPct ? fmtPct(v) : fmt(v);
  const text = key === "ihb" ? fmt(-Number(v)) : isPct ? fmtPct(v) : fmt(v);
  const base = glPitch && baseline ? baseline[key] : null;
  if (base == null || base === "" || isNaN(base)) return text;
  if (key === "ihb") {
    // Compare in display space (negated from pfx_x), like Pitch Overview.
    const neg = -Number(v), baseNeg = -Number(base);
    const color = getIhbDeltaColor(neg - baseNeg, glPitch, pitcherHand, baseNeg, neg);
    return color ? <span style={{ color }}>{text}</span> : text;
  }
  if (key === "ivb") {
    const color = getIvbDeltaColor(Number(v) - Number(base), glPitch, Number(base), Number(v));
    return color ? <span style={{ color }}>{text}</span> : text;
  }
  const t = GL_DELTA_THRESHOLDS[key];
  if (t) {
    const delta = Number(v) - Number(base);
    if (delta >= t.up) return <span className="delta-up">{text}</span>;
    if (delta <= t.down) return <span className="delta-down">{text}</span>;
  }
  return text;
}
