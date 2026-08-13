import React, { useState, useMemo } from "react";
import { fetchOrgPage, fetchWarmupStatus } from "../utils/api";
import { buildPlayerHash } from "../utils/navigation";
import { downloadCsv } from "../utils/csv";
import useWarmupBackedResource from "../hooks/useWarmupBackedResource";
import WarmupStalled from "./WarmupStalled";
import LoadError from "./LoadError";

// Team pages route per MLB ORG (LAD, DET, ...), not per affiliate: one table
// per affiliate stacked highest level first (AAA → AA → A+ → A → R).
//
// ONE column set for every level. The base of every row is the official
// box-score season line (ERA/WHIP/GS/GO-AO/Strike% exist at all levels); the
// Statcast-only columns (SwStr%, CSW%, Velo/EXT/iVB) are an overlay the
// backend applies to AAA rows and render as hyphens everywhere else.
//
// `divider: true` draws the block boundary AFTER that column.
const COLS = [
  { key: "pitcher", label: "Pitcher", align: "left" },
  { key: "last_game", label: "Last Game", align: "left" },
  { key: "ip", label: "IP" },
  { key: "games", label: "G" },
  { key: "games_started", label: "GS", divider: true },
  { key: "era", label: "ERA" },
  { key: "whip", label: "WHIP" },
  { key: "bb_pct", label: "BB%" },
  { key: "k_pct", label: "K%", divider: true },
  { key: "hits", label: "H" },
  { key: "bbs", label: "BB" },
  { key: "ks", label: "K" },
  { key: "er", label: "ER" },
  { key: "hrs", label: "HR" },
  { key: "go_ao", label: "GO/AO", divider: true },
  { key: "swstr_pct", label: "SwStr%" },
  { key: "csw_pct", label: "CSW%" },
  { key: "strike_pct", label: "Strike%", divider: true },
  { key: "velo", label: "Velo" },
  { key: "ext", label: "EXT" },
  { key: "ivb", label: "iVB" },
];

// "70.1" innings must outrank "9.2" — string compare only reads the first
// digit, which is the bug this replaces.
function ipToNumeric(ip) {
  if (ip == null) return null;
  const [whole, thirds] = String(ip).split(".");
  return (parseInt(whole, 10) || 0) + (parseInt(thirds, 10) || 0) / 3;
}

// BB% / K% are derived here rather than shipped: every row already carries
// bbs/ks/batters_faced, and one source of truth beats three cached copies.
function pctOfBF(row, key) {
  const bf = row.batters_faced;
  if (!bf) return null;
  const num = key === "bb_pct" ? row.bbs : row.ks;
  if (num == null) return null;
  return (num / bf) * 100;
}

// All affiliates flattened into one CSV, Level/Team leading, honoring the
// SP Only / RP Only toggle and the page's default order (last game, newest
// first, within each affiliate block). Raw values — BB%/K% as numbers, no "%".
const EXPORT_COLS = [
  { key: "level", label: "Level" },
  { key: "team_name", label: "Team" },
  { key: "pitcher", label: "Pitcher" },
  { key: "last_game", label: "Last Game" },
  { key: "ip", label: "IP" },
  { key: "games", label: "G" },
  { key: "games_started", label: "GS" },
  { key: "era", label: "ERA" },
  { key: "whip", label: "WHIP" },
  { key: "bb_pct", label: "BB%", value: r => { const v = pctOfBF(r, "bb_pct"); return v == null ? "" : v.toFixed(1); } },
  { key: "k_pct", label: "K%", value: r => { const v = pctOfBF(r, "k_pct"); return v == null ? "" : v.toFixed(1); } },
  { key: "hits", label: "H" },
  { key: "bbs", label: "BB" },
  { key: "ks", label: "K" },
  { key: "er", label: "ER" },
  { key: "hrs", label: "HR" },
  { key: "go_ao", label: "GO/AO" },
  { key: "swstr_pct", label: "SwStr%" },
  { key: "csw_pct", label: "CSW%" },
  { key: "strike_pct", label: "Strike%" },
  { key: "velo", label: "Velo" },
  { key: "ext", label: "EXT" },
  { key: "ivb", label: "iVB" },
];

