import React, { useEffect, useState, useMemo } from "react";
import { PITCH_COLORS, PITCH_DESC_COLORS, BATTED_BALL_COLORS, BIP_QUALITY_COLORS, displayTeamAbbrev } from "../constants";
import { getResultColor, classifyBattedBall, getBIPQuality } from "../utils/formatting";
import { getTooltipResult, getPADescriptionSpans, isCIOrErrorEvent, buildExpandedPitchItems, isWildPitchOrPassedBall } from "../utils/pitchFilters";
import { vpToZoomCoord } from "../utils/desktopZoom";
import { normalizePlateZ } from "../utils/strikezone";
import { ordinalInning as ordinal } from "../utils/gamePresentation";
import { formatPaResult, isStrikeoutResult } from "../utils/pbpPresentation";
import useIsMobile from "../hooks/useIsMobile";
import StrikeZonePBP from "./StrikeZonePBP";

const TYPE_TO_NAME = {
  "Four-Seamer": "Four-Seamer", "Sinker": "Sinker", "Cutter": "Cutter",
  "Slider": "Slider", "Sweeper": "Sweeper", "Curveball": "Curveball",
  "Changeup": "Changeup", "Splitter": "Splitter", "Knuckleball": "Knuckleball",
};

// BATTED_BALL_COLORS and BIP_QUALITY_COLORS imported from constants.js
// ordinal / formatPaResult / isStrikeoutResult come from shared presentation
// utils (gamePresentation, pbpPresentation).

// Compute inning stats for a half-inning's PAs filtered to a specific pitcher
function computeInningStats(pas, pitcherId) {
  let totalPitches = 0, hits = 0, bbs = 0, ks = 0, hrs = 0, runs = 0, er = 0;
  let outs = 0;

  for (const pa of pas) {
    if (pitcherId && pa.pitcher_id !== pitcherId) continue;
    const r = (pa.result || "").toLowerCase();
    const pitchCount = pa.pitches ? pa.pitches.filter(p => !p.is_action).length : 0;
    totalPitches += pitchCount;

    // Count events
    if (r === "strikeout" || r === "strikeout_double_play") ks++;
    if (r === "walk" || r === "intent_walk") bbs++;
    if (r === "single" || r === "double" || r === "triple" || r === "home_run") hits++;
    if (r === "home_run") hrs++;
    if (pa.rbi) runs += pa.rbi;

    // Count outs made
    if (r === "strikeout" || r === "field_out" || r === "force_out" || r === "sac_fly" || r === "sac_bunt" || r === "fielders_choice_out") outs++;
    if (r === "grounded_into_double_play" || r === "double_play" || r === "strikeout_double_play" || r === "sac_fly_double_play") outs += 2;
    if (r === "triple_play") outs += 3;
  }

  // IP: convert outs to innings pitched format
  const fullInnings = Math.floor(outs / 3);
  const partialOuts = outs % 3;
  const ip = fullInnings + partialOuts / 10; // display as "1.2" for 1 and 2/3

  return { ip: ip.toFixed(1), hits, bbs, ks, hrs, runs, pitches: totalPitches };
}

