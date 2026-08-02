import React, { useEffect, useState, useMemo } from "react";
import { PITCHER_RESULTS_COLUMNS, getPitchColor, TEAM_FULL_NAMES, displayTeamAbbrev } from "../constants";
import { fmtPct, fmtInt } from "../utils/formatting";

const TEAM_SPLIT_HIDE = ["team", "opponent"];
const MOBILE_HIDE = ["hand"];

// IP string like "7.1" represents 7⅓ innings (decimal part = outs: 0, 1, or 2)
function ipToNumeric(ip) {
  if (ip == null) return 0;
  const parts = String(ip).split(".");
  const whole = parseInt(parts[0], 10) || 0;
  const thirds = parseInt(parts[1] || "0", 10) || 0;
  return whole + thirds / 3;
}

// Game-end decision indicators shown in the score-line parenthetical.
// Color is applied to the LETTERS only — the parentheses stay the line's
// default grey. Color names map to the dashboard's pitch/accent palette.
const DECISION_DISPLAY = {
  W:   { label: "W",   color: "#6DE95D" }, // Changeup green
  L:   { label: "L",   color: "#FF839B" }, // Four-Seamer red
  ND:  { label: "ND",  color: null },      // grey like the parens (game-over only)
  Sv:  { label: "Sv",  color: "#55e8ff" }, // Header blue
  Hld: { label: "Hld", color: "#ffc277" }, // Sinker orange
  BS:  { label: "BS",  color: "#FF5EDC" }, // HR pink
  F:   { label: "F",   color: null },      // no decision — keeps the current grey
};
const LIVE_ACTIVE_COLOR = "#ffc277";   // Player-name orange — still in the game
const LIVE_REMOVED_COLOR = null;       // grey like the parens — removed from the game

// Resolve the score-line parenthetical for a pitcher row.
// Final games show the pitcher's decision; live games show the (T#/B#) inning
// half, coloured by whether this pitcher is still in the game. `isRemovedFromGame`
// (computed by the caller) is true only once a later teammate has actually
// entered. Returns an array of { label, color } segments rendered comma-joined
// inside one set of parens (color null = inherit the line's grey), or null.
function getGameStateTag(row, isRemovedFromGame) {
  const gs = row.game_state || "";

  // Live game: "T7" (top 7th) / "B3" (bottom 3rd) — the inning half. Orange while
  // the pitcher is still in the game; grey ONLY when confirmed removed. Do NOT key
  // this off who is throwing now: current_pitcher_id is the game's defensive
  // pitcher, which flips to the opponent every half-inning this pitcher's team is
  // batting — that caused a grey/orange flicker each frame.
  if (gs && (gs[0] === "T" || gs[0] === "B")) {
    return [{ label: gs, color: isRemovedFromGame ? LIVE_REMOVED_COLOR : LIVE_ACTIVE_COLOR }];
  }

  // Decision codes from the boxscore note (W/L/S/H/BS).
  const codes = row.decision_codes && row.decision_codes.length
    ? row.decision_codes
    : (row.decision ? [row.decision] : []);

  // A completed game shows the pitcher's decision. Resolve it whenever the game
  // is final OR the row already carries a decision — independent of game_state,
  // so a finished game with an empty state still shows W/L/Sv/Hld instead of
  // dropping the decision entirely.
  if (gs === "F" || codes.length > 0) {
    if (row.role === "SP") {
      // Starters can only earn W, L, or No Decision.
      if (codes.includes("W")) return [DECISION_DISPLAY.W];
      if (codes.includes("L")) return [DECISION_DISPLAY.L];
      return [DECISION_DISPLAY.ND];
    }
    // Relievers: a save or hold is the primary tag; otherwise the W/L decision.
    // BS is appended whenever present (a pitcher can blow a save and still take
    // the W or L), with BS always last. No decision at all → ND.
    const parts = [];
    if (codes.includes("S")) parts.push(DECISION_DISPLAY.Sv);
    else if (codes.includes("H")) parts.push(DECISION_DISPLAY.Hld);
    else if (codes.includes("W")) parts.push(DECISION_DISPLAY.W);
    else if (codes.includes("L")) parts.push(DECISION_DISPLAY.L);
    if (codes.includes("BS")) parts.push(DECISION_DISPLAY.BS);
    return parts.length ? parts : [DECISION_DISPLAY.ND];
  }

  // Other states (delays, etc.) — show raw, uncolored, or nothing.
  return gs ? [{ label: gs, color: null }] : null;
}

