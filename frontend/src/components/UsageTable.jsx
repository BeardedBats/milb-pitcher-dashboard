import React, { useMemo } from "react";
import { getPitchColor, CARD_USAGE_COLUMNS } from "../constants";
import { roundPercentParts } from "../utils/formatting";
import { bucketFor } from "../utils/gameLogStats";

/**
 * Usage tab: per-pitch-type usage rates across count buckets, split by batter hand,
 * plus combined pitch-type PAR%.
 *
 * Count buckets (bucketed by balls-strikes BEFORE the pitch was thrown):
 *   0-0:         (0,0)
 *   Early:       (0,1), (1,0), (1,1)
 *   Behind:      (2,0), (2,1), (3,0), (3,1)
 *   Two-Strikes: (0,2), (1,2), (2,2), (3,2)
 *
 * Bucket columns = % of pitches of this pitch type to the same hand that were
 * thrown in that bucket (each pitch-type row sums to ~100% within the LHB and
 * RHB blocks).
 * PAR% (combined across hands) = Ks on this pitch type / pitches of this type thrown in a 2-strike count.
 *
 * The batter-hand filter is intentionally ignored on this tab — both LHB and RHB
 * are always rendered side-by-side.
 */

function emptyTypeRec() {
  return {
    count: 0,
    l: { count: 0, firstpitch: 0, early: 0, behind: 0, two_str: 0, two_str_ks: 0 },
    r: { count: 0, firstpitch: 0, early: 0, behind: 0, two_str: 0, two_str_ks: 0 },
    two_str_all: 0,
    two_str_ks_all: 0,
  };
}

