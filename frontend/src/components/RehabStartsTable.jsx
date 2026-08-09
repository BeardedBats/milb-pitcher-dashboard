import React, { useMemo } from "react";

// MLB pitchers on an injured list who have made a minor-league START recently.
// Every pitcher here has big-league service by construction, so every name gets
// the Changeup-green mlb-exp tint (when the header's MLB Green toggle is on).
//
// Column order is the reading order of the view: WHEN the start happened, WHO
// made it, then the line, then the pitch-level rates. Default sort is date,
// most recent first.
export const REHAB_COLUMNS = [
  { key: "date", label: "Date" },
  { key: "pitcher", label: "Pitcher" },
  { key: "team", label: "Team" },
  { key: "opponent", label: "Opp" },
  { key: "ip", label: "IP" },
  { key: "hits", label: "H" },
  { key: "runs", label: "R" },
  { key: "er", label: "ER" },
  { key: "bbs", label: "BB" },
  { key: "ks", label: "K" },
  { key: "hrs", label: "HR" },
  { key: "pitches", label: "P" },
  { key: "swstr_pct", label: "SwStr%" },
  { key: "csw_pct", label: "CSW%" },
  { key: "strike_pct", label: "Str%" },
  { key: "avg_velo", label: "Velo", title: "Average velocity — pitch-tracked levels only" },
  { key: "rehab_starts", label: "Rehab GS", title: "Starts made in this window" },
  { key: "il_status", label: "IL Status" },
];

// Team is opt-in (the level tag next to the date already answers "where"), and
// the opponent is rarely what the reader is here for.
export const REHAB_DEFAULT_HIDDEN = ["team", "opponent"];

const PCT_KEYS = new Set(["strike_pct", "csw_pct", "swstr_pct"]);
const NUMERIC_KEYS = new Set([
  "hits", "runs", "er", "bbs", "ks", "hrs", "pitches", "rehab_starts", "avg_velo",
  ...PCT_KEYS,
]);

function ipToNumeric(ip) {
  if (ip == null) return 0;
  const [whole, thirds] = String(ip).split(".");
  return (parseInt(whole, 10) || 0) + (parseInt(thirds, 10) || 0) / 3;
}

// "2026-08-06" -> "08-06". The full ISO date stays on the row for sorting and
// for the cell's title attribute.
function monthDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[2]}-${m[3]}` : (iso || "—");
}

export default function RehabStartsTable({
  data,
  onPitcherClick,
  hiddenCols = REHAB_DEFAULT_HIDDEN,
  sortKey = "date",
  onSortKeyChange,
  sortDir = "desc",
  onSortDirChange,
}) {
  const rows = data?.pitchers || [];
  const columns = useMemo(
    () => REHAB_COLUMNS.filter(c => !hiddenCols.includes(c.key)),
    [hiddenCols],
  );

  const handleSort = (key) => {
    if (sortKey === key) onSortDirChange?.(sortDir === "asc" ? "desc" : "asc");
    else { onSortKeyChange?.(key); onSortDirChange?.("desc"); }
  };

  const sorted = useMemo(() => {
    const out = [...rows];
    return out.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      // Affiliates sort by full name, never by abbreviation.
      if (sortKey === "team") { av = a.team_display || a.team; bv = b.team_display || b.team; }
      if (av == null) return 1;
      if (bv == null) return -1;
      if (sortKey === "ip") { av = ipToNumeric(av); bv = ipToNumeric(bv); }
      if (NUMERIC_KEYS.has(sortKey) || sortKey === "ip") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
  }, [rows, sortKey, sortDir]);

  if (!rows.length) {
    return (
      <div className="rehab-empty">
        No MLB pitchers on the IL have made a minor-league start
        {data?.start_date ? ` since ${data.start_date}` : " recently"}.
      </div>
    );
  }

  const fmt = (row, key) => {
    const v = row[key];
    if (v == null || v === "") return "—";
    // Rates read as whole numbers here — a tenth of a percent on 80 pitches is
    // noise, and the extra digit only makes the row harder to scan.
    if (PCT_KEYS.has(key)) return `${Math.round(v)}%`;
    if (key === "avg_velo") return Number(v).toFixed(1);
    return v;
  };

  // A zero is real data, but it should never pull the eye the way a count does.
  const isZero = (row, key) => {
    const v = row[key];
    if (v == null || v === "") return false;
    if (key === "ip") return ipToNumeric(v) === 0;
    return NUMERIC_KEYS.has(key) && Number(v) === 0;
  };

  return (
    <table className="data-table rehab-starts-table">
      <thead>
        <tr>
          {columns.map(c => (
            <th
              key={c.key}
              onClick={() => handleSort(c.key)}
              className={sortKey === c.key ? "sorted" : ""}
              style={{ cursor: "pointer", whiteSpace: "nowrap" }}
              title={c.title || undefined}
            >
              {c.label}{sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map(row => (
          <tr key={`${row.pitcher_id}-${row.game_pk}`}>
            {columns.map(c => {
              if (c.key === "date") {
                return (
                  <td key={c.key} className="rehab-date-cell" title={row.date || undefined}>
                    {monthDay(row.date)}
                    <span className="level-tag">{row.level}</span>
                  </td>
                );
              }
              if (c.key === "pitcher") {
                return (
                  <td key={c.key}>
                    {onPitcherClick ? (
                      <span
                        className="pitcher-link rehab-pitcher mlb-exp"
                        role="button"
                        tabIndex={0}
                        onClick={(e) => onPitcherClick(row.pitcher_id, e)}
                      >
                        {row.pitcher}
                      </span>
                    ) : <span className="rehab-pitcher mlb-exp">{row.pitcher}</span>}
                  </td>
                );
              }
              if (c.key === "team") {
                return (
                  <td key={c.key} title={row.team_display || row.team_name || undefined}>
                    {row.team || "—"}
                  </td>
                );
              }
              if (c.key === "opponent") {
                return <td key={c.key}>{row.home ? "" : "@ "}{row.opponent || "—"}</td>;
              }
              if (c.key === "il_status") {
                return (
                  <td key={c.key}>
                    <span className="rehab-il-tag">{row.il_status || row.il_status_code || "IL"}</span>
                  </td>
                );
              }
              return (
                <td key={c.key} className={isZero(row, c.key) ? "zero-cell" : undefined}>
                  {fmt(row, c.key)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
