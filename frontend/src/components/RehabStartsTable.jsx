import React, { useMemo } from "react";

// MLB pitchers on an injured list who have made a minor-league START recently.
// Every pitcher here has big-league service by construction, so every name gets
// the Changeup-green mlb-exp tint.
//
// Per spec the first two columns are Pitcher Name and Date (Level), default
// sorted by date (most recent first).
const COLUMNS = [
  { key: "pitcher", label: "Pitcher" },
  { key: "date", label: "Date (Level)" },
  { key: "team_display", label: "Affiliate" },
  { key: "opponent", label: "Opp" },
  { key: "ip", label: "IP" },
  { key: "hits", label: "H" },
  { key: "runs", label: "R" },
  { key: "er", label: "ER" },
  { key: "bbs", label: "BB" },
  { key: "ks", label: "K" },
  { key: "hrs", label: "HR" },
  { key: "pitches", label: "P" },
  { key: "strike_pct", label: "Str%" },
  { key: "csw_pct", label: "CSW%" },
  { key: "rehab_starts", label: "Rehab GS", title: "Starts made in this window" },
  { key: "il_status", label: "IL Status" },
];

const PCT_KEYS = new Set(["strike_pct", "csw_pct"]);
const NUMERIC_KEYS = new Set([
  "hits", "runs", "er", "bbs", "ks", "hrs", "pitches", "rehab_starts",
  ...PCT_KEYS,
]);

function ipToNumeric(ip) {
  if (ip == null) return 0;
  const [whole, thirds] = String(ip).split(".");
  return (parseInt(whole, 10) || 0) + (parseInt(thirds, 10) || 0) / 3;
}

export default function RehabStartsTable({
  data,
  onPitcherClick,
  sortKey = "date",
  onSortKeyChange,
  sortDir = "desc",
  onSortDirChange,
}) {
  const rows = data?.pitchers || [];

  const handleSort = (key) => {
    if (sortKey === key) onSortDirChange?.(sortDir === "asc" ? "desc" : "asc");
    else { onSortKeyChange?.(key); onSortDirChange?.("desc"); }
  };

  const sorted = useMemo(() => {
    const out = [...rows];
    return out.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
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
    if (PCT_KEYS.has(key)) return `${v}%`;
    return v;
  };

  return (
    <table className="data-table rehab-starts-table">
      <thead>
        <tr>
          {COLUMNS.map(c => (
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
            {COLUMNS.map(c => {
              if (c.key === "pitcher") {
                return (
                  <td key={c.key}>
                    {onPitcherClick ? (
                      <span
                        className="pitcher-link mlb-exp"
                        role="button"
                        tabIndex={0}
                        onClick={(e) => onPitcherClick(row.pitcher_id, e)}
                      >
                        {row.pitcher}
                      </span>
                    ) : <span className="mlb-exp">{row.pitcher}</span>}
                  </td>
                );
              }
              if (c.key === "date") {
                return (
                  <td key={c.key} className="rehab-date-cell">
                    {row.date}
                    <span className="level-tag">{row.level}</span>
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
              return <td key={c.key}>{fmt(row, c.key)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
