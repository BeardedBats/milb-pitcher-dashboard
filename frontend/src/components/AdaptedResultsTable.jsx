import React, { useMemo } from "react";

// Box-score-only results table for levels without Statcast (AA, A+, A, R) and
// for AFL games Savant never tracked. Every value comes straight off the box
// score — the only derived figures are Str% (strikes/pitches) and GO/AO
// (groundOuts/airOuts), both computed server-side in boxscore_levels.py.
//
// Deliberately NOT a variant of PitcherResultsTable: that table is built around
// Statcast columns (CSW%, whiffs, velo deltas) that simply do not exist below
// AAA, and threading "hide half the columns" through it would make both harder
// to read.
// These levels have no Statcast — no velocity, pitch type or movement. But the
// MLB live feed still records every pitch's CALL and every ball in play's
// trajectory, so plate-discipline and batted-ball metrics ARE available and are
// derived server-side in boxscore_levels._derive_pitch_metrics.
//
// Batted-ball rates are over all balls in play; GO/AO is the box score's
// outs-only ratio. Different denominators, both shown.
export const ADAPTED_COLUMNS = [
  { key: "date", label: "Date" },
  { key: "pitcher", label: "Pitcher" },
  { key: "team", label: "Team" },
  { key: "opponent", label: "Opp" },
  { key: "decision", label: "Dec" },
  { key: "ip", label: "IP" },
  { key: "hits", label: "H" },
  { key: "runs", label: "R" },
  { key: "er", label: "ER" },
  { key: "bbs", label: "BB" },
  { key: "ks", label: "K" },
  { key: "hrs", label: "HR" },
  { key: "batters_faced", label: "BF" },
  { key: "pitches", label: "P" },
  { key: "whiffs", label: "Whiffs", title: "Swinging strikes (incl. foul tips)" },
  { key: "swstr_pct", label: "SwStr%", title: "Whiffs / pitches" },
  { key: "csw_pct", label: "CSW%", title: "(Called strikes + whiffs) / pitches" },
  { key: "strike_pct", label: "Str%" },
  { key: "gb_pct", label: "GB%", title: "Ground balls / balls in play" },
  { key: "fb_pct", label: "FB%", title: "Fly balls / balls in play" },
  { key: "ld_pct", label: "LD%", title: "Line drives / balls in play" },
  { key: "hard_pct", label: "Hard%", title: "Hard-hit / balls in play" },
  { key: "go_ao", label: "GO/AO", title: "Ground outs / air outs (outs only)" },
];

const PCT_KEYS = new Set([
  "strike_pct", "swstr_pct", "csw_pct", "gb_pct", "fb_pct", "ld_pct", "hard_pct",
]);

const NUMERIC_KEYS = new Set([
  "hits", "runs", "er", "bbs", "ks", "hrs", "batters_faced", "pitches",
  "whiffs", "strike_pct", "swstr_pct", "csw_pct",
  "gb_pct", "fb_pct", "ld_pct", "hard_pct", "go_ao",
]);

function ipToNumeric(ip) {
  if (ip == null) return 0;
  const [whole, thirds] = String(ip).split(".");
  return (parseInt(whole, 10) || 0) + (parseInt(thirds, 10) || 0) / 3;
}

function formatCell(row, key) {
  const v = row[key];
  if (v == null || v === "") return "—";
  if (PCT_KEYS.has(key)) return `${v}%`;
  if (key === "go_ao") return Number(v).toFixed(2);
  return v;
}

export default function AdaptedResultsTable({
  data,
  level,
  onPitcherClick,
  spOnly,
  rpOnly,
  sortKey,
  onSortKeyChange,
  sortDir,
  onSortDirChange,
  onSortedRowsChange,
}) {
  const handleSort = (key) => {
    if (sortKey === key) onSortDirChange(sortDir === "asc" ? "desc" : "asc");
    else { onSortKeyChange(key); onSortDirChange("desc"); }
  };

  const filtered = useMemo(() => {
    let rows = data || [];
    // Same contract as PitcherResultsTable: role is set server-side.
    if (spOnly) rows = rows.filter(r => r.role === "SP");
    else if (rpOnly) rows = rows.filter(r => r.role === "RP");
    return rows;
  }, [data, spOnly, rpOnly]);

  const sorted = useMemo(() => {
    const rows = [...filtered];
    if (!sortKey) {
      // Default: team (by full affiliate name), then order of appearance.
      return rows.sort((a, b) => {
        const at = a.team_name || a.team || "";
        const bt = b.team_name || b.team || "";
        if (at !== bt) return at.localeCompare(bt);
        return (a.appearance_order || 0) - (b.appearance_order || 0);
      });
    }
    return rows.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (av == null) return 1;
      if (bv == null) return -1;
      if (sortKey === "ip") { av = ipToNumeric(av); bv = ipToNumeric(bv); }
      // Sort the team column by full affiliate name, not abbreviation.
      if (sortKey === "team") { av = a.team_name || av; bv = b.team_name || bv; }
      if (NUMERIC_KEYS.has(sortKey) || sortKey === "ip") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
  }, [filtered, sortKey, sortDir]);

  React.useEffect(() => {
    if (onSortedRowsChange) onSortedRowsChange(sorted);
  }, [onSortedRowsChange, sorted]);

  if (!sorted.length) {
    return <div className="no-data">No pitchers found for this date at {level}.</div>;
  }

  return (
    <table className="data-table adapted-results-table">
      <thead>
        <tr>
          {ADAPTED_COLUMNS.map(c => (
            <th
              key={c.key}
              onClick={() => handleSort(c.key)}
              className={sortKey === c.key ? "sorted" : ""}
              style={{ cursor: "pointer" }}
              title={c.title || undefined}
            >
              {c.label}{sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map(row => (
          <tr key={`${row.game_pk}-${row.pitcher_id}`}>
            {ADAPTED_COLUMNS.map(c => {
              if (c.key === "date") {
                // Date + level tag, per spec.
                return (
                  <td key={c.key} className="adapted-date-cell">
                    {row.date}
                    <span className="level-tag">{row.level}</span>
                  </td>
                );
              }
              if (c.key === "pitcher") {
                return (
                  <td key={c.key}>
                    {onPitcherClick ? (
                      <span
                        className="pitcher-link"
                        role="button"
                        tabIndex={0}
                        onClick={(e) => onPitcherClick(row.pitcher_id, e)}
                      >
                        {row.pitcher}
                      </span>
                    ) : row.pitcher}
                  </td>
                );
              }
              if (c.key === "team") {
                return (
                  <td key={c.key} title={row.team_display || ""}>
                    {row.team}
                    {row.org && <span className="org-tag">{row.org}</span>}
                  </td>
                );
              }
              if (c.key === "opponent") {
                return <td key={c.key}>{row.home ? "" : "@ "}{row.opponent}</td>;
              }
              return <td key={c.key}>{formatCell(row, c.key)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