export default function UsageTable({ pitches, gameFilter, isMobile, selectedPitchTypes, onPitchTypeClick, onClearSelection }) {
  const hasSelection = selectedPitchTypes && selectedPitchTypes.size > 0;
  const { rows, totals } = useMemo(() => {
    if (!pitches || pitches.length === 0) return { rows: [], totals: null };

    let fp = pitches;
    if (gameFilter && gameFilter !== "all") {
      fp = fp.filter(p => String(p.game_pk) === String(gameFilter));
    }

    const byType = new Map();

    for (const p of fp) {
      const name = p.pitch_name;
      if (!name) continue;
      const b = bucketFor(p.balls, p.strikes);
      const stand = p.stand === "L" ? "l" : p.stand === "R" ? "r" : null;
      let rec = byType.get(name);
      if (!rec) { rec = emptyTypeRec(); byType.set(name, rec); }
      rec.count++;
      if (stand) {
        rec[stand].count++;
        if (b) {
          rec[stand][b]++;
        }
      }
      // PAR% — for each pitch type, count pitches in 2-strike counts and Ks
      // recorded on them. Tracked both combined and split by batter hand.
      if (b === "two_str") {
        const ev = (p.events || "").toLowerCase();
        const isK = ev === "strikeout" || ev === "strikeout_double_play";
        rec.two_str_all++;
        if (isK) rec.two_str_ks_all++;
        if (stand === "l" && isK) rec.l.two_str_ks++;
        else if (stand === "r" && isK) rec.r.two_str_ks++;
      }
    }

    const rows = [];
    for (const [name, r] of byType.entries()) {
      const [firstPitchL, earlyL, behindL, twoStrL] = roundPercentParts(
        [r.l.firstpitch, r.l.early, r.l.behind, r.l.two_str],
        r.l.count
      );
      const [firstPitchR, earlyR, behindR, twoStrR] = roundPercentParts(
        [r.r.firstpitch, r.r.early, r.r.behind, r.r.two_str],
        r.r.count
      );
      rows.push({
        pitch_name: name,
        count: r.count,
        par_pct: r.two_str_all > 0 ? Math.round((r.two_str_ks_all / r.two_str_all) * 100) : null,
        // LHB
        firstpitch_pct_l: firstPitchL,
        early_pct_l: earlyL,
        behind_pct_l: behindL,
        two_str_use_pct_l: twoStrL,
        par_pct_vs_l: r.l.two_str > 0 ? Math.round((r.l.two_str_ks / r.l.two_str) * 100) : null,
        // RHB
        firstpitch_pct_r: firstPitchR,
        early_pct_r: earlyR,
        behind_pct_r: behindR,
        two_str_use_pct_r: twoStrR,
        par_pct_vs_r: r.r.two_str > 0 ? Math.round((r.r.two_str_ks / r.r.two_str) * 100) : null,
        _count: r.count,
      });
    }
    rows.sort((a, b) => b._count - a._count);

    const inSelection = (name) => !hasSelection || selectedPitchTypes.has(name);
    const sumBy = (fn) => rows.reduce((s, row) => {
      if (!inSelection(row.pitch_name)) return s;
      const rec = byType.get(row.pitch_name);
      return s + (rec ? fn(rec) : 0);
    }, 0);
    const totalTwoStrAll = sumBy(rec => rec.two_str_all);
    const totalKsTwoStrAll = sumBy(rec => rec.two_str_ks_all);
    const totalTwoStrL = sumBy(rec => rec.l.two_str);
    const totalKsTwoStrL = sumBy(rec => rec.l.two_str_ks);
    const totalTwoStrR = sumBy(rec => rec.r.two_str);
    const totalKsTwoStrR = sumBy(rec => rec.r.two_str_ks);
    const totalL = sumBy(rec => rec.l.count);
    const totalR = sumBy(rec => rec.r.count);
    const totalFirstPitchL = sumBy(rec => rec.l.firstpitch);
    const totalEarlyL = sumBy(rec => rec.l.early);
    const totalBehindL = sumBy(rec => rec.l.behind);
    const totalFirstPitchR = sumBy(rec => rec.r.firstpitch);
    const totalEarlyR = sumBy(rec => rec.r.early);
    const totalBehindR = sumBy(rec => rec.r.behind);
    const [firstPitchTotalL, earlyTotalL, behindTotalL, twoStrTotalL] = roundPercentParts(
      [totalFirstPitchL, totalEarlyL, totalBehindL, totalTwoStrL],
      totalL
    );
    const [firstPitchTotalR, earlyTotalR, behindTotalR, twoStrTotalR] = roundPercentParts(
      [totalFirstPitchR, totalEarlyR, totalBehindR, totalTwoStrR],
      totalR
    );

    const totals = {
      pitch_name: "Total",
      count: rows.reduce((s, r) => inSelection(r.pitch_name) ? s + r.count : s, 0),
      par_pct: totalTwoStrAll > 0 ? Math.round((totalKsTwoStrAll / totalTwoStrAll) * 100) : null,
      firstpitch_pct_l: firstPitchTotalL,
      early_pct_l: earlyTotalL,
      behind_pct_l: behindTotalL,
      two_str_use_pct_l: twoStrTotalL,
      par_pct_vs_l: totalTwoStrL > 0 ? Math.round((totalKsTwoStrL / totalTwoStrL) * 100) : null,
      firstpitch_pct_r: firstPitchTotalR,
      early_pct_r: earlyTotalR,
      behind_pct_r: behindTotalR,
      two_str_use_pct_r: twoStrTotalR,
      par_pct_vs_r: totalTwoStrR > 0 ? Math.round((totalKsTwoStrR / totalTwoStrR) * 100) : null,
    };

    return { rows, totals };
  }, [pitches, gameFilter, hasSelection, selectedPitchTypes]);

  if (rows.length === 0) return <div className="no-data">No usage data available.</div>;

  const cols = CARD_USAGE_COLUMNS;
  const pctKeys = new Set([
    "firstpitch_pct_l", "early_pct_l", "behind_pct_l", "two_str_use_pct_l",
    "firstpitch_pct_r", "early_pct_r", "behind_pct_r", "two_str_use_pct_r",
    "par_pct", "par_pct_vs_l", "par_pct_vs_r",
  ]);
  // Build group header row: collapse adjacent cols with the same `group` into a colspan.
  const groupHeaderCells = [];
  let i = 0;
  while (i < cols.length) {
    const g = cols[i].group;
    if (!g) {
      groupHeaderCells.push({ label: "", span: 1, key: cols[i].key, dividerRight: cols[i].dividerRight });
      i++;
    } else {
      let span = 1;
      let lastDivider = cols[i].dividerRight;
      while (i + span < cols.length && cols[i + span].group === g) {
        lastDivider = cols[i + span].dividerRight;
        span++;
      }
      groupHeaderCells.push({
        label: g === "lhb" ? "vs. LHB" : g === "rhb" ? "vs. RHB" : "",
        span,
        key: g,
        dividerRight: lastDivider,
        isGroup: true,
      });
      i += span;
    }
  }

  const renderCell = (row, col, isTotal) => {
    const v = row[col.key];
    if (col.key === "pitch_name") {
      if (isTotal) return <span className="pp-total-label">{v}</span>;
      const c = getPitchColor(v);
      return <span style={{ color: c, fontWeight: 600 }}>{v}</span>;
    }
    if (v == null || v === "") return <span style={{ color: "rgb(180, 185, 219)" }}>—</span>;
    if (pctKeys.has(col.key)) {
      if (v === 0) return <span style={{ color: "var(--text-dim, #8A8EB0)" }}>0%</span>;
      return `${v}%`;
    }
    return v;
  };

  return (
    <table style={{ width: "100%", fontVariantNumeric: "tabular-nums" }}>
      <thead>
        {/* Group header row — "vs. LHB" / "vs. RHB" labels above their column blocks */}
        <tr>
          {groupHeaderCells.map((h, idx) => (
            <th key={idx}
                colSpan={h.span}
                className={h.dividerRight ? "col-divider-right" : ""}
                style={{
                  textAlign: "center",
                  fontSize: h.isGroup ? 14 : 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  color: h.isGroup ? "var(--label)" : "transparent",
                  fontWeight: h.isGroup ? 600 : 400,
                  paddingTop: h.isGroup ? 12 : 2,
                  paddingBottom: h.isGroup ? 10 : 2,
                  verticalAlign: "middle",
                  borderBottom: "none",
                }}>
              {h.label || "\u00a0"}
            </th>
          ))}
        </tr>
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
        {rows.map((r, i) => {
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