export default function PitcherResultsTable({ data, date, onPitcherClick, spOnly, splitByTeam, isMobile, sortKey: sortKeyProp, onSortKeyChange, sortDir: sortDirProp, onSortDirChange, hiddenCols = [], onSortedRowsChange }) {
  const [sortKeyLocal, setSortKeyLocal] = useState("er");
  const [sortDirLocal, setSortDirLocal] = useState("asc");
  const sortKey = onSortKeyChange ? sortKeyProp : sortKeyLocal;
  const setSortKey = onSortKeyChange || setSortKeyLocal;
  const sortDir = onSortDirChange ? sortDirProp : sortDirLocal;
  const setSortDir = onSortDirChange || setSortDirLocal;

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const filtered = useMemo(() => {
    let rows = data || [];
    if (spOnly) {
      // Prefer backend-classified role (which handles opener swaps). Fall back to
      // per-team minimum appearance_order if rows don't carry a role yet.
      const hasRole = rows.some(r => r && r.role);
      if (hasRole) {
        rows = rows.filter(r => r.role === "SP");
      } else {
        const spMap = {};
        rows.forEach(r => {
          const k = r.team + "|" + r.game_pk;
          if (!(k in spMap) || r.appearance_order < spMap[k]) {
            spMap[k] = r.appearance_order;
          }
        });
        rows = rows.filter(r => r.appearance_order === spMap[r.team + "|" + r.game_pk]);
      }
    }
    return rows;
  }, [data, spOnly]);

  const sorted = useMemo(() => {
    if (sortKey) {
      return [...filtered].sort((a, b) => {
        let av = a[sortKey], bv = b[sortKey];
        if (av == null) return 1; if (bv == null) return -1;
        // IP sort: "7.1" means 7⅓ innings, not 7.1
        if (sortKey === "ip") {
          av = ipToNumeric(av);
          bv = ipToNumeric(bv);
        }
        // Sort team column by full name, not abbreviation
        if (sortKey === "team") { av = TEAM_FULL_NAMES[av] || av; bv = TEAM_FULL_NAMES[bv] || bv; }
        const avNum = Number(av);
        const bvNum = Number(bv);
        const useNumericSort = Number.isFinite(avNum) && Number.isFinite(bvNum);
        if (!useNumericSort && typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
        const primary = sortDir === "asc" ? avNum - bvNum : bvNum - avNum;
        if (primary === 0 && sortKey === "er") {
          // ER ties: most innings first, then highest CSW%.
          const aip = ipToNumeric(a.ip);
          const bip = ipToNumeric(b.ip);
          if (aip !== bip) return bip - aip;
          const acsw = a.csw_pct || 0;
          const bcsw = b.csw_pct || 0;
          return bcsw - acsw;
        }
        return primary;
      });
    }
    return [...filtered].sort((a, b) => {
      if (a.team !== b.team) return (TEAM_FULL_NAMES[a.team] || a.team).localeCompare(TEAM_FULL_NAMES[b.team] || b.team);
      return a.appearance_order - b.appearance_order;
    });
  }, [filtered, sortKey, sortDir]);

  useEffect(() => {
    if (onSortedRowsChange) onSortedRowsChange(sorted);
  }, [onSortedRowsChange, sorted]);

  // Compute max pitcher name width across ALL data for consistent team card sizing
  const maxPitcherWidth = useMemo(() => {
    if (!splitByTeam) return 170;
    const names = (data || []).map(r => r.pitcher).filter(Boolean);
    if (!names.length) return 170;
    const maxLen = Math.max(...names.map(n => n.length));
    return Math.max(170, Math.ceil(maxLen * 7.5) + 20);
  }, [data, splitByTeam]);

  // Highest appearance_order per (game, team) = the most recently-entered pitcher,
  // i.e. the one still in the game. A row below its team's max has been relieved
  // (a later teammate actually entered) — the only thing that should grey a live
  // (T#/B#) tag. Built from the full `data` (not the spOnly/rpOnly-filtered subset)
  // so the true current pitcher is always represented.
  const maxApByTeamGame = useMemo(() => {
    const m = new Map();
    (data || []).forEach(r => {
      if (!r || r.game_pk == null || r.team == null || r.appearance_order == null) return;
      const k = `${r.game_pk}|${r.team}`;
      const prev = m.get(k);
      if (prev == null || r.appearance_order > prev) m.set(k, r.appearance_order);
    });
    return m;
  }, [data]);

  const getColWidth = (key) => {
    if (key === "pitcher") return isMobile ? 130 : maxPitcherWidth;
    if (key === "hand") return 52;
    if (key === "opponent") return 175;
    if (key === "csw_pct" || key === "strike_pct" || key === "par_pct") return 65;
    if (key === "velo") return 96;
    if (key === "velo_ext") return 80;
    return 50;
  };

  const dim = (val) => (val === "--" || val === "-") ? <span style={{ color: "rgb(180, 185, 219)" }}>{val}</span> : val;

  const formatGameLine = (row) => {
    if (!row.opponent) return <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
    const isHome = row.home_team && row.team === row.home_team;
    const homeAbbr = displayTeamAbbrev(row.home_team) || row.home_team || "";
    const awayAbbr = displayTeamAbbrev(row.away_team) || row.away_team || "";
    const homeScore = row.home_score != null ? row.home_score : "";
    const awayScore = row.away_score != null ? row.away_score : "";
    // Bold the pitcher's own team so it stands out within the matchup.
    const ownTeam = { color: "#d0d0d0", fontWeight: 600 };
    const awayStyle = !isHome ? ownTeam : undefined;
    const homeStyle = isHome ? ownTeam : undefined;
    if (homeScore === "" && awayScore === "") {
      return <span style={{ fontSize: 12, color: "#a5a5a5" }}><span style={awayStyle}>{awayAbbr}</span> - <span style={homeStyle}>{homeAbbr}</span></span>;
    }
    const maxAp = maxApByTeamGame.get(`${row.game_pk}|${row.team}`);
    const isRemovedFromGame = maxAp != null && row.appearance_order != null && row.appearance_order < maxAp;
    const tag = getGameStateTag(row, isRemovedFromGame);
    return (
      <span style={{ fontSize: 12, color: "#a5a5a5" }}>
        <span style={awayStyle}>{awayAbbr} {awayScore}</span> - <span style={homeStyle}>{homeAbbr} {homeScore}</span>
        {tag && (
          <>{" "}({tag.map((p, i) => (
            <React.Fragment key={i}>
              {i > 0 ? ", " : ""}
              <span style={p.color ? { color: p.color, fontWeight: 700 } : undefined}>{p.label}</span>
            </React.Fragment>
          ))})</>
        )}
      </span>
    );
  };

  // No-comparison-data placeholder. Always rendered when there's a value but
  // no delta, so cells with deltas line up vertically with cells without.
  const noDeltaEl = (
    <span className="delta-value delta-neutral" style={{ marginLeft: 4 }}>(----)</span>
  );

  const renderVeloCell = (row) => {
    const v = row.velo;
    if (v == null) return <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
    const pitch = row.velo_pitch;
    const color = getPitchColor(pitch);
    const delta = row.velo_delta;
    let deltaEl;
    if (delta != null && !isNaN(delta)) {
      const cls = delta >= 1.0 ? "delta-up" : delta <= -1.0 ? "delta-down" : "delta-neutral";
      const text = `(${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`;
      deltaEl = <span className={`delta-value ${cls}`} style={{ marginLeft: 4 }}>{text}</span>;
    } else {
      deltaEl = noDeltaEl;
    }
    return (
      <span style={{ whiteSpace: "nowrap" }}>
        <span style={{ color, fontWeight: 600 }}>{Number(v).toFixed(1)}</span>
        {deltaEl}
      </span>
    );
  };

  // Extension on the same featured fastball used by FB MPH.
  const renderExtCell = (row) => {
    const v = row.velo_ext;
    if (v == null) return <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
    const delta = row.velo_ext_delta;
    let deltaEl;
    if (delta != null && !isNaN(delta)) {
      // 0.2 ft (~2.4 inches) is a meaningful release-extension change.
      const cls = delta >= 0.2 ? "delta-up" : delta <= -0.2 ? "delta-down" : "delta-neutral";
      const text = `(${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`;
      deltaEl = <span className={`delta-value ${cls}`} style={{ marginLeft: 4 }}>{text}</span>;
    } else {
      deltaEl = noDeltaEl;
    }
    return (
      <span style={{ whiteSpace: "nowrap" }}>
        <span style={{ fontWeight: 500 }}>{Number(v).toFixed(1)}</span>
        {deltaEl}
      </span>
    );
  };

  const renderCell = (row, col) => {
    const v = row[col.key];
    if (col.key === "pitcher") {
      if (!v) return <span className="pitcher-name" style={{ color: "rgb(180, 185, 219)" }}>--</span>;
      const isSP = row.role === "SP";
      const nameClass = isSP ? "pitcher-name pitcher-sp-highlight" : "pitcher-name";
      if (onPitcherClick && row.pitcher_id && row.game_pk && date) {
        const cardHref = `#card/${date}/${row.pitcher_id}/${row.game_pk}`;
        return <a className={nameClass} href={cardHref} rel="nofollow" onClick={(e) => { if (e.ctrlKey || e.metaKey) { e.stopPropagation(); } else { e.preventDefault(); } }} onMouseDown={(e) => { if (e.button === 1) e.stopPropagation(); }} onAuxClick={(e) => { if (e.button === 1) e.stopPropagation(); }} style={{ textDecoration: "none" }}>{v}</a>;
      }
      return <span className={nameClass}>{v}</span>;
    }
    if (col.key === "team") return displayTeamAbbrev(v) || <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
    if (col.key === "hand") {
      if (!v) return <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
      return v === "R" ? "RHP" : v === "L" ? "LHP" : v;
    }
    if (col.key === "opponent") return formatGameLine(row);
    if (col.key === "csw_pct" || col.key === "strike_pct" || col.key === "par_pct") return dim(fmtPct(v));
    if (col.key === "ip") return v != null ? v : <span style={{ color: "rgb(180, 185, 219)" }}>--</span>;
    if (col.key === "velo") return renderVeloCell(row);
    if (col.key === "velo_ext") return renderExtCell(row);
    return dim(fmtInt(v));
  };

  if (!sorted.length) return <div className="no-data">No pitcher results available.</div>;

  // Build opponent label for team header (e.g. "@ NYY" or "vs. KCR")
  const getTeamOppLabel = (rows) => {
    const first = rows[0];
    if (!first || !first.opponent) return "";
    const prefix = first.home_team && first.team === first.home_team ? "vs." : "@";
    return `${prefix} ${displayTeamAbbrev(first.opponent)}`;
  };

  const renderTable = (rows, teamLabel, isCard) => {
    let cols = isCard ? PITCHER_RESULTS_COLUMNS.filter(c => !TEAM_SPLIT_HIDE.includes(c.key)) : PITCHER_RESULTS_COLUMNS;
    if (!isCard) cols = cols.filter(c => !hiddenCols.includes(c.key));
    if (isMobile) cols = cols.filter(c => !MOBILE_HIDE.includes(c.key));
    const oppLabel = isCard ? getTeamOppLabel(rows) : "";
    const totalWidth = isCard && !isMobile ? cols.reduce((sum, c) => sum + getColWidth(c.key), 0) : undefined;
    return (
      <div className={isCard ? "team-card-wrapper" : ""} key={teamLabel || "all"} style={isCard && !isMobile ? { width: totalWidth + "px" } : undefined}>
        {teamLabel && (
          <div className="team-split-header">
            {teamLabel}
            {oppLabel && <span className="team-split-opp"> {oppLabel}</span>}
          </div>
        )}
        <div className={isCard ? "team-card" : "table-wrapper"}>
        <table style={isCard && !isMobile ? { tableLayout: "fixed", width: "100%" } : undefined}>
          {isCard && !isMobile && (
            <colgroup>
              {cols.map(c => <col key={c.key} style={{ width: getColWidth(c.key) + "px" }} />)}
            </colgroup>
          )}
          <thead>
            <tr>
              {cols.map(c => {
                const classes = [];
                if (isMobile && c.key === "pitcher") classes.push("mobile-sticky-col");
                if (c.dividerRight) classes.push("col-divider-right");
                return (
                  <th key={c.key}
                    className={classes.join(" ")}
                    title={c.tooltip || undefined}
                    style={{ textAlign: c.headerAlign || c.align || "left", ...(isMobile && c.key === "pitcher" ? { left: 0, minWidth: 130 } : {}) }}
                    onClick={() => handleSort(c.key)}>
                    <span className={sortKey === c.key ? "sort-active" : ""}>{c.label}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="clickable-row"
                  onClick={(e) => onPitcherClick && onPitcherClick(r.pitcher_id, r.game_pk, e)}
                  onMouseDown={(e) => { if (e.button === 1 && onPitcherClick) e.preventDefault(); }}
                  onAuxClick={(e) => { if (e.button === 1 && onPitcherClick) { e.preventDefault(); onPitcherClick(r.pitcher_id, r.game_pk, e); } }}>
                {cols.map(c => {
                  const classes = [];
                  if (isMobile && c.key === "pitcher") classes.push("mobile-sticky-col");
                  if (c.dividerRight) classes.push("col-divider-right");
                  return (
                    <td key={c.key}
                      className={classes.join(" ")}
                      style={{ textAlign: c.align || "left", ...(isMobile && c.key === "pitcher" ? { left: 0, minWidth: 130 } : {}) }}>
                      {renderCell(r, c)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    );
  };

  if (splitByTeam) {
    const teamOrder = [];
    const teamMap = {};
    sorted.forEach(r => {
      const k = r.team || "Unknown";
      if (!teamMap[k]) { teamMap[k] = []; teamOrder.push(k); }
      teamMap[k].push(r);
    });
    teamOrder.sort((a, b) => (TEAM_FULL_NAMES[a] || a).localeCompare(TEAM_FULL_NAMES[b] || b));
    return <div className="team-cards-grid">{teamOrder.map(team => renderTable(teamMap[team], TEAM_FULL_NAMES[team] || team, true))}</div>;
  }

  return renderTable(sorted, null, false);
}
