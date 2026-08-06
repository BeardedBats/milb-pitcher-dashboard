import React, { useMemo } from "react";

// Results table for the levels without Statcast (AA, A+, A, R) and for AFL
// games Savant never tracked.
//
// Those levels have no velocity, pitch type or movement — but the MLB live feed
// still records every pitch's CALL, COUNT, batter HANDEDNESS and plate
// LOCATION, and every ball in play's trajectory, hardness and fielder. So
// plate-discipline, count, zone, batted-ball and contact-quality metrics are
// all real here, derived server-side in boxscore_levels._derive_pitch_metrics.
//
// Deliberately NOT a variant of PitcherResultsTable: that one is built around
// Statcast columns (velo deltas, movement) that genuinely don't exist below
// AAA, and threading "hide half the columns" through it would hurt both.
//
// Note GB% and GO/AO have different denominators: GB% is over all balls in
// play, GO/AO is the box score's outs-only ratio. Both are shown on purpose.

export const ADAPTED_COLUMNS = [
  { key: "date", label: "Date", group: "Box score" },
  { key: "pitcher", label: "Pitcher", group: "Box score" },
  { key: "team", label: "Team", group: "Box score" },
  { key: "opponent", label: "Opp", group: "Box score" },
  { key: "decision", label: "Dec", group: "Box score" },
  { key: "ip", label: "IP", group: "Box score" },
  { key: "hits", label: "H", group: "Box score" },
  { key: "runs", label: "R", group: "Box score" },
  { key: "er", label: "ER", group: "Box score" },
  { key: "bbs", label: "BB", group: "Box score" },
  { key: "ks", label: "K", group: "Box score" },
  { key: "hrs", label: "HR", group: "Box score" },
  { key: "batters_faced", label: "BF", group: "Box score" },
  { key: "pitches", label: "P", group: "Box score" },

  { key: "whiffs", label: "Whiffs", group: "Plate discipline", title: "Swinging strikes (incl. foul tips)" },
  { key: "swstr_pct", label: "SwStr%", group: "Plate discipline", title: "Whiffs / pitches" },
  { key: "csw_pct", label: "CSW%", group: "Plate discipline", title: "(Called strikes + whiffs) / pitches" },
  { key: "strike_pct", label: "Str%", group: "Plate discipline" },
  { key: "whiff_pct", label: "Whiff%", group: "Plate discipline", off: true, title: "Whiffs / swings" },
  { key: "swing_pct", label: "Swing%", group: "Plate discipline", off: true, title: "Swings / pitches" },
  { key: "contact_pct", label: "Contact%", group: "Plate discipline", off: true, title: "Contact / swings" },

  { key: "f_strike_pct", label: "F-Str%", group: "Count", off: true, title: "First-pitch strikes / plate appearances" },
  { key: "two_str_pct", label: "2Str%", group: "Count", off: true, title: "Pitches thrown in two-strike counts / pitches" },
  { key: "par_pct", label: "PAR%", group: "Count", off: true, title: "Strikeouts / plate appearances that reached two strikes" },

  { key: "zone_pct", label: "Zone%", group: "Zone", off: true, title: "In-zone pitches / pitches (location calibrated from Gameday coordinates)" },
  { key: "o_swing_pct", label: "O-Swing%", group: "Zone", off: true, title: "Swings at out-of-zone pitches / out-of-zone pitches" },
  { key: "z_swing_pct", label: "Z-Swing%", group: "Zone", off: true, title: "Swings at in-zone pitches / in-zone pitches" },
  { key: "z_contact_pct", label: "Z-Con%", group: "Zone", off: true, title: "Contact on in-zone swings" },
  { key: "o_contact_pct", label: "O-Con%", group: "Zone", off: true, title: "Contact on out-of-zone swings" },

  { key: "gb_pct", label: "GB%", group: "Batted ball", title: "Ground balls / balls in play" },
  { key: "fb_pct", label: "FB%", group: "Batted ball", title: "Fly balls / balls in play" },
  { key: "ld_pct", label: "LD%", group: "Batted ball", title: "Line drives / balls in play" },
  { key: "pu_pct", label: "PU%", group: "Batted ball", off: true, title: "Popups / balls in play" },
  { key: "gb_fb_ratio", label: "GB/FB", group: "Batted ball", off: true },
  { key: "go_ao", label: "GO/AO", group: "Batted ball", title: "Ground outs / air outs (outs only — a different denominator to GB%)" },

  { key: "hard_pct", label: "Hard%", group: "Contact quality", title: "Hard-hit / balls in play" },
  { key: "med_pct", label: "Med%", group: "Contact quality", off: true },
  { key: "soft_pct", label: "Soft%", group: "Contact quality", off: true },
  { key: "pull_pct", label: "Pull%", group: "Contact quality", off: true, title: "Pulled balls in play (fielder position, flipped for handedness)" },
  { key: "center_pct", label: "Cent%", group: "Contact quality", off: true },
  { key: "oppo_pct", label: "Oppo%", group: "Contact quality", off: true },
];

export const ADAPTED_DEFAULT_HIDDEN = ADAPTED_COLUMNS.filter(c => c.off).map(c => c.key);

const PCT_KEYS = new Set([
  "strike_pct", "swstr_pct", "csw_pct", "whiff_pct", "swing_pct", "contact_pct",
  "f_strike_pct", "two_str_pct", "par_pct",
  "zone_pct", "o_swing_pct", "z_swing_pct", "z_contact_pct", "o_contact_pct",
  "gb_pct", "fb_pct", "ld_pct", "pu_pct",
  "hard_pct", "med_pct", "soft_pct", "pull_pct", "center_pct", "oppo_pct",
]);

const NUMERIC_KEYS = new Set([
  "hits", "runs", "er", "bbs", "ks", "hrs", "batters_faced", "pitches",
  "whiffs", "go_ao", "gb_fb_ratio", ...PCT_KEYS,
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
  hiddenCols = [],
}) {
  const cols = useMemo(
    () => ADAPTED_COLUMNS.filter(c => !hiddenCols.includes(c.key)),
    [hiddenCols],
  );
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
          {cols.map(c => (
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
            {cols.map(c => {
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
