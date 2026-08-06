import React, { useState, useMemo } from "react";
import { PITCH_COLORS } from "../constants";
import { fetchOrgPage, fetchWarmupStatus } from "../utils/api";
import { buildPlayerHash } from "../utils/navigation";
import useWarmupBackedResource from "../hooks/useWarmupBackedResource";

// Team pages route per MLB ORG (LAD, DET, ...), not per affiliate: one table
// per affiliate stacked highest level first (AAA → AA → A+ → A → R), formatted
// like the main table's team-separation mode.
//
// Only the AAA block has Statcast columns. Everything below it is box-score
// only, so those blocks render the adapted column set.

// AAA has Statcast, so its block keeps CSW%/Whiffs. Every level below is box
// score only and gets the adapted columns instead.
const STATCAST_COLS = [
  { key: "pitcher", label: "Pitcher" },
  { key: "hand", label: "Hand" },
  { key: "games", label: "G" },
  { key: "ip", label: "IP" },
  { key: "hits", label: "H" },
  { key: "bbs", label: "BB" },
  { key: "ks", label: "K" },
  { key: "er", label: "ER" },
  { key: "hrs", label: "HR" },
  { key: "csw_pct", label: "CSW%" },
  { key: "whiffs", label: "Whiffs" },
  { key: "pitches", label: "Pitches" },
];

const BOXSCORE_COLS = [
  { key: "pitcher", label: "Pitcher" },
  { key: "games", label: "G" },
  { key: "ip", label: "IP" },
  { key: "hits", label: "H" },
  { key: "runs", label: "R" },
  { key: "er", label: "ER" },
  { key: "bbs", label: "BB" },
  { key: "ks", label: "K" },
  { key: "hrs", label: "HR" },
  { key: "batters_faced", label: "BF" },
  { key: "pitches", label: "P" },
  { key: "strike_pct", label: "Str%" },
  { key: "go_ao", label: "GO/AO" },
];

function AffiliateTable({ block, onPlayerClick }) {
  const cols = block.statcast ? STATCAST_COLS : BOXSCORE_COLS;
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState("desc");

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("desc"); }
  };

  const sorted = useMemo(() => {
    const rows = block.rows || [];
    if (!sortCol) return rows;
    return [...rows].sort((a, b) => {
      const va = a[sortCol], vb = b[sortCol];
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortDir === "asc" ? va - vb : vb - va;
    });
  }, [block.rows, sortCol, sortDir]);

  const fmtCell = (row, col) => {
    const val = row[col.key];
    if (val == null) return "—";
    if (col.key === "pitcher") {
      if (onPlayerClick && row.pitcher_id) {
        const playerHref = `#${buildPlayerHash(row.pitcher_id)}`;
        return <a href={playerHref} rel="nofollow" onClick={(e) => { if (e.ctrlKey || e.metaKey) { e.stopPropagation(); } else { e.preventDefault(); } }} onMouseDown={(e) => { if (e.button === 1) e.stopPropagation(); }} style={{ color: "inherit", textDecoration: "none" }}>{val}</a>;
      }
      return val;
    }
    if (col.key === "strike_pct") return `${val}%`;
    if (col.key === "go_ao") return Number(val).toFixed(2);
    if (typeof val === "number" && col.key.includes("pct")) return val.toFixed(1);
    return val;
  };

  return (
    <div className="org-affiliate-block">
      <div className="org-affiliate-header">
        <span className="level-tag">{block.level}</span>
        <span className="org-affiliate-name">{block.team_name}</span>
        <span className="org-affiliate-abbrev">{block.team}</span>
      </div>
      {sorted.length === 0 ? (
        <div className="no-data" style={{ padding: 24 }}>No pitchers with data at this level.</div>
      ) : (
        <div className="table-card">
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  {cols.map(c => (
                    <th key={c.key} onClick={() => handleSort(c.key)} style={{ cursor: "pointer", whiteSpace: "nowrap" }}>
                      {c.label}{sortCol === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, i) => (
                  <tr key={`${row.pitcher_id}-${i}`}>
                    {cols.map(c => (
                      <td key={c.key}
                        className={[c.key === "pitcher" ? "pitcher-name-cell" : "", c.key === "pitcher" && row.mlb_exp ? "mlb-exp" : ""].filter(Boolean).join(" ")}
                        onClick={c.key === "pitcher" ? (e) => onPlayerClick(row.pitcher_id, row.pitcher, e) : undefined}
                        onMouseDown={c.key === "pitcher" ? (e) => { if (e.button === 1) { e.preventDefault(); onPlayerClick(row.pitcher_id, row.pitcher, e); } } : undefined}
                        style={c.key === "pitcher" ? { cursor: "pointer", color: "var(--name)" } : c.key === "pitch_name" ? { color: PITCH_COLORS[row.pitch_name] || "var(--text)" } : {}}
                      >
                        {fmtCell(row, c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TeamPage({ teamAbbrev, onPlayerClick, onBack }) {
  const org = (teamAbbrev || "").toUpperCase();

  const { data, loading, message: loadMsg } = useWarmupBackedResource({
    key: [org],
    load: () => fetchOrgPage(org),
    pollWarmup: fetchWarmupStatus,
    initialMessage: `Loading ${org} system...`,
    initialData: { org, affiliates: [] },
    normalize: (body) => (body && Array.isArray(body.affiliates) ? body : { org, affiliates: [] }),
  });

  const affiliates = data?.affiliates || [];

  return (
    <div className="team-page">
      <div className="page-header">
        <a className="back-btn" href={window.location.pathname} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); onBack(); } }} style={{ textDecoration: "none" }}>← Back</a>
        <h2 className="page-title">{org} System</h2>
      </div>
      {loading ? (
        <div className="loading-msg"><div className="loading-bars"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div>{loadMsg}</div>
      ) : affiliates.length === 0 ? (
        <div className="no-data">No affiliates found for {org}.</div>
      ) : (
        affiliates.map(block => (
          <AffiliateTable key={`${block.level}-${block.team}`} block={block} onPlayerClick={onPlayerClick} />
        ))
      )}
    </div>
  );
}
