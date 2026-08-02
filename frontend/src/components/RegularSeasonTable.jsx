import React, { useEffect, useMemo, useState } from "react";
import { useProjectedLatestGame } from "../hooks/useLiveLinescore";
import usePersistentState from "../hooks/usePersistentState";
import { PITCH_COLORS, CARD_RESULTS_COLUMNS, getPitchColor } from "../constants";
import {
  buildGlRows, computeGlTotal, glSliceKey, glSeasonSlice, getGameKey,
  buildPitchMixCols, buildPitchMixRows, computePitchMixTotal,
  renderPitchMixCell, renderGlCell, GL_PITCH_COLS,
  pitchMixHeatRanges, pitchMixHeatStyle, buildMixBarSegments,
} from "../utils/gameLogPitch";
import {
  pitchSlice, groupByGame, computeResultsRow, computeUsageRow,
  computeOverviewSplitRow, buildInningCols, computeInningsCells,
} from "../utils/gameLogStats";
import { detectApproachShift, MIN_SIDE_PITCHES } from "../utils/approachShift";
import GameLogTable from "./GameLogTable";
import PitchMixBar from "./PitchMixBar";

// Regular Season game log — shared by the player page and the game card.
// Three filters: view (Overview / Pitch Mix / Results / Usage), pitch type
// (All Pitches + the pitcher's types sorted by usage), batter hand.
//
// View matrix (left block is Date|Opp plus the full-game box score through K,
// except Results which keeps just Date|Opp):
// - Overview:            box score | Whiffs SwStr% CSW% Strike% 2Str% PAR% # HR
//                        (right block follows the hand filter; left stays full-game)
// - Overview + pitch:    box score | the Pitch Overview metrics for that pitch
//                        (#, Velo, Usage, ... 2-Str, PAR% with delta colors)
// - Pitch Mix:           box score | usage% (velo) per pitch type
// - Pitch Mix + pitch:   box score | usage% (velo) per literal inning
// - Results:             Date|Opp  | the card Results tab columns per game
// - Usage:               box score | # 0-0% Early% Behind% 2-Str% PAR%

const OVERVIEW_COLS = [
  { key: "whiffs", label: "Whiffs" }, { key: "swstr_pct", label: "SwStr%" },
  { key: "csw_pct", label: "CSW%" }, { key: "strike_pct", label: "Strike%" },
  { key: "two_str_pct", label: "2Str%" }, { key: "par_pct", label: "PAR%" },
  { key: "pitches", label: "#" }, { key: "hrs", label: "HR" },
];
const USAGE_COLS = [
  { key: "count", label: "#" }, { key: "firstpitch_pct", label: "0-0%" },
  { key: "early_pct", label: "Early%" }, { key: "behind_pct", label: "Behind%" },
  { key: "two_str_pct", label: "2-Str%" }, { key: "par_pct", label: "PAR%" },
];
const RESULTS_COLS = CARD_RESULTS_COLUMNS.filter(c => c.key !== "pitch_name");
const RESULTS_PCT_KEYS = new Set(["zone_pct", "o_swing_pct", "csw_pct", "strike_pct", "foul_pct", "gb_pct", "fb_pct", "weak_pct", "hard_pct"]);

