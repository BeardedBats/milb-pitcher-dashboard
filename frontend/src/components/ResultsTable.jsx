import React, { useMemo } from "react";
import { getPitchColor, CARD_RESULTS_COLUMNS } from "../constants";
import { computeResultsRow } from "../utils/gameLogStats";

/**
 * Results tab table: per-pitch-type aggregate results.
 * Computes Zone%, O-Swing%, Whiffs, CS, CSW%, Strike%, Fouls, BBs, Ks, BIP, Hits, Outs, HRs, Weak%, Hard%
 * The per-pitch classification lives in utils/gameLogStats (computeResultsRow),
 * shared with the Regular Season game log's Results view.
 *
 * Props:
 *  - pitches: raw pitch-level data array
 *  - batterFilter: "all" | "L" | "R"
 *  - gameFilter: "all" | game_pk string
 *  - isMobile: boolean for mobile responsive design
 */
export default function ResultsTable({ pitches, batterFilter, gameFilter, isMobile, selectedPitchTypes, onPitchTypeClick, onClearSelection }) {
  const hasSelection = selectedPitchTypes && selectedPitchTypes.size > 0;

  const filtered = useMemo(() => {
    let fp = pitches || [];
    if (gameFilter && gameFilter !== "all") {
      fp = fp.filter(p => String(p.game_pk) === String(gameFilter));
    }
    if (batterFilter === "L") fp = fp.filter(p => p.stand === "L");
    else if (batterFilter === "R") fp = fp.filter(p => p.stand === "R");
    return fp;
  }, [pitches, batterFilter, gameFilter]);

  const resultData = useMemo(() => {
    if (filtered.length === 0) return [];
    // Group by pitch_name
    const groups = {};
    for (const p of filtered) {
      const name = p.pitch_name;
      if (!name) continue;
      if (!groups[name]) groups[name] = [];
      groups[name].push(p);
    }
    const rows = Object.entries(groups).map(([pitchName, pitchArr]) => ({
      pitch_name: pitchName,
      ...computeResultsRow(pitchArr),
    }));
    // Sort by count descending
    rows.sort((a, b) => b.count - a.count);
    return rows;
  }, [filtered]);

  // Totals row — re-aggregated from raw pitches (not from rounded rows)
  const totals = useMemo(() => {
    if (resultData.length === 0) return null;
    const fp = hasSelection ? filtered.filter(p => selectedPitchTypes.has(p.pitch_name)) : filtered;
    return { pitch_name: "Total", ...computeResultsRow(fp) };
  }, [filtered, resultData, hasSelection, selectedPitchTypes]);

  if (resultData.length === 0) return <div className="no-data">No result data available.</div>;

  const cols = CARD_RESULTS_COLUMNS;
  const pctKeys = new Set(["zone_pct", "o_swing_pct", "csw_pct", "strike_pct", "foul_pct", "gb_pct", "fb_pct", "weak_pct", "hard_pct"]);

  const renderCell = (row, col, isTotal) => {
    const v = row[col.key];
    if (col.key === "pitch_name") {
      if (isTotal) return <span className="pp-total-label">{v}</span>;
      const c = getPitchColor(v);
      return <span style={{ color: c, fontWeight: 600 }}>{v}</span>;
    }
    if (v == null || v === "") return <span style={{ color: "rgb(180, 185, 219)" }}>—</span>;
    if (pctKeys.has(col.key)) return `${v}%`;
    return v;
  };

  return (
    <table style={{ width: "100%", fontVariantNumeric: "tabular-nums" }}>
      <thead>
        <tr>
          {cols.map((c, i) => (
            <th key={c.key}
                className={`${c.dividerRight ? "col-divider-right" : ""}${isMobile && i === 0 ? " mobile-sticky-col" : ""}`}
                style={{
                  textAlign: c.align || "right",
                  ...(isMobile && i === 0 ? {
                    position: "sticky",
                    left: 0,
                    zIndex: 2,
                    background: "var(--surface2)",
                    minWidth: 80
                  } : {})
                }}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {resultData.map((r, i) => {
          const isDimmedRow = hasSelection && !selectedPitchTypes.has(r.pitch_name);
          return (
          <tr key={i}
              className={onPitchTypeClick ? "clickable-row" : ""}
              style={isDimmedRow ? { opacity: 0.4 } : undefined}
              onClick={() => onPitchTypeClick && r.pitch_name && onPitchTypeClick(r.pitch_name)}>
            {cols.map((c, colIdx) => (
              <td key={c.key}
                  className={`${c.dividerRight ? "col-divider-right" : ""}${isMobile && colIdx === 0 ? " mobile-sticky-col" : ""}`}
                  style={{
                    textAlign: c.align || "right",
                    ...(isMobile && colIdx === 0 ? {
                      position: "sticky",
                      left: 0,
                      zIndex: 3,
                      background: "var(--surface2)",
                      minWidth: 80
                    } : {})
                  }}>
                {renderCell(r, c, false)}
              </td>
            ))}
          </tr>
          );
        })}
        {totals && (
          <tr className="pp-total-row" style={{ ...(isMobile ? { position: "sticky", bottom: 0, zIndex: 2 } : {}), cursor: hasSelection && onClearSelection ? "pointer" : undefined }} onClick={() => hasSelection && onClearSelection && onClearSelection()}>
            {cols.map((c, colIdx) => (
              <td key={c.key}
                  className={`${c.dividerRight ? "col-divider-right" : ""}${isMobile && colIdx === 0 ? " mobile-sticky-col" : ""}`}
                  style={{
                    textAlign: c.align || "right",
                    ...(isMobile && colIdx === 0 ? {
                      position: "sticky",
                      left: 0,
                      zIndex: 4,
                      background: "#363957",
                      minWidth: 80
                    } : {})
                  }}>
                {renderCell(totals, c, true)}
              </td>
            ))}
          </tr>
        )}
      </tbody>
    </table>
  );
}
