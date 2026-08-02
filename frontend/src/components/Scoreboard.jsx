import React, { useState, useRef, useCallback, useEffect } from "react";
import { displayTeamAbbrev } from "../constants";
import { getPBPResultColor, getPADescriptionSpans, isCIOrErrorEvent } from "../utils/pitchFilters";
import { vpToZoomCoord, getDesktopZoom } from "../utils/desktopZoom";
import { ordinalInning as ordinal } from "../utils/gamePresentation";

// The null guard lives in this thin wrapper so ScoreboardInner's hooks always
// run unconditionally (react-hooks/rules-of-hooks).
export default function Scoreboard(props) {
  if (!props.data || !props.data.innings || props.data.innings.length === 0) return null;
  return <ScoreboardInner {...props} />;
}

function ScoreboardInner({ data, pitcherId, onInningClick }) {
  const displayAbbrev = (abbr) => displayTeamAbbrev(abbr);
  const [tooltip, setTooltip] = useState(null); // { inning, top, x, y, above }
  const [clampedPos, setClampedPos] = useState(null); // { left, top, bottom }
  const boardRef = useRef(null);
  const tooltipRef = useRef(null);

  const { away_team, home_team, innings, totals, plays, pitcher_exit } = data;
  const maxInnings = Math.max(9, innings.length);

  // Home team won and therefore did not bat in the bottom of the final inning.
  // When the top of the 9th (or final) inning ends with the home team ahead,
  // they've already won and skip their at-bat — mark that cell with a grey X.
  // Gate on is_final: in a LIVE game the home team can lead during the top of
  // the final inning while the away team is still batting (and could tie or
  // take the lead), so the "did not bat" X must not appear until the game ends.
  const isFinal = data.is_final !== false; // default to true when the flag is absent
  const homeWon = isFinal && totals && totals.home && totals.away && totals.home.runs > totals.away.runs;
  const isHomeSkippedCell = (inn, inningNum) => {
    if (!homeWon || !inn) return false;
    if (inningNum < 9) return false;
    if (inningNum !== innings.length) return false; // must be the final inning
    const awayBatted = inn.away && inn.away.runs != null;
    const homeBatted = inn.home && inn.home.runs != null;
    return awayBatted && !homeBatted;
  };

  // Find pitcher exit info
  const exit = pitcherId && pitcher_exit ? pitcher_exit[String(pitcherId)] : null;

  // Get plays for a half-inning
  const getPlays = (inning, isTop) => {
    if (!plays) return [];
    const half = plays.find(p => p.inning === inning && p.top === isTop);
    return half ? half.pas : [];
  };

  const handleMouseEnter = useCallback((e, inning, isTop) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({
      inning, top: isTop,
      x: rect.left + rect.width / 2,
      y: isTop ? rect.bottom + 6 : rect.top - 6,
      above: !isTop,
    });
    setClampedPos(null); // Reset clamped position
  }, []);

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  const isExitCell = (inning, isTop) => {
    if (!exit) return false;
    return exit.last_inning === inning && exit.last_top === isTop;
  };

  const tooltipPas = tooltip ? getPlays(tooltip.inning, tooltip.top) : [];

  // Check if featured pitcher is pitching in this tooltip's inning
  const tooltipPitcherId = tooltipPas.length > 0 ? tooltipPas[0]?.pitcher_id : null;
  const isFeaturedPitcherPitching = pitcherId && tooltipPitcherId === pitcherId;

  // Count real pitches (excluding non-pitch action events like pickoffs, balks,
  // stolen base attempts, wild pitches) thrown by the featured pitcher in a list of PAs.
  // Filters strictly by pa.pitcher_id so relievers in the same inning don't pollute the count.
  const countFeaturedPitches = (pas) => {
    if (!pas || pitcherId == null) return 0;
    const targetPid = Number(pitcherId);
    return pas.reduce((sum, pa) => {
      if (pa == null || Number(pa.pitcher_id) !== targetPid) return sum;
      if (!Array.isArray(pa.pitches)) return sum;
      return sum + pa.pitches.filter(p => !p.is_action).length;
    }, 0);
  };

  // Compute cumulative pitch count for featured pitcher through the current tooltip's half-inning
  const featuredPitcherTotalPitches = pitcherId && plays && tooltip ? plays.reduce((sum, half) => {
    // Only count innings up to and including the current tooltip half-inning
    if (half.inning > tooltip.inning || (half.inning === tooltip.inning && half.top === false && tooltip.top === true)) return sum;
    return sum + countFeaturedPitches(half.pas);
  }, 0) : 0;

  // Compute pitch count in the current tooltip half-inning for featured pitcher
  const tooltipInningPitches = countFeaturedPitches(tooltipPas);

  // Handle tooltip viewport clamping
  useEffect(() => {
    if (!tooltip || !tooltipRef.current) return;

    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const padding = 10;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = tooltip.x;
    let top = tooltip.y;
    let above = tooltip.above;

    // Clamp left to viewport
    if (left - tooltipRect.width / 2 < padding) {
      left = tooltipRect.width / 2 + padding;
    } else if (left + tooltipRect.width / 2 > viewportWidth - padding) {
      left = viewportWidth - tooltipRect.width / 2 - padding;
    }

    // Check if tooltip would go below viewport, if so, show above instead
    if (!above && top + tooltipRect.height > viewportHeight - padding) {
      above = true;
    }

    // Check if tooltip would go above viewport, if so, show below instead
    if (above && top - tooltipRect.height < padding) {
      above = false;
      // Reposition below the cell
      top = tooltip.y + 12;
    }

    setClampedPos({ left, top, above });
  }, [tooltip]);

  return (
    <div className="scoreboard-wrap" ref={boardRef}>
      <table className="scoreboard">
        <thead>
          <tr>
            <th className="sb-team-hdr"></th>
            {Array.from({ length: maxInnings }, (_, i) => (
              <th key={i} className="sb-inn-hdr">{i + 1}</th>
            ))}
            <th className="sb-stat-hdr sb-rhe">R</th>
            <th className="sb-stat-hdr sb-rhe">H</th>
            <th className="sb-stat-hdr sb-rhe">E</th>
          </tr>
        </thead>
        <tbody>
          {/* Away row */}
          <tr>
            <td className="sb-team">{displayAbbrev(away_team)}</td>
            {Array.from({ length: maxInnings }, (_, i) => {
              const inn = innings[i];
              const runs = inn ? inn.away.runs : "";
              const exitCell = isExitCell(i + 1, true);
              return (
                <td key={i}
                  className={`sb-cell sb-inn${exitCell ? " sb-exit" : ""}`}
                  onMouseEnter={e => inn && handleMouseEnter(e, i + 1, true)}
                  onMouseLeave={handleMouseLeave}
                  onClick={() => inn && onInningClick && onInningClick(i + 1, true)}>
                  {runs !== "" ? runs : ""}
                </td>
              );
            })}
            <td className="sb-cell sb-stat sb-rhe">{totals.away.runs}</td>
            <td className="sb-cell sb-stat sb-rhe">{totals.away.hits}</td>
            <td className="sb-cell sb-stat sb-rhe">{totals.away.errors}</td>
          </tr>
          {/* Home row */}
          <tr>
            <td className="sb-team">{displayAbbrev(home_team)}</td>
            {Array.from({ length: maxInnings }, (_, i) => {
              const inn = innings[i];
              const runs = inn ? (inn.home.runs !== undefined ? inn.home.runs : "") : "";
              const exitCell = isExitCell(i + 1, false);
              const homeSkipped = isHomeSkippedCell(inn, i + 1);
              return (
                <td key={i}
                  className={`sb-cell sb-inn${exitCell ? " sb-exit" : ""}`}
                  onMouseEnter={e => inn && !homeSkipped && handleMouseEnter(e, i + 1, false)}
                  onMouseLeave={handleMouseLeave}
                  onClick={() => inn && !homeSkipped && onInningClick && onInningClick(i + 1, false)}>
                  {homeSkipped
                    ? <span className="sb-no-bat" aria-label="Home team did not bat (already won)">×</span>
                    : (runs !== "" ? runs : "")}
                </td>
              );
            })}
            <td className="sb-cell sb-stat sb-rhe">{totals.home.runs}</td>
            <td className="sb-cell sb-stat sb-rhe">{totals.home.hits}</td>
            <td className="sb-cell sb-stat sb-rhe">{totals.home.errors}</td>
          </tr>
        </tbody>
      </table>

      {/* Hover tooltip */}
      {tooltip && tooltipPas.length > 0 && (() => {
        // Inline coords are interpreted in body's zoomed coord system; divide
        // viewport-coord values by the zoom factor so the tooltip lands at
        // the intended viewport pixel.
        const zoom = getDesktopZoom();
        const leftVp = clampedPos ? clampedPos.left : tooltip.x;
        const topVp = clampedPos?.top || tooltip.y;
        const above = clampedPos?.above;
        return (
        <div ref={tooltipRef} className="sb-tooltip"
          style={{
            left: vpToZoomCoord(leftVp),
            ...(above
              ? { bottom: vpToZoomCoord(window.innerHeight - topVp) }
              : { top: vpToZoomCoord(topVp) }),
            transform: "translateX(-50%)",
          }}>
          <div className="sb-tooltip-hdr" style={{
            fontSize: "14px",
            fontWeight: 700,
            marginBottom: "8px",
            display: "flex",
            flexDirection: "row",
            gap: "4px",
            alignItems: "baseline",
            textTransform: "none",
            letterSpacing: "normal",
          }}>
            <span style={{
              color: isFeaturedPitcherPitching ? "var(--accent, #38BDF8)" : "var(--text-bright)",
            }}>
              {tooltip.top ? `Top ${ordinal(tooltip.inning)}` : `Bot ${ordinal(tooltip.inning)}`}
            </span>
            <span style={{ color: "var(--text-dim)" }}>—</span>
            <span style={{
              color: isFeaturedPitcherPitching ? "var(--accent, #38BDF8)" : "var(--text-bright)",
            }}>
              {tooltipPas[0]?.pitcher || "Unknown"}
            </span>
            <span style={{ color: "var(--text-dim)" }}>vs.</span>
            <span style={{ color: "var(--text-dim)" }}>
              {displayAbbrev(tooltip.top ? away_team : home_team)}
            </span>
          </div>
          {isFeaturedPitcherPitching && (
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6, display: "flex", gap: 12 }}>
              <span>Total Pitches: <span style={{ color: "var(--text-bright)", fontWeight: 600 }}>{featuredPitcherTotalPitches}</span></span>
              <span>Pitches: <span style={{ color: "var(--text-bright)", fontWeight: 600 }}>{tooltipInningPitches}</span></span>
            </div>
          )}
          {tooltipPas.map((pa, i) => {
            const prevPa = i > 0 ? tooltipPas[i - 1] : null;
            const isPitcherChange = prevPa && prevPa.pitcher_id !== pa.pitcher_id;
            const isFeaturedPa = isFeaturedPitcherPitching && pa.pitcher_id === pitcherId;
            const resultColor = isFeaturedPa ? getPBPResultColor(pa.result) : null;
            const isCIErr = isCIOrErrorEvent(pa.result);
            // Hits where a runner was thrown out — the out sentence renders blue
            const _r = (pa.result || "").toLowerCase().replace(/\s+/g, "_");
            const _isHit = _r === "single" || _r === "double" || _r === "triple";
            const isHitWithOut = _isHit && /\bout at\b|\bout advancing\b|\bthrown out\b/i.test(pa.description || "");

            // Extract mid-AB action events from this PA's pitches
            const midAbActions = (pa.pitches || []).filter(p => p.is_action && (p.scored || ["Wild Pitch", "Caught Stealing", "Pickoff CS", "Passed Ball", "Balk"].some(e => (p.event_type || "").toLowerCase().includes(e.toLowerCase()) || (p.desc || "").toLowerCase().includes(e.toLowerCase()))));

            // Count runs scored on mid-AB actions
            const actionRuns = midAbActions.filter(a => a.scored).reduce((sum) => sum + 1, 0);

            // Detect total runs scored on this PA by comparing scores
            let runsScored = 0;
            if (pa.home_score != null && pa.away_score != null) {
              const prevHome = prevPa?.home_score ?? (i === 0 ? null : null);
              const prevAway = prevPa?.away_score ?? (i === 0 ? null : null);
              if (prevHome != null && prevAway != null) {
                runsScored = (pa.home_score + pa.away_score) - (prevHome + prevAway);
              } else if (i === 0) {
                const prevHalfPlays = tooltip ? getPlays(
                  tooltip.top ? tooltip.inning - 1 : tooltip.inning,
                  tooltip.top ? false : true
                ) : [];
                const lastPrevPa = prevHalfPlays.length > 0 ? prevHalfPlays[prevHalfPlays.length - 1] : null;
                if (lastPrevPa && lastPrevPa.home_score != null && lastPrevPa.away_score != null) {
                  runsScored = (pa.home_score + pa.away_score) - (lastPrevPa.home_score + lastPrevPa.away_score);
                } else if (pa.rbi > 0) {
                  runsScored = pa.rbi;
                }
              }
            }
            if (runsScored < 0) runsScored = 0;

            // Split runs: those from mid-AB actions vs. those from the PA result
            const paResultRuns = Math.max(0, runsScored - actionRuns);

            // Compute score after mid-AB actions (before PA result)
            // We know the final score is pa.home_score/pa.away_score
            // The runs from the PA result happen at the end, so mid-AB score is final minus paResultRuns
            const midAbAwayScore = pa.away_score != null ? pa.away_score - (tooltip.top ? paResultRuns : 0) : null;
            const midAbHomeScore = pa.home_score != null ? pa.home_score - (tooltip.top ? 0 : paResultRuns) : null;

            return (
              <React.Fragment key={i}>
                {isPitcherChange && (
                  <div className="sb-tooltip-relief">
                    {prevPa.pitcher} relieved by {pa.pitcher}
                  </div>
                )}
                <div className={`sb-tooltip-pa${isFeaturedPa ? " sb-hl" : ""}`}
                  style={isFeaturedPa ? {
                    color: resultColor || "var(--text-bright)",
                    fontWeight: 600,
                  } : (isCIErr ? { color: "#feffa3", fontWeight: 600 } : {})}>
                  {(() => {
                    const desc = pa.description || `${pa.batter}: ${pa.result}`;
                    // Always run sentence-level coloring so "scores" + CI/error
                    // and hit-with-out highlights show even on non-featured PAs.
                    const spans = getPADescriptionSpans(desc, { isCIOrError: isCIErr, isHitWithOut });
                    return spans.map((s, idx) => (
                      <span key={idx} style={s.style || undefined}>{s.text}</span>
                    ));
                  })()}
                </div>
                {/* Show mid-AB action events (wild pitch, caught stealing, etc.) */}
                {midAbActions.length > 0 && midAbActions.map((action, ai) => (
                  <div key={`action-${ai}`} style={{ fontSize: 10, padding: "1px 0 1px 0", lineHeight: 1.3, fontStyle: "italic", color: action.scored ? "#FF5EDC" : "rgba(180,184,210,0.7)" }}>
                    {action.desc}
                  </div>
                ))}
                {/* Run scoring indicator for mid-AB actions */}
                {actionRuns > 0 && midAbAwayScore != null && (
                  <div style={{ fontSize: 10, padding: "1px 0 3px 0", lineHeight: 1.3 }}>
                    <span style={{ color: "#FF5EDC", fontWeight: 600 }}>
                      {actionRuns} run{actionRuns > 1 ? "s" : ""} score{actionRuns === 1 ? "s" : ""}
                    </span>
                    {" "}
                    <span style={{ color: "var(--text-bright)" }}>
                      <span style={{ color: tooltip.top ? "#ffc277" : "var(--text-bright)" }}>{displayAbbrev(away_team)}</span>
                      {" "}{midAbAwayScore} - {midAbHomeScore}{" "}
                      <span style={{ color: tooltip.top ? "var(--text-bright)" : "#ffc277" }}>{displayAbbrev(home_team)}</span>
                    </span>
                  </div>
                )}
                {/* Run scoring indicator for the PA result itself */}
                {paResultRuns > 0 && pa.home_score != null && (
                  <div style={{ fontSize: 10, padding: "1px 0 3px 0", lineHeight: 1.3 }}>
                    <span style={{ color: "#FF5EDC", fontWeight: 600 }}>
                      {paResultRuns} run{paResultRuns > 1 ? "s" : ""} score{paResultRuns === 1 ? "s" : ""}
                    </span>
                    {" "}
                    <span style={{ color: "var(--text-bright)" }}>
                      <span style={{ color: tooltip.top ? "#ffc277" : "var(--text-bright)" }}>{displayAbbrev(away_team)}</span>
                      {" "}{pa.away_score} - {pa.home_score}{" "}
                      <span style={{ color: tooltip.top ? "var(--text-bright)" : "#ffc277" }}>{displayAbbrev(home_team)}</span>
                    </span>
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
        );
      })()}
    </div>
  );
}