export default function RegularSeasonTable({
  data,
  pitcherId,
  displayAbbrev,
  buildCardHref,
  onGameClick,
  prevSeasonAvgs,
  className,
}) {
  const [selectedGameKeys, setSelectedGameKeys] = useState(() => new Set());
  const [glView, setGlView] = useState("overview"); // "overview" | "mix" | "results" | "usage"
  const [glPitch, setGlPitch] = useState(null);     // null = All Pitches
  const [glHand, setGlHand] = useState("all");      // "all" | "L" | "R"

  // Pitch-Mix display modes — one shared preference across both surfaces and
  // every pitcher, persisted so the choice survives navigation.
  const [cellMode, setCellMode] = usePersistentState("pl_pitchmix_cellmode", "numbers"); // "numbers" | "bars"
  const [heatOn, setHeatOn] = usePersistentState("pl_pitchmix_heatmap", false);
  const [dividerOn, setDividerOn] = usePersistentState("pl_pitchmix_divider", false);

  const sortedLog = useMemo(() => {
    if (!data?.game_log) return [];
    return [...data.game_log].sort((a, b) => a.date.localeCompare(b.date));
  }, [data]);

  const liveGame = useProjectedLatestGame(sortedLog);

  useEffect(() => {
    setSelectedGameKeys(new Set());
    setGlView("overview");
    setGlPitch(null);
    setGlHand("all");
  }, [pitcherId, data]);

  const hasGameSelection = selectedGameKeys.size > 0;
  const totalLog = useMemo(() => hasGameSelection
    ? sortedLog.filter((row, index) => selectedGameKeys.has(getGameKey(row, index)))
    : sortedLog, [hasGameSelection, sortedLog, selectedGameKeys]);
  // game_pks the Season Total row covers — restricts the raw-pitch aggregates
  // when a shift-selection is active.
  const totalPks = useMemo(() => new Set(totalLog.map(r => String(r.game_pk))), [totalLog]);

  // Raw-pitch slices for the views computed client-side from data.pitches.
  const allPitches = useMemo(() => data?.pitches || [], [data]);
  const handSlice = useMemo(() => pitchSlice(allPitches, glHand, null), [allPitches, glHand]);
  const handSliceByGame = useMemo(() => groupByGame(handSlice), [handSlice]);
  const fullSlice = useMemo(() => (glPitch ? handSlice.filter(p => p.pitch_name === glPitch) : handSlice), [handSlice, glPitch]);
  const fullSliceByGame = useMemo(() => groupByGame(fullSlice), [fullSlice]);

  // Pitch filter options, sorted by season usage (primary pitch first).
  const pitchCols = useMemo(() => buildPitchMixCols(data?.pitch_summary), [data]);

  // ---- Overview + pitch type: per-game Pitch Overview metrics (same
  // per_game_summaries source as the card, with delta colors vs season avg).
  const glRows = useMemo(
    () => (glView === "overview" && glPitch) ? buildGlRows(sortedLog, data?.per_game_summaries, glSliceKey(glHand), glPitch) : [],
    [glView, glPitch, sortedLog, data, glHand]
  );
  const glTotalRows = useMemo(
    () => hasGameSelection ? glRows.filter(r => selectedGameKeys.has(getGameKey(r, r._i))) : glRows,
    [hasGameSelection, glRows, selectedGameKeys]
  );
  const glTotal = useMemo(
    () => (glView === "overview" && glPitch) ? computeGlTotal(glTotalRows, hasGameSelection, glSeasonSlice(data, glHand), glPitch) : null,
    [glView, glPitch, glTotalRows, hasGameSelection, data, glHand]
  );
  // Delta-color baseline: the full-season summary row for the selected pitch
  // + hand slice (stays fixed even when a shift-selection changes the total).
  const glBaseline = (glView === "overview" && glPitch)
    ? glSeasonSlice(data, glHand).find(r => r.pitch_name === glPitch) || null
    : null;

  // ---- Overview + vs LHB/RHB (no pitch): right block recomputed per hand.
  const overviewSplitByGame = useMemo(() => {
    if (glView !== "overview" || glPitch || glHand === "all") return null;
    const m = new Map();
    for (const [pk, arr] of handSliceByGame) m.set(pk, computeOverviewSplitRow(arr));
    return m;
  }, [glView, glPitch, glHand, handSliceByGame]);
  const overviewSplitTotal = useMemo(() => {
    if (glView !== "overview" || glPitch || glHand === "all") return null;
    return computeOverviewSplitRow(handSlice.filter(p => totalPks.has(String(p.game_pk))));
  }, [glView, glPitch, glHand, handSlice, totalPks]);

  // ---- Pitch Mix (no pitch type) — per-game usage% (velo) per pitch type.
  const glPrevAvgs = prevSeasonAvgs || data?.season_averages?.previous || null;
  const mixRows = useMemo(
    () => (glView === "mix" && !glPitch) ? buildPitchMixRows(sortedLog, data?.per_game_summaries, glSliceKey(glHand), pitchCols, glPrevAvgs) : [],
    [glView, glPitch, sortedLog, data, glHand, pitchCols, glPrevAvgs]
  );
  const mixTotalRows = useMemo(
    () => hasGameSelection ? mixRows.filter(r => selectedGameKeys.has(getGameKey(r, r._i))) : mixRows,
    [hasGameSelection, mixRows, selectedGameKeys]
  );
  const mixTotal = useMemo(
    () => (glView === "mix" && !glPitch) ? computePitchMixTotal(mixTotalRows, pitchCols, glSeasonSlice(data, glHand), hasGameSelection) : null,
    [glView, glPitch, mixTotalRows, pitchCols, data, glHand, hasGameSelection]
  );

  // ---- Pitch-Mix display modes (only the no-pitch mix view has usage cells) ----
  const mixView = glView === "mix" && !glPitch;
  const barsActive = mixView && cellMode === "bars";
  const heatActive = mixView && heatOn && cellMode === "numbers";
  const dividerActive = mixView && dividerOn && glHand !== "all";
  const side = glHand === "L" ? "LHB" : "RHB";
  const codeByName = useMemo(() => Object.fromEntries(pitchCols.map(c => [c.name, c.code])), [pitchCols]);

  // Column-relative heatmap ranges across the displayed game rows.
  const heatRanges = useMemo(
    () => (heatActive ? pitchMixHeatRanges(mixRows, pitchCols) : null),
    [heatActive, mixRows, pitchCols]
  );

  // Gated approach-shift detection over qualifying games (>= MIN_SIDE_PITCHES to
  // the active side). null = not enough games OR no significant shift.
  const approachShift = useMemo(() => {
    if (!dividerActive) return null;
    const keys = pitchCols.map(c => c.name);
    const qualifying = [];
    for (const r of mixRows) {
      if ((r._handTotal || 0) < MIN_SIDE_PITCHES) continue;
      const counts = keys.map(k => (r.cells[k] && r.cells[k].count) || 0);
      const tot = counts.reduce((s, c) => s + c, 0) || 1;
      qualifying.push({ rowIndex: r._i, date: r.date, vec: counts.map(c => (c / tot) * 100) });
    }
    return detectApproachShift(qualifying, keys);
  }, [dividerActive, mixRows, pitchCols]);

  // ---- Pitch Mix + pitch type: usage% (velo) per literal inning.
  const inningCols = useMemo(() => buildInningCols(allPitches), [allPitches]);
  const inningsByGame = useMemo(() => {
    if (glView !== "mix" || !glPitch) return null;
    const m = new Map();
    for (const [pk, arr] of handSliceByGame) m.set(pk, computeInningsCells(arr, glPitch));
    return m;
  }, [glView, glPitch, handSliceByGame]);
  const inningsTotal = useMemo(() => {
    if (glView !== "mix" || !glPitch) return null;
    return computeInningsCells(handSlice.filter(p => totalPks.has(String(p.game_pk))), glPitch);
  }, [glView, glPitch, handSlice, totalPks]);

  // ---- Results / Usage views: per-game rows from the hand+pitch slice.
  const resultsByGame = useMemo(() => {
    if (glView !== "results") return null;
    const m = new Map();
    for (const [pk, arr] of fullSliceByGame) m.set(pk, computeResultsRow(arr));
    return m;
  }, [glView, fullSliceByGame]);
  const resultsTotal = useMemo(
    () => glView === "results" ? computeResultsRow(fullSlice.filter(p => totalPks.has(String(p.game_pk)))) : null,
    [glView, fullSlice, totalPks]
  );
  const usageByGame = useMemo(() => {
    if (glView !== "usage") return null;
    const m = new Map();
    for (const [pk, arr] of fullSliceByGame) m.set(pk, computeUsageRow(arr));
    return m;
  }, [glView, fullSliceByGame]);
  const usageTotal = useMemo(
    () => glView === "usage" ? computeUsageRow(fullSlice.filter(p => totalPks.has(String(p.game_pk)))) : null,
    [glView, fullSlice, totalPks]
  );

  if (!sortedLog || sortedLog.length === 0) return null;

  const toggleSelectedGame = (row, index) => {
    const key = getGameKey(row, index);
    setSelectedGameKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleGameLogAuxClick = (e) => {
    // Middle-click: stop the auxclick from bubbling past the row, but do NOT
    // preventDefault — doing so also suppressed the date <a>'s native new-tab.
    if (e.button !== 1) return;
    e.stopPropagation();
  };

  const pitcherHand = data.info?.hand;

  // ===== Per-view right-block configs =====

  // Overview (no pitch): vs All reads the authoritative game_log row;
  // vs L/R reads the recomputed hand split. Formats match the original table.
  const overviewSrc = (row) => glHand === "all" ? row : (overviewSplitByGame?.get(String(row.game_pk)) || {});
  const renderOverviewCell = (row, i, c) => {
    const src = overviewSrc(row);
    switch (c.key) {
      case "whiffs": return src.whiffs != null ? src.whiffs : "—";
      case "swstr_pct": return src.swstr_pct != null ? Math.round(src.swstr_pct) + "%" : "—";
      case "csw_pct": return src.csw_pct != null ? Number(src.csw_pct).toFixed(1) + "%" : "—";
      case "strike_pct": return src.strike_pct != null ? Math.round(src.strike_pct) + "%" : "—";
      case "two_str_pct": return src.two_str_pct != null ? Math.round(src.two_str_pct) + "%" : "—";
      case "par_pct":
        if (glHand === "all") return row.two_strike_pas > 0 ? Math.round((row.ks / row.two_strike_pas) * 100) + "%" : "—";
        return src.par_pct != null ? Math.round(src.par_pct) + "%" : "—";
      case "pitches": return src.pitches != null ? src.pitches : "—";
      case "hrs": return src.hrs != null ? src.hrs : "—";
      default: return "—";
    }
  };
  const renderOverviewTotal = (c, rs) => {
    const g = rs.games || 0;
    const ip = (rs.ip_thirds || 0) / 3;
    const src = glHand === "all" ? rs : (overviewSplitTotal || {});
    switch (c.key) {
      case "whiffs": return <><span className="rate-label">Whf/G</span>{g > 0 ? ((src.whiffs || 0) / g).toFixed(1) : "—"}</>;
      case "swstr_pct": return <><span className="rate-label">SwStr%</span>{src.swstr_pct != null ? Math.round(src.swstr_pct) + "%" : "—"}</>;
      case "csw_pct": return <><span className="rate-label">CSW%</span>{src.csw_pct != null ? Math.round(src.csw_pct) + "%" : "—"}</>;
      case "strike_pct": return <><span className="rate-label">Strike%</span>{src.strike_pct != null ? Math.round(src.strike_pct) + "%" : "—"}</>;
      case "two_str_pct": return <><span className="rate-label">2Str%</span>{src.two_str_pct != null ? Math.round(src.two_str_pct) + "%" : "—"}</>;
      case "par_pct": return <><span className="rate-label">PAR%</span>{src.par_pct != null ? Math.round(src.par_pct) + "%" : "—"}</>;
      case "pitches": return <><span className="rate-label">PPG</span>{g > 0 ? Math.round((src.pitches || 0) / g) : "—"}</>;
      case "hrs": return <><span className="rate-label">HR/9</span>{ip > 0 ? (((src.hrs || 0) / ip) * 9).toFixed(2) : "—"}</>;
      default: return "—";
    }
  };

  // Overview + pitch: the Pitch Overview metrics with delta colors.
  const renderGlRight = (row, i, c) => renderGlCell(glRows[i] || {}, c.key, glPitch, pitcherHand, glBaseline);
  const renderGlTotalRight = (c) => (
    <><span className="rate-label">{c.label}</span>{renderGlCell(glTotal || {}, c.key, glPitch, pitcherHand, glBaseline)}</>
  );

  // Pitch Mix (no pitch) — raw columns.
  const mixRightCols = pitchCols.map(c => ({ key: c.name, label: `${c.code}%`, color: PITCH_COLORS[c.name] }));
  const renderMixCell = (row, i, c) => renderPitchMixCell(mixRows[i] && mixRows[i].cells[c.key]);
  const renderMixTotal = (c) => (
    <>
      <span className="rate-label" style={{ color: PITCH_COLORS[c.key] || undefined }}>{c.label}</span>
      {renderPitchMixCell(mixTotal && mixTotal[c.key])}
    </>
  );

  // Pitch Mix (no pitch) — distribution bar (single 100%-width column).
  const barCol = [{ key: "__mixbar__", label: "Pitch Mix  →  100%" }];
  const renderBarCell = (row, i) => {
    const seg = mixRows[i] ? buildMixBarSegments(mixRows[i].cells, pitchCols, getPitchColor) : null;
    return <PitchMixBar segments={seg && seg.segments} other={seg ? seg.other : 0} />;
  };
  const renderBarTotal = () => {
    const seg = buildMixBarSegments(mixTotal, pitchCols, getPitchColor);
    return <PitchMixBar segments={seg && seg.segments} other={seg ? seg.other : 0} />;
  };

  // GameLogTable display-mode hooks (each self-gates; no effect outside mix view).
  const fmtCpDate = (d) => {
    const p = (d || "").replace(/^\d{4}-/, "").split("-");
    return p.length === 2 ? `${parseInt(p[0], 10)}-${p[1]}` : d;
  };
  const mixCellAttrs = (row, i, c) => {
    if (barsActive) return { className: "gl-mixbar-cell" };
    if (heatActive) {
      const cell = mixRows[i] && mixRows[i].cells[c.key];
      const style = pitchMixHeatStyle(PITCH_COLORS[c.key], heatRanges && heatRanges[c.key], cell && cell.usage);
      return style ? { className: "gl-hm-cell", style } : null;
    }
    return null;
  };
  const renderApproachRow = (colSpan) => {
    const cp = approachShift;
    const movers = cp.movers.slice(0, 2).map((m, idx) => (
      <span key={m.key}>
        {idx > 0 && <span className="gl-cp-meta"> &nbsp;·&nbsp; </span>}
        <b style={{ color: getPitchColor(m.key) }}>{codeByName[m.key] || m.key}</b> {Math.round(m.from)}%→{Math.round(m.to)}% ({m.delta >= 0 ? "+" : ""}{Math.round(m.delta)})
      </span>
    ));
    return (
      <tr className="gl-cp-row">
        <td colSpan={colSpan}>
          <div className="gl-cpbar">
            <span className="gl-cp-dot" />
            <span className="gl-cp-lab">Approach shift · {fmtCpDate(cp.date)}</span>
            <span className="gl-cp-desc">mix moved <b>{Math.round(cp.tvd)}%</b> &nbsp;|&nbsp; {movers} &nbsp;<span className="gl-cp-meta">({cp.nBefore} vs {cp.nAfter} qualifying starts)</span></span>
          </div>
        </td>
      </tr>
    );
  };
  const mixRowDivider = (row, i, colSpan) =>
    (dividerActive && approachShift && approachShift.rowIndex === i) ? renderApproachRow(colSpan) : null;
  const mixDateBadge = (row, i) => {
    if (!dividerActive) return null;
    const n = (mixRows[i] && mixRows[i]._handTotal) || 0;
    return <span className={`gl-side-pill${n < MIN_SIDE_PITCHES ? " low" : ""}`}>{n} {side}</span>;
  };
  const mixRowClass = (row, i) =>
    (dividerActive && ((mixRows[i] && mixRows[i]._handTotal) || 0) < MIN_SIDE_PITCHES) ? "gl-excluded" : "";

  // Pitch Mix + pitch: innings columns.
  const inningsRightCols = inningCols.map(n => ({ key: String(n), label: String(n), color: PITCH_COLORS[glPitch] }));
  const renderInningsCell = (row, i, c) => {
    const cells = inningsByGame?.get(String(row.game_pk));
    return renderPitchMixCell(cells && cells[c.key]);
  };
  const renderInningsTotal = (c) => (
    <>
      <span className="rate-label" style={{ color: PITCH_COLORS[glPitch] || undefined }}>Inn {c.label}</span>
      {renderPitchMixCell(inningsTotal && inningsTotal[c.key])}
    </>
  );

  // Results view (slim left block).
  const formatResultsVal = (r, key) => {
    if (!r || !r.count) return "—";
    const v = r[key];
    if (v == null || v === "") return "—";
    return RESULTS_PCT_KEYS.has(key) ? `${v}%` : v;
  };
  const renderResultsCell = (row, i, c) => formatResultsVal(resultsByGame?.get(String(row.game_pk)), c.key);
  const renderResultsTotal = (c) => (
    <><span className="rate-label">{c.label}</span>{formatResultsVal(resultsTotal, c.key)}</>
  );

  // Usage view.
  const formatUsageVal = (r, key) => {
    if (!r || !r.count) return "—";
    const v = r[key];
    if (v == null) return "—";
    return key === "count" ? v : `${v}%`;
  };
  const renderUsageCell = (row, i, c) => formatUsageVal(usageByGame?.get(String(row.game_pk)), c.key);
  const renderUsageTotal = (c) => (
    <><span className="rate-label">{c.label}</span>{formatUsageVal(usageTotal, c.key)}</>
  );

  let slim = false;
  let rightCols, renderRightCell, renderTotalRightCell;
  if (glView === "overview" && glPitch) {
    rightCols = GL_PITCH_COLS;
    renderRightCell = renderGlRight;
    renderTotalRightCell = renderGlTotalRight;
  } else if (glView === "overview") {
    rightCols = OVERVIEW_COLS;
    renderRightCell = renderOverviewCell;
    renderTotalRightCell = renderOverviewTotal;
  } else if (glView === "mix" && glPitch) {
    rightCols = inningsRightCols;
    renderRightCell = renderInningsCell;
    renderTotalRightCell = renderInningsTotal;
  } else if (glView === "mix" && barsActive) {
    rightCols = barCol;
    renderRightCell = renderBarCell;
    renderTotalRightCell = renderBarTotal;
  } else if (glView === "mix") {
    rightCols = mixRightCols;
    renderRightCell = renderMixCell;
    renderTotalRightCell = renderMixTotal;
  } else if (glView === "results") {
    slim = true;
    rightCols = RESULTS_COLS;
    renderRightCell = renderResultsCell;
    renderTotalRightCell = renderResultsTotal;
  } else {
    rightCols = USAGE_COLS;
    renderRightCell = renderUsageCell;
    renderTotalRightCell = renderUsageTotal;
  }

  return (
    <div className={`card-gameline-box${className ? ` ${className}` : ""}`}>
      <div className="card-gameline-header">
        <span>Regular Season</span>
        <select className="game-filter-select" value={glView} onChange={e => setGlView(e.target.value)} style={{ marginLeft: 12 }}>
          <option value="overview">Overview</option>
          <option value="mix">Pitch Mix</option>
          <option value="results">Results</option>
          <option value="usage">Usage</option>
        </select>
        <select className="game-filter-select" value={glPitch ?? "all"} onChange={e => setGlPitch(e.target.value === "all" ? null : e.target.value)} style={{ marginLeft: 6 }}>
          <option value="all">All Pitches</option>
          {pitchCols.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
        <select className="game-filter-select" value={glHand} onChange={e => setGlHand(e.target.value)} style={{ marginLeft: 6 }}>
          <option value="all">vs All</option>
          <option value="L">vs LHB</option>
          <option value="R">vs RHB</option>
        </select>
        {mixView && (
          <>
            <select className="game-filter-select" value={cellMode} onChange={e => setCellMode(e.target.value)} style={{ marginLeft: 6 }} aria-label="Pitch-mix cell display">
              <option value="numbers">Raw columns</option>
              <option value="bars">Distribution bar</option>
            </select>
            <label
              className={`toggle-label gl-mode-toggle${barsActive ? " disabled" : ""}`}
              title={barsActive ? "Heatmap tints the raw-data columns — set Display to Raw columns." : "Tint each cell by where its value falls in that pitch's range."}
            >
              <input type="checkbox" checked={heatOn && !barsActive} disabled={barsActive} onChange={e => setHeatOn(e.target.checked)} />
              Heatmap
            </label>
            <label
              className={`toggle-label gl-mode-toggle${glHand === "all" ? " disabled" : ""}`}
              title={glHand === "all" ? "Approach shift is available on the vs LHB / vs RHB splits." : "Detect a significant usage-approach changepoint."}
            >
              <input type="checkbox" checked={dividerOn && glHand !== "all"} disabled={glHand === "all"} onChange={e => setDividerOn(e.target.checked)} />
              Approach shift
              {dividerActive && approachShift === null && <span className="gl-cp-none"> · no shift</span>}
            </label>
          </>
        )}
        {liveGame && <span style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 400, marginLeft: "auto" }}>* = Decision if the game ended now</span>}
      </div>
      {barsActive && (
        <div className="gl-mix-legend">
          {pitchCols.map(c => (
            <span className="gl-mix-leg-item" key={c.name}>
              <span className="gl-mix-leg-sw" style={{ background: getPitchColor(c.name) }} />
              {c.code} · {c.name}
            </span>
          ))}
        </div>
      )}
      <GameLogTable
        gameLog={sortedLog}
        totalLog={totalLog}
        liveGame={liveGame}
        slim={slim}
        rightCols={rightCols}
        renderRightCell={renderRightCell}
        renderTotalRightCell={renderTotalRightCell}
        pitcherId={pitcherId}
        displayAbbrev={displayAbbrev}
        buildCardHref={buildCardHref}
        onGameClick={onGameClick}
        onToggleSelect={toggleSelectedGame}
        onAuxClick={handleGameLogAuxClick}
        hasGameSelection={hasGameSelection}
        selectedGameKeys={selectedGameKeys}
        rightCellAttrs={(heatActive || barsActive) ? mixCellAttrs : undefined}
        renderRowDivider={dividerActive ? mixRowDivider : undefined}
        renderDateBadge={dividerActive ? mixDateBadge : undefined}
        getRowClassName={dividerActive ? mixRowClass : undefined}
      />
    </div>
  );
}
