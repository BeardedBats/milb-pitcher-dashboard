import React from "react";
import { getGameKey } from "../utils/gameLogPitch";
import { aggregateGameLogTotals } from "../utils/seasonTotals";

// Generic Regular Season game-log table: shared left block (Date | Opp, plus
// the box score through K unless `slim`), pluggable right-side columns, and
// the shared row interactions (open card, shift-select) + Season Total row.
// Every game-log view (Overview / Pitch Mix / Results / Usage) renders
// through this shell so the markup and totals live in one place.
export default function GameLogTable({
  gameLog,              // sorted game-log entries (one row per game)
  totalLog,             // entries the Season Total row aggregates (selection-aware)
  liveGame,
  slim,                 // true = Date | Opp only on the left (Results view)
  rightCols,            // [{ key, label, color?, dividerRight? }]
  renderRightCell,      // (logRow, gameIndex, col) => node
  renderTotalRightCell, // (col, rs) => node — rs = aggregated season totals
  pitcherId,
  displayAbbrev,
  buildCardHref,
  onGameClick,
  onToggleSelect,
  onAuxClick,
  hasGameSelection,
  selectedGameKeys,
  // ---- optional display-mode hooks (pitch-mix viz modes; all default to no-op) ----
  rightCellAttrs,       // (logRow, gameIndex, col) => { className?, style? } for a right-block td (heatmap tint)
  renderRowDivider,     // (logRow, gameIndex, colSpan) => node | null — full-width row inserted before a game (approach-shift divider)
  renderDateBadge,      // (logRow, gameIndex) => node — appended inside the Date cell (per-game pitch-to-side pill)
  getRowClassName,      // (logRow, gameIndex) => string — extra class on a game row (dim excluded starts)
}) {
  const href = (date, gamePk) => (buildCardHref ? buildCardHref(date, gamePk) : "#");
  const abbrev = (a) => (displayAbbrev ? displayAbbrev(a) : a);
  // Live column count, so an inserted full-width row spans the table exactly
  // (it tracks Bars mode, which collapses the right block to one column).
  const colSpan = (slim ? 2 : 9) + rightCols.length;

  const rs = aggregateGameLogTotals(totalLog) || {};
  const g = rs.games || 0;
  const gs = rs.games_started || 0;
  const gamesLabel = gs > 0 && gs !== g ? `${g} Games (${gs} GS)` : `${g} Games`;
  const ipThirds = rs.ip_thirds || 0;
  const totalIp = rs.ip || `${Math.floor(ipThirds / 3)}.${ipThirds % 3}`;
  const ip = ipThirds / 3;
  const bf = rs.batters_faced || 0;
  const era = ip > 0 ? ((rs.er / ip) * 9).toFixed(2) : "—";
  const whip = ip > 0 ? (((rs.hits || 0) + (rs.bbs || 0)) / ip).toFixed(2) : "—";
  const h9 = ip > 0 ? (((rs.hits || 0) / ip) * 9).toFixed(1) : "—";
  const bbPct = bf > 0 ? ((rs.bbs || 0) / bf * 100).toFixed(1) + "%" : "—";
  const kPct = bf > 0 ? ((rs.ks || 0) / bf * 100).toFixed(1) + "%" : "—";

  const divCls = (c) => (c.dividerRight ? "gameline-divider-right" : "");

  return (
    <table className="card-gameline-table">
      <thead>
        <tr>
          <th>Date</th>
          <th className={slim ? "gameline-divider-right" : ""}>Opp</th>
          {!slim && (
            <>
              <th>Dec</th><th>IP</th><th>R</th><th>ER</th><th>Hits</th><th>BB</th>
              <th className="gameline-divider-right">K</th>
            </>
          )}
          {rightCols.map(c => (
            <th key={c.key} className={divCls(c)} style={c.color ? { color: c.color } : undefined}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {gameLog.map((row, i) => {
          const gameKey = getGameKey(row, i);
          const isDimmedRow = hasGameSelection && !selectedGameKeys.has(gameKey);
          const isLive = liveGame && liveGame.game_pk === row.game_pk;
          const baseDec = row.decision || (isLive ? liveGame.projectedDecision : "ND");
          const dec = isLive && !row.decision ? `${baseDec}*` : baseDec;
          const decColor = baseDec === "W" ? "#6DE95D" : baseDec === "L" ? "#FF839B" : "#8a8eb0";
          const dateParts = row.date ? row.date.replace(/^\d{4}-/, "").split("-") : [];
          const dateShort = dateParts.length === 2 ? `${parseInt(dateParts[0], 10)}-${dateParts[1]}` : row.date;
          const divider = renderRowDivider ? renderRowDivider(row, i, colSpan) : null;
          const extraCls = getRowClassName ? getRowClassName(row, i) : "";
          return (
            <React.Fragment key={row.game_pk + "-" + i}>
            {divider}
            <tr
              className={`pp-log-row${extraCls ? ` ${extraCls}` : ""}`}
              style={isDimmedRow ? { opacity: 0.4 } : undefined}
              onClick={(e) => {
                if (e.shiftKey) { e.preventDefault(); onToggleSelect(row, i); return; }
                if (onGameClick) onGameClick(row.date, pitcherId, row.game_pk, e);
              }}
              onMouseDown={(e) => { if (e.button === 1 && onGameClick) { e.preventDefault(); onGameClick(row.date, pitcherId, row.game_pk, e); } }}
              onAuxClick={onAuxClick}
            >
              {/* Level tag sits right after the date, per spec — AFL rows live
                  inside the Regular Season log and are tagged AFL like any other. */}
              <td><a href={href(row.date, row.game_pk)} rel="nofollow" onClick={(e) => { if (e.ctrlKey || e.metaKey) { e.stopPropagation(); } else { e.preventDefault(); } }} onMouseDown={(e) => { if (e.button === 1) e.stopPropagation(); }} style={{ color: "inherit", textDecoration: "none" }}>{dateShort}</a>{row.level ? <span className="level-tag">{row.level}</span> : null}{renderDateBadge ? renderDateBadge(row, i) : null}</td>
              <td className={slim ? "gameline-divider-right" : ""}>{row.home === false || (row.team && row.home_team && row.team !== row.home_team) ? "@ " : ""}{abbrev(row.opponent)}</td>
              {!slim && (
                <>
                  <td style={{ color: decColor, fontWeight: baseDec !== "ND" ? 700 : 500 }}>{dec}</td>
                  <td>{row.ip}</td>
                  <td>{row.runs != null ? row.runs : "—"}</td>
                  <td>{row.er}</td>
                  <td>{row.hits}</td>
                  <td>{row.bbs}</td>
                  <td className="gameline-divider-right">{row.ks}</td>
                </>
              )}
              {rightCols.map(c => {
                const a = rightCellAttrs ? rightCellAttrs(row, i, c) : null;
                return (
                  <td key={c.key} className={`${divCls(c)}${a && a.className ? ` ${a.className}` : ""}`} style={a && a.style ? a.style : undefined}>
                    {renderRightCell(row, i, c)}
                  </td>
                );
              })}
            </tr>
            </React.Fragment>
          );
        })}
        <tr className="pp-total-row">
          <td colSpan={2} className={`pp-total-label${slim ? " gameline-divider-right" : ""}`}><span className="rate-label">Season Total</span>{gamesLabel}</td>
          {!slim && (
            <>
              <td><span className="rate-label">W-L</span>{rs.wins || 0}-{rs.losses || 0}</td>
              <td><span className="rate-label">IP</span>{totalIp}</td>
              <td><span className="rate-label">ERA</span>{era}</td>
              <td><span className="rate-label">WHIP</span>{whip}</td>
              <td><span className="rate-label">H/9</span>{h9}</td>
              <td><span className="rate-label">BB%</span>{bbPct}</td>
              <td className="gameline-divider-right"><span className="rate-label">K%</span>{kPct}</td>
            </>
          )}
          {rightCols.map(c => <td key={c.key} className={divCls(c)}>{renderTotalRightCell(c, rs)}</td>)}
        </tr>
      </tbody>
    </table>
  );
}