export default function PlayByPlayModal({ data, inning: initialInning, isTop: initialIsTop, pitcherId, onClose }) {
  const displayAbbrev = (abbr) => displayTeamAbbrev(abbr);
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState({});
  const [activePaIndex, setActivePaIndex] = useState(0);
  const [pitchHover, setPitchHover] = useState(null);
  const [currentInning, setCurrentInning] = useState(initialInning);
  const [currentIsTop, setCurrentIsTop] = useState(initialIsTop);

  // Build list of half-innings the selected pitcher appeared in (for navigation)
  const pitcherHalfInnings = useMemo(() => {
    if (!data?.plays || !pitcherId) return [];
    return data.plays.filter(half =>
      half.pas && half.pas.some(pa => pa.pitcher_id === pitcherId)
    ).map(half => ({ inning: half.inning, isTop: half.top }));
  }, [data, pitcherId]);

  // Find current position in pitcherHalfInnings
  const currentHalfIdx = useMemo(() => {
    return pitcherHalfInnings.findIndex(h => h.inning === currentInning && h.isTop === currentIsTop);
  }, [pitcherHalfInnings, currentInning, currentIsTop]);

  const hasPrev = currentHalfIdx > 0;
  const hasNext = currentHalfIdx < pitcherHalfInnings.length - 1;

  const goToPrev = () => {
    if (hasPrev) {
      const prev = pitcherHalfInnings[currentHalfIdx - 1];
      setCurrentInning(prev.inning);
      setCurrentIsTop(prev.isTop);
      setActivePaIndex(0);
      setExpanded({});
      setPitchHover(null);
    }
  };

  const goToNext = () => {
    if (hasNext) {
      const next = pitcherHalfInnings[currentHalfIdx + 1];
      setCurrentInning(next.inning);
      setCurrentIsTop(next.isTop);
      setActivePaIndex(0);
      setExpanded({});
      setPitchHover(null);
    }
  };

  // Close on ESC, arrow key navigation
  useEffect(() => {
    const handleKey = e => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && hasPrev) goToPrev();
      if (e.key === "ArrowRight" && hasNext) goToNext();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, hasPrev, hasNext, currentHalfIdx]);

  // Compute score at start of this half-inning from linescore data.
  // Hooks must run unconditionally, so this stays above the early returns.
  const preHalfScore = useMemo(() => {
    if (!data?.innings) return null;
    let away = 0, home = 0;
    for (const inn of data.innings) {
      if (inn.num < currentInning) {
        away += inn.away?.runs || 0;
        home += inn.home?.runs || 0;
      } else if (inn.num === currentInning && !currentIsTop) {
        // Bottom of inning: add top-half runs
        away += inn.away?.runs || 0;
      }
    }
    return { away, home };
  }, [data?.innings, currentInning, currentIsTop]);

  if (!data || !data.plays) return null;

  const half = data.plays.find(p => p.inning === currentInning && p.top === currentIsTop);
  if (!half || !half.pas || half.pas.length === 0) return null;

  const teamBatting = currentIsTop ? data.away_team : data.home_team;
  const teamPitching = currentIsTop ? data.home_team : data.away_team;

  // Compute inning stats
  const inningStats = computeInningStats(half.pas, pitcherId);

  const toggleExpand = (i) => {
    setExpanded(prev => ({ ...prev, [i]: !prev[i] }));
    setActivePaIndex(i);
  };

  const handlePAClick = (i) => {
    setActivePaIndex(i);
    setExpanded(prev => ({ ...prev, [i]: !prev[i] }));
  };

  const activePa = half.pas[activePaIndex];

  // Format prev/next labels
  const prevLabel = hasPrev ? `← ${ordinal(pitcherHalfInnings[currentHalfIdx - 1].inning)}` : null;
  const nextLabel = hasNext ? `${ordinal(pitcherHalfInnings[currentHalfIdx + 1].inning)} →` : null;

  return (
    <div className="pbp-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pbp-panel">
        <div className="pbp-header">
          {/* Left arrow / prev inning */}
          <button className="pbp-nav-btn" onClick={goToPrev} disabled={!hasPrev} title={hasPrev ? `Go to ${ordinal(pitcherHalfInnings[currentHalfIdx - 1].inning)}` : ""}>
            {prevLabel || ""}
          </button>

          <div className="pbp-title-block">
            <div className="pbp-title">
              {currentIsTop ? "Top" : "Bottom"} {ordinal(currentInning)} — {half.pas[0]?.pitcher || "Unknown"} vs. {displayAbbrev(teamPitching)}
            </div>
            <div className="pbp-inning-stats">
              {inningStats.ip} IP · {inningStats.runs} R · {inningStats.hits} H · {inningStats.bbs} BB · {inningStats.ks} K · {inningStats.hrs} HR · {inningStats.pitches} P
            </div>
          </div>

          {/* Right arrow / next inning */}
          <button className="pbp-nav-btn" onClick={goToNext} disabled={!hasNext} title={hasNext ? `Go to ${ordinal(pitcherHalfInnings[currentHalfIdx + 1].inning)}` : ""}>
            {nextLabel || ""}
          </button>
        </div>

        <div className="pbp-content">
          <div className="pbp-left-panel">
            {half.pas.map((pa, i) => {
              const isPitcherPA = pitcherId && pa.pitcher_id === pitcherId;
              const isExpanded = expanded[i];
              const isActive = activePaIndex === i;
              const isK = isStrikeoutResult(pa.result);
              const realPitches = pa.pitches?.filter(p => !p.is_action) || [];
              const lastPitch = realPitches.length > 0 ? realPitches[realPitches.length - 1] : null;

              // Use tooltip result system for consistent colors
              const paResult = getTooltipResult({}, {
                desc: lastPitch?.desc || "",
                paResult: pa.result,
                isLastPitch: true,
                launchAngle: pa.launch_angle,
              });
              const resultLabel = paResult.label;
              const resultColor = paResult.color;

              // Detect total runs scored on this PA by comparing scores
              let runsScored = 0;
              if (pa.away_score != null && pa.home_score != null) {
                const curTotal = pa.away_score + pa.home_score;
                if (i > 0 && half.pas[i - 1].away_score != null && half.pas[i - 1].home_score != null) {
                  runsScored = curTotal - (half.pas[i - 1].away_score + half.pas[i - 1].home_score);
                } else if (i === 0 && preHalfScore) {
                  runsScored = curTotal - (preHalfScore.away + preHalfScore.home);
                }
              }

              // Extract mid-AB action events that scored or are notable
              const midAbActions = (pa.pitches || []).filter(p => p.is_action && (p.scored || ["Wild Pitch", "Caught Stealing", "Pickoff CS", "Passed Ball", "Balk"].some(e => (p.event_type || "").toLowerCase().includes(e.toLowerCase()) || (p.desc || "").toLowerCase().includes(e.toLowerCase()))));
              const actionRuns = midAbActions.filter(a => a.scored).reduce((sum) => sum + 1, 0);
              const paResultRuns = Math.max(0, runsScored - actionRuns);

              // Compute score after mid-AB actions
              const midAbAwayScore = pa.away_score != null ? pa.away_score - (currentIsTop ? paResultRuns : 0) : null;
              const midAbHomeScore = pa.home_score != null ? pa.home_score - (currentIsTop ? 0 : paResultRuns) : null;

              const renderScoreLine = (runs, awayScore, homeScore) => {
                if (runs <= 0 || awayScore == null) return null;
                const awayDisp = displayAbbrev(data.away_team) || data.away_team;
                const homeDisp = displayAbbrev(data.home_team) || data.home_team;
                const battingTeam = currentIsTop ? data.away_team : data.home_team;
                const awayScored = data.away_team === battingTeam;
                const homeScored = data.home_team === battingTeam;
                return (
                  <span className="pbp-pa-rbi">
                    <span style={{ color: "#FF5EDC" }}>- {runs} Run{runs !== 1 ? "s" : ""} score{runs === 1 ? "s" : ""}.{" "}</span>
                    <span>
                      <span style={{ color: awayScored ? "#FFC46A" : "#E0E2EC", fontWeight: awayScored ? 700 : 600 }}>{awayDisp} {awayScore}</span>
                      <span style={{ color: "rgba(180,184,210,0.6)" }}> - </span>
                      <span style={{ color: homeScored ? "#FFC46A" : "#E0E2EC", fontWeight: homeScored ? 700 : 600 }}>{homeDisp} {homeScore}</span>
                    </span>
                  </span>
                );
              };

              return (
                <div key={i}>
                  {i > 0 && half.pas[i].pitcher !== half.pas[i - 1].pitcher && (
                    <div className="pbp-relief-row">
                      {half.pas[i].pitcher} relieved {half.pas[i - 1].pitcher}
                    </div>
                  )}
                  {/* Mid-AB action events (wild pitch, steal, etc.) — their own
                      italic lines between the previous PA and this one. */}
                  {midAbActions.map((action, ai) => (
                    <div key={`mid-action-${ai}`} className="pbp-midab-row" style={{ color: action.scored ? "#FF5EDC" : "rgba(180,184,210,0.75)" }}>
                      {action.desc}
                    </div>
                  ))}
                  {actionRuns > 0 && midAbAwayScore != null && (
                    <div className="pbp-midab-row">
                      {renderScoreLine(actionRuns, midAbAwayScore, midAbHomeScore)}
                    </div>
                  )}
                  <div className={`pbp-pa${isPitcherPA ? " pbp-pa-hl" : ""}${isActive ? " pbp-pa-active" : ""}`} onClick={() => handlePAClick(i)} style={{ cursor: "pointer" }}>
                    {/* Row 1: Batter name (+ runs scored on PA result) left, Result right */}
                    <div className="pbp-pa-top">
                      <div className="pbp-pa-left">
                        <span className="pbp-pa-batter">{pa.batter}</span>
                        {paResultRuns > 0 && renderScoreLine(paResultRuns, pa.away_score, pa.home_score)}
                      </div>
                      <span className="pbp-pa-result" style={{ color: resultColor }}>
                        {paResult.isError && paResult.errorOutType
                          ? <>{paResult.errorOutType} <span style={{ color: "#ffc277" }}>(Error)</span></>
                          : resultLabel}
                        {paResult.isK && (
                          paResult.isCalledStrikeThree
                            ? <span style={{ marginLeft: 3 }}>(<span style={{ display: "inline-block", transform: "scaleX(-1)" }}>K</span>)</span>
                            : <span style={{ marginLeft: 3 }}>(K)</span>
                        )}
                      </span>
                    </div>


                    {/* Row 2: vs Pitcher left, MPH + Pitch Type right (all at-bats) */}
                    <div className="pbp-pa-meta-row">
                      <span className="pbp-pa-vs">vs {pa.pitcher}</span>
                      <span className="pbp-pa-secondary">
                        {lastPitch ? (
                          <>
                            <span style={{ fontWeight: 700, color: "#E0E2EC" }}>{lastPitch.speed ? Number(lastPitch.speed).toFixed(1) : ""}</span>
                            {lastPitch.type && (
                              <span style={{ color: PITCH_COLORS[lastPitch.type] || "#888", fontWeight: 600, marginLeft: 4 }}>{lastPitch.type}</span>
                            )}
                          </>
                        ) : null}
                      </span>
                    </div>

                    {/* Row 3: Play description — sentence-level coloring (CI/error: yellow base + walk-orange "reaches on"; "scores" sentences pink+bold). */}
                    {pa.description && (() => {
                      const isCIErr = paResult.isError || isCIOrErrorEvent(pa.result);
                      const _r = (pa.result || "").toLowerCase().replace(/\s+/g, "_");
                      const _isHit = _r === "single" || _r === "double" || _r === "triple";
                      const isHitWithOut = _isHit && /\bout at\b|\bout advancing\b|\bthrown out\b/i.test(pa.description);
                      const baseColor = isCIErr ? "#feffa3" : resultColor;
                      return (
                        <div className="pbp-pa-desc" style={{ color: baseColor }}>
                          {getPADescriptionSpans(pa.description, { isCIOrError: isCIErr, isHitWithOut }).map((s, idx) => (
                            <span key={idx} style={s.style || undefined}>{s.text}</span>
                          ))}
                        </div>
                      );
                    })()}

                    {/* Row 4: EV/LA + batted ball type (after description, for balls in play) */}
                    {!isK && pa.launch_speed != null && (
                      <div className="pbp-pa-ev-la">
                        {pa.launch_speed.toFixed(1)} EV{pa.launch_angle != null ? ` · ${pa.launch_angle.toFixed(0)}° LA` : ""}
                        {(() => {
                          const bbType = classifyBattedBall(pa.launch_speed, pa.launch_angle);
                          const bbColor = bbType ? BATTED_BALL_COLORS[bbType] : null;
                          return bbType ? <span style={{ color: bbColor, fontStyle: "normal", fontWeight: 600, marginLeft: 6 }}>{bbType}</span> : null;
                        })()}
                      </div>
                    )}

                    {/* Expanded pitch-by-pitch */}
                    {isExpanded && pa.pitches && pa.pitches.length > 0 && (
                      <div className="pbp-pitches">
                        <div className="pbp-pitch-hdr">
                          <span className="pbp-ph-num">#</span>
                          <span className="pbp-ph-count">CT.</span>
                          <span className="pbp-ph-speed">MPH</span>
                          <span className="pbp-ph-type">TYPE</span>
                          <span className="pbp-ph-desc">RESULT</span>
                        </div>
                        {(() => {
                          const realAll = pa.pitches.filter(x => !x.is_action);
                          const lastReal = realAll[realAll.length - 1];
                          return buildExpandedPitchItems(pa.pitches).map((p, j) => {
                            if (p.is_action) {
                              // Steals, pickoffs, balks, etc. — their own row.
                              const actionColor = (p.is_error || isWildPitchOrPassedBall(p)) ? "#feffa3" : p.scored ? "#FF5EDC" : "rgba(180,184,210,0.7)";
                              return (
                                <div key={j} className="pbp-pitch-row pbp-action-row">
                                  <span className="pbp-action-desc" style={{ color: actionColor }}>{p.desc}</span>
                                </div>
                              );
                            }
                            const color = PITCH_COLORS[p.type] || PITCH_COLORS[TYPE_TO_NAME[p.type]] || "#888";
                            const mph = p.speed != null ? Number(p.speed).toFixed(1) : "—";
                            // Color the pitch description using tooltip result colors
                            const isLastPitch = lastReal != null && p.num === lastReal.num;
                            const pitchResult = getTooltipResult(p, {
                              desc: p.desc,
                              paResult: isLastPitch ? pa.result : null,
                              isLastPitch,
                              launchAngle: isLastPitch ? pa.launch_angle : null,
                            });
                            const ia = p.inlineAction;
                            const iaColor = ia ? ((ia.is_error || isWildPitchOrPassedBall(ia)) ? "#feffa3" : ia.scored ? "#FF5EDC" : "rgba(180,184,210,0.7)") : null;
                            return (
                              <div key={j} className="pbp-pitch-row">
                                <span className="pbp-ph-num">{p.num}</span>
                                <span className="pbp-ph-count">{p.count}</span>
                                <span className="pbp-ph-speed">{mph}</span>
                                <span className="pbp-ph-type" style={{ color }}>
                                  {p.type}
                                </span>
                                <span className="pbp-ph-desc" style={{ color: pitchResult.color }}>
                                  {p.desc}
                                  {ia && <span style={{ color: iaColor, fontStyle: "italic" }}> · {ia.desc}</span>}
                                </span>
                              </div>
                            );
                          });
                        })()}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pbp-sz-panel" style={{ position: "sticky", top: 12, alignSelf: "flex-start" }}>
            {activePa && activePa.pitches && activePa.pitches.length > 0 && (() => {
              const activeRealPitches = activePa.pitches.filter(p => !p.is_action);
              const activeLastPitch = activeRealPitches.length > 0 ? activeRealPitches[activeRealPitches.length - 1] : null;
              return (
              <>
                <StrikeZonePBP
                  key={`${currentInning}-${currentIsTop}-${activePaIndex}`}
                  pitches={activeRealPitches}
                  pitchColors={PITCH_COLORS}
                  result={activePa.result}
                  resultLabel={formatPaResult(activePa.result, activePa.trajectory)}
                  batter={activePa.batter}
                  pitcher={activePa.pitcher}
                  outs={activePa.outs || 0}
                  stand={activePa.stand || "R"}
                  launchSpeed={activePa.launch_speed}
                  launchAngle={activePa.launch_angle}
                  battedBallType={classifyBattedBall(activePa.launch_speed, activePa.launch_angle)}
                  rbi={activePa.rbi || 0}
                  isStrikeoutResult={isStrikeoutResult(activePa.result)}
                  lastPitch={activeLastPitch}
                  onPitchHover={setPitchHover}
                  homeScore={activePa.home_score}
                  awayScore={activePa.away_score}
                  awayTeam={data.away_team}
                  homeTeam={data.home_team}
                  pitcherTeam={teamPitching}
                  isMobile={isMobile}
                />
                {pitchHover && (() => {
                  const hp = pitchHover.pitch;
                  const hpColor = PITCH_COLORS[hp.type] || "#888";
                  const isLastPitch = activeRealPitches.indexOf(hp) === activeRealPitches.length - 1;
                  const result = getTooltipResult(hp, {
                    desc: hp.desc,
                    paResult: activePa.result,
                    isLastPitch,
                    launchAngle: isLastPitch ? activePa.launch_angle : null,
                  });

                  const isBIP = isLastPitch && hp.launch_speed != null && hp.launch_angle != null &&
                    (hp.desc || "").toLowerCase().includes("in play");
                  const bbTag = isBIP ? classifyBattedBall(hp.launch_speed, hp.launch_angle) : null;
                  const bbColor = bbTag ? (BATTED_BALL_COLORS[bbTag] || "rgba(180,184,210,0.7)") : null;

                  // Parse count into balls/strikes
                  const countParts = (hp.count || "0-0").split("-");
                  const balls = countParts[0] || "0";
                  const strikes = countParts[1] || "0";

                  // Runs scored as a result of this PA's final pitch. Excludes
                  // mid-AB action runs (wild pitch, etc.) so the line reflects
                  // the pitch-result only.
                  let paResultRuns = 0;
                  if (isLastPitch && activePa.away_score != null && activePa.home_score != null) {
                    const curTotal = activePa.away_score + activePa.home_score;
                    let prevTotal = null;
                    if (activePaIndex > 0 && half.pas[activePaIndex - 1].away_score != null && half.pas[activePaIndex - 1].home_score != null) {
                      prevTotal = half.pas[activePaIndex - 1].away_score + half.pas[activePaIndex - 1].home_score;
                    } else if (activePaIndex === 0 && preHalfScore) {
                      prevTotal = preHalfScore.away + preHalfScore.home;
                    }
                    if (prevTotal != null) {
                      const totalRuns = Math.max(0, curTotal - prevTotal);
                      const actionRuns = (activePa.pitches || []).filter(p => p.is_action && p.scored).length;
                      paResultRuns = Math.max(0, totalRuns - actionRuns);
                    }
                  }

                  return (
                    <div className="pitch-tooltip" style={(() => {
                      const tx = pitchHover.clientX + 16;
                      const ty = pitchHover.clientY - 16;
                      const leftVp = tx + 300 > window.innerWidth ? pitchHover.clientX - 310 : tx;
                      const topVp = ty < 10 ? pitchHover.clientY + 16 : (ty + 280 > window.innerHeight ? pitchHover.clientY - 280 : ty);
                      return {
                        position: "fixed",
                        // Compensate for body { zoom: 1.25 } on desktop.
                        left: vpToZoomCoord(leftVp),
                        top: vpToZoomCoord(topVp),
                        transform: "none",
                        minWidth: 280,
                        zIndex: 1000,
                        pointerEvents: "none",
                      };
                    })()}>
                      {/* Header row 1: Pitch type + mph (left) | Result (right) */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: isBIP ? 0 : 4 }}>
                        <div style={{ whiteSpace: "nowrap" }}>
                          <span style={{ color: hpColor, fontWeight: 600 }}>{hp.type}</span>
                          <span style={{ marginLeft: 6, color: "#e0e2ec" }}>
                            {hp.speed ? Number(hp.speed).toFixed(1) + " mph" : ""}
                          </span>
                        </div>
                        <div style={{ whiteSpace: "nowrap", color: result.color, fontWeight: 600, marginLeft: 12 }}>
                          {result.isError && result.errorOutType
                            ? <>{result.errorOutType} <span style={{ color: "#ffc277" }}>(Error)</span></>
                            : result.label}
                          {result.isK && (
                            result.isCalledStrikeThree
                              ? <span style={{ marginLeft: 3 }}>(<span style={{ display: "inline-block", transform: "scaleX(-1)" }}>K</span>)</span>
                              : <span style={{ marginLeft: 3 }}>(K)</span>
                          )}
                        </div>
                      </div>
                      {/* Header row 2 (BIP only): EV/LA (left) | Batted ball tag (right) */}
                      {isBIP && (
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                          <div style={{ fontSize: "0.85em", color: "#e0e2ec" }}>
                            {hp.launch_speed.toFixed(1)} EV · {hp.launch_angle != null ? hp.launch_angle.toFixed(0) + "° LA" : ""}
                          </div>
                          {bbTag && (
                            <div style={{ color: bbColor, fontWeight: 600, fontSize: "0.85em", marginLeft: 12 }}>
                              {bbTag}
                            </div>
                          )}
                        </div>
                      )}

                      {/* vs Batter (left) | Strikeout sub-label (right) — full width above body columns */}
                      <div className="pt-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, fontSize: "0.85em" }}>
                        <span>vs {activePa.batter}</span>
                        {result.isK && result.subLabel && (
                          <span style={{ color: "rgba(180,184,210,0.7)" }}>{result.subLabel}</span>
                        )}
                      </div>

                      {/* Body: text left, strikezone right */}
                      <div style={{ display: "flex", gap: 10 }}>
                        <div style={{ flex: 1 }}>
                          {/* Inning + bases */}
                          <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                            {currentIsTop ? "Top" : "Bot"} {ordinal(currentInning)} | {activePa.outs || 0} Out{(activePa.outs || 0) !== 1 ? "s" : ""}
                          </div>

                          {/* Outs + count */}
                          <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                            {activePa.outs || 0} Outs | {balls}-{strikes}
                          </div>

                          {/* iVB + iHB + Extension */}
                          {hp.pfx_z != null && hp.pfx_x != null && (
                            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                              iVB {hp.pfx_z.toFixed(1)}" · iHB {(-hp.pfx_x).toFixed(1)}"
                              {hp.release_extension != null && ` · Ext ${hp.release_extension.toFixed(1)}ft`}
                            </div>
                          )}
                          {paResultRuns > 0 && (
                            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em", color: "#FF5EDC", fontWeight: 600 }}>
                              {paResultRuns} Run{paResultRuns !== 1 ? "s" : ""}
                            </div>
                          )}
                        </div>

                        {/* RIGHT: Mini Strikezone SVG, aligned to bottom */}
                        {hp.plate_x != null && hp.plate_z != null && (
                          <div style={{ flexShrink: 0, display: "flex", alignItems: "flex-end", paddingTop: 0 }}>
                            <svg width="65" height="94" viewBox="0 0 65 94">
                              <rect x="12" y="8" width="41" height="50" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
                              {[1, 2].map(i => (
                                <line key={`v${i}`} x1={12 + (i * 41) / 3} y1="8" x2={12 + (i * 41) / 3} y2="58" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
                              ))}
                              {[1, 2].map(i => (
                                <line key={`h${i}`} x1="12" y1={8 + (i * 50) / 3} x2="53" y2={8 + (i * 50) / 3} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
                              ))}
                              <polygon points="32.5,78 42,83 42,90 23,90 23,83" fill="rgba(140,145,175,0.22)" stroke="rgba(160,164,190,0.35)" strokeWidth="0.8" />
                              {(() => {
                                const isLeft = (activePa.stand || "R") === "L";
                                const lx = isLeft ? 6 : 59;
                                const letters = isLeft ? ["L", "H", "B"] : ["R", "H", "B"];
                                return letters.map((ch, i) => (
                                  <text key={i} x={lx} y={24 + i * 10} fill="rgba(150,155,185,0.28)" fontSize="7" fontWeight="bold" textAnchor="middle" dominantBaseline="middle" fontFamily="'DM Sans', sans-serif">{ch}</text>
                                ));
                              })()}
                              <circle
                                cx={12 + ((-hp.plate_x + 0.83) / 1.66) * 41}
                                cy={8 + ((3.5 - normalizePlateZ(hp.plate_z, hp.sz_top, hp.sz_bot)) / 2.0) * 50}
                                r="4" fill={hpColor} stroke="rgba(0,0,0,0.4)" strokeWidth="0.8"
                              />
                            </svg>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