function exportOrgCsv(org, affiliates, spOnly, rpOnly) {
  const out = [];
  for (const block of affiliates) {
    let rows = block.rows || [];
    if (spOnly) rows = rows.filter(r => r.role === "SP");
    else if (rpOnly) rows = rows.filter(r => r.role === "RP");
    rows = [...rows].sort((a, b) => {
      if (a.last_game == null) return 1;
      if (b.last_game == null) return -1;
      return String(b.last_game).localeCompare(String(a.last_game));
    });
    for (const r of rows) out.push({ ...r, level: block.level, team_name: block.team_name || block.team });
  }
  if (!out.length) return;
  const roleTag = spOnly ? "_SP" : rpOnly ? "_RP" : "";
  downloadCsv(`org_${org}${roleTag}.csv`, EXPORT_COLS, out);
}

function sortValue(row, key) {
  if (key === "ip") return ipToNumeric(row.ip);
  if (key === "bb_pct" || key === "k_pct") return pctOfBF(row, key);
  // era/whip arrive as strings from the stats API ("3.86").
  if (key === "era" || key === "whip") {
    const n = parseFloat(row[key]);
    return Number.isNaN(n) ? null : n;
  }
  return row[key];
}

function AffiliateTable({ block, onPlayerClick, spOnly, rpOnly }) {
  // Most recent appearance on top — "who is pitching lately" is the question
  // an org page opens with.
  const [sortCol, setSortCol] = useState("last_game");
  const [sortDir, setSortDir] = useState("desc");

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("desc"); }
  };

  const sorted = useMemo(() => {
    let rows = block.rows || [];
    if (spOnly) rows = rows.filter(r => r.role === "SP");
    else if (rpOnly) rows = rows.filter(r => r.role === "RP");
    if (!sortCol) return rows;
    return [...rows].sort((a, b) => {
      const va = sortValue(a, sortCol), vb = sortValue(b, sortCol);
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string" && typeof vb === "string") {
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return sortDir === "asc" ? va - vb : vb - va;
    });
  }, [block.rows, sortCol, sortDir, spOnly, rpOnly]);

  const fmtCell = (row, col) => {
    const key = col.key;
    if (key === "pitcher") {
      const val = row.pitcher;
      if (onPlayerClick && row.pitcher_id) {
        const playerHref = `#${buildPlayerHash(row.pitcher_id)}`;
        // Plain clicks preventDefault and bubble to the row handler; the
        // new-tab gestures (ctrl/cmd/middle) stay native on the anchor and
        // stop propagating so the row doesn't open a second copy.
        return <a href={playerHref} rel="nofollow" onClick={(e) => { if (e.ctrlKey || e.metaKey) { e.stopPropagation(); } else { e.preventDefault(); } }} onMouseDown={(e) => { if (e.button === 1) e.stopPropagation(); }} onAuxClick={(e) => { if (e.button === 1) e.stopPropagation(); }} style={{ color: "inherit", textDecoration: "none" }}>{val}</a>;
      }
      return val;
    }
    if (key === "last_game") {
      // "07-08 (AAA)" — the level tag is the block's level, since each table
      // is one affiliate.
      const d = row.last_game;
      return d ? `${String(d).slice(5, 10)} (${block.level})` : "—";
    }
    if (key === "bb_pct" || key === "k_pct") {
      const v = pctOfBF(row, key);
      return v == null ? "—" : `${v.toFixed(1)}%`;
    }
    const val = row[key];
    if (val == null || val === "") return "—";
    // Whole numbers read faster in a rate column; the decimal was noise.
    if (key === "swstr_pct" || key === "csw_pct" || key === "strike_pct") return `${Math.round(val)}%`;
    if (key === "go_ao") return Number(val).toFixed(2);
    if (key === "velo" || key === "ext" || key === "ivb") return Number(val).toFixed(1);
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
        <div className="no-data" style={{ padding: 24 }}>
          {(block.rows || []).length === 0
            ? "No pitchers with data at this level."
            : `No ${spOnly ? "starters" : "relievers"} at this level.`}
        </div>
      ) : (
        <div className="table-card">
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  {COLS.map(c => (
                    <th
                      key={c.key}
                      onClick={() => handleSort(c.key)}
                      className={c.divider ? "col-divider-right" : ""}
                      style={{ cursor: "pointer", whiteSpace: "nowrap", textAlign: c.align || "right" }}
                    >
                      {c.label}{sortCol === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, i) => {
                  // The whole row opens the player page, not just the name —
                  // a stat cell is as natural a click target as the pitcher.
                  const canOpen = Boolean(onPlayerClick && row.pitcher_id);
                  const open = (e) => { if (canOpen) onPlayerClick(row.pitcher_id, row.pitcher, e); };
                  return (
                  <tr
                    key={`${row.pitcher_id}-${i}`}
                    className={canOpen ? "clickable-row" : undefined}
                    onClick={canOpen ? open : undefined}
                    // Middle-click opens a new tab; preventDefault on mousedown
                    // suppresses the browser's autoscroll widget first.
                    onMouseDown={canOpen ? (e) => { if (e.button === 1) e.preventDefault(); } : undefined}
                    onAuxClick={canOpen ? (e) => { if (e.button === 1) { e.preventDefault(); open(e); } } : undefined}
                  >
                    {COLS.map(c => (
                      <td key={c.key}
                        className={[
                          c.key === "pitcher" ? "pitcher-name-cell" : "",
                          c.key === "pitcher" && row.mlb_exp ? "mlb-exp" : "",
                          c.divider ? "col-divider-right" : "",
                        ].filter(Boolean).join(" ")}
                        style={{
                          textAlign: c.align || "right",
                          ...(c.key === "pitcher" ? { color: "var(--name)" } : {}),
                        }}
                      >
                        {fmtCell(row, c)}
                      </td>
                    ))}
                  </tr>
                  );
                })}
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
  // Starters are what this page is opened for — SP Only defaults on. The two
  // toggles are mutually exclusive, matching the MLB dashboard's pair.
  const [spOnly, setSpOnly] = useState(true);
  const [rpOnly, setRpOnly] = useState(false);

  const { data, loading, message: loadMsg, error, stalled, reload } = useWarmupBackedResource({
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
        <label className="toggle-label" style={{ marginLeft: "auto" }}>
          <input
            type="checkbox"
            checked={spOnly}
            onChange={(e) => { setSpOnly(e.target.checked); if (e.target.checked) setRpOnly(false); }}
          />
          <span>SP Only</span>
        </label>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={rpOnly}
            onChange={(e) => { setRpOnly(e.target.checked); if (e.target.checked) setSpOnly(false); }}
          />
          <span>RP Only</span>
        </label>
      </div>
      {/* error BEFORE the empty state: a failed request is not an empty org. */}
      {error ? (
        <LoadError
          message={`Couldn't load the ${org} system.`}
          detail={error.message}
          onRetry={reload}
        />
      ) : stalled ? (
        <WarmupStalled message={loadMsg} onRetry={reload} />
      ) : loading ? (
        <div className="loading-msg"><div className="loading-bars"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div>{loadMsg}</div>
      ) : affiliates.length === 0 ? (
        <div className="no-data">No affiliates found for {org}.</div>
      ) : (
        <>
          {affiliates.map(block => (
            <AffiliateTable
              key={`${block.level}-${block.team}`}
              block={block}
              onPlayerClick={onPlayerClick}
              spOnly={spOnly}
              rpOnly={rpOnly}
            />
          ))}
          <div className="table-actions">
            <button
              type="button"
              className="export-btn"
              title="Download every affiliate table as one CSV"
              onClick={() => exportOrgCsv(org, affiliates, spOnly, rpOnly)}
            >
              Export Org Tables
            </button>
          </div>
        </>
      )}
    </div>
  );
}
