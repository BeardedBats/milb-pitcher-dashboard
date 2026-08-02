import React from "react";
import { PITCH_COLORS, displayTeamAbbrev } from "../constants";
import { getTooltipResult, getPADescriptionSpans, isCIOrErrorEvent, getNotableMidAbActions, buildExpandedPitchItems, isWildPitchOrPassedBall, runsScoredOnPitch, classifyBattedBallFull } from "../utils/pitchFilters";
import { normalizePlateZ } from "../utils/strikezone";
import { vpToZoomCoord } from "../utils/desktopZoom";
import { ordinalInning as ordinal } from "../utils/gamePresentation";
import { isStrikeoutResult } from "../utils/pbpPresentation";
import StrikeZonePBP from "./StrikeZonePBP";

const BATTED_BALL_COLORS = {
  "Barrel": "#ffa3a3", "Solid": "#ffc277", "Burner": "#ffc277",
  "Flare": "#8feaff",
  "Under": "#65ff9c", "Topped": "#65ff9c", "Poor": "#65ff9c",
};

function computeInningStats(pas, pitcherId) {
  let totalPitches = 0, hits = 0, bbs = 0, ks = 0, hrs = 0, runs = 0;
  let outs = 0;
  for (const pa of pas) {
    if (pitcherId && pa.pitcher_id !== pitcherId) continue;
    const r = (pa.result || "").toLowerCase();
    totalPitches += pa.pitches ? pa.pitches.filter(p => !p.is_action).length : 0;
    if (r === "strikeout" || r === "strikeout_double_play") ks++;
    if (r === "walk" || r === "intent_walk") bbs++;
    if (["single", "double", "triple", "home_run"].includes(r)) hits++;
    if (r === "home_run") hrs++;
    if (pa.rbi) runs += pa.rbi;
    if (["strikeout", "field_out", "force_out", "sac_fly", "sac_bunt", "fielders_choice_out"].includes(r)) outs++;
    if (["grounded_into_double_play", "double_play", "strikeout_double_play", "sac_fly_double_play"].includes(r)) outs += 2;
    if (r === "triple_play") outs += 3;
  }
  const ip = (Math.floor(outs / 3) + (outs % 3) / 10).toFixed(1);
  return { ip, hits, bbs, ks, hrs, runs, pitches: totalPitches };
}

// Inline play-by-play view for the pitcher card's "Play-by-Play" metrics tab.
// Mechanically extracted from PitcherCard with no behavior change. The pbp
// active/expanded/hover state still lives in PitcherCard (so the default-active
// PA is chosen when the card loads, not when this tab mounts) and is threaded
// through as explicit props.
export default function PitchPlayByPlaySection({
  pitcherPBP,
  pitcherId,
  linescoreData,
  pbpActivePa,
  setPbpActivePa,
  pbpExpanded,
  setPbpExpanded,
  pbpPitchHover,
  setPbpPitchHover,
}) {
  if (!pitcherPBP) return null;

  // Find the active PA object for the SZ plot
  const [activeSegIdx, activePaIdx] = pbpActivePa.split("-").map(Number);
  const activeSeg = pitcherPBP.segments[activeSegIdx];
  const activePa = activeSeg?.pas[activePaIdx] || null;

  return (
    <div className="card-pbp">
      {pitcherPBP.segments.map((seg, si) => {
        const stats = computeInningStats(seg.allPas, pitcherId);
        return (
          <div key={si} className="card-pbp-segment">
            <div className="card-pbp-inning-header">
              <span className="card-pbp-inning-label">{seg.label}</span>
              <span className="card-pbp-inning-stats" style={{ fontSize: 12, marginLeft: 6 }}>
                {"- "}{stats.ip} IP · {stats.runs} Runs · {stats.hits} Hits · {stats.bbs} BB · {stats.ks} K · {stats.hrs} HR · {stats.pitches} Pitches
              </span>
            </div>
            {seg.pas.map((pa, pi) => {
              const paKey = `${si}-${pi}`;
              const isActive = pbpActivePa === paKey;
              const isExp = pbpExpanded[paKey];
              const isFinalPa = si === pitcherPBP.segments.length - 1 && pi === seg.pas.length - 1;
              const isK = isStrikeoutResult(pa.result);
              const realPitches = pa.pitches?.filter(p => !p.is_action) || [];
              const lastPitch = realPitches.length > 0 ? realPitches[realPitches.length - 1] : null;
              const bbType = !isK ? classifyBattedBallFull(pa.launch_speed, pa.launch_angle) : null;
              const bbColor = bbType ? BATTED_BALL_COLORS[bbType] : null;

              // Use tooltip result system for consistent colors
              const paResult = getTooltipResult({}, {
                desc: lastPitch?.desc || "",
                paResult: pa.result,
                isLastPitch: true,
                launchAngle: pa.launch_angle,
              });
              const resultLabel = paResult.label;
              const resultColor = paResult.color;

              // Detect runs scored by comparing score to previous PA in the full half-inning
              let runsScored = 0;
              if (pa.away_score != null && pa.home_score != null) {
                const curTotal = pa.away_score + pa.home_score;
                const allIdx = seg.allPas.indexOf(pa);
                if (allIdx > 0) {
                  const prev = seg.allPas[allIdx - 1];
                  if (prev.away_score != null && prev.home_score != null) {
                    runsScored = curTotal - (prev.away_score + prev.home_score);
                  }
                } else if (allIdx === 0 && linescoreData?.innings) {
                  // First PA of half-inning: compute pre-inning score
                  let preAway = 0, preHome = 0;
                  for (const inn of linescoreData.innings) {
                    if (inn.num < seg.inning) {
                      preAway += inn.away?.runs || 0;
                      preHome += inn.home?.runs || 0;
                    } else if (inn.num === seg.inning && !seg.isTop) {
                      preAway += inn.away?.runs || 0;
                    }
                  }
                  runsScored = curTotal - (preAway + preHome);
                }
              }

              // Featured pitcher highlight + relief detection (innings
              // now include every PA, not just the featured pitcher's).
              const isFeaturedPa = pa.pitcher_id === pitcherId;
              const prevPa = pi > 0 ? seg.pas[pi - 1] : null;
              const isPitcherChange = prevPa && prevPa.pitcher_id !== pa.pitcher_id;

              // Mid-AB action events (wild pitch, etc.) are rendered as
              // their own italic lines above this PA; their runs are
              // split out of the batter's run line.
              const midAbActions = getNotableMidAbActions(pa);
              const actionRuns = midAbActions.filter(a => a.scored).length;
              const paResultRuns = Math.max(0, runsScored - actionRuns);
              const midAbAwayScore = pa.away_score != null ? pa.away_score - (seg.isTop ? paResultRuns : 0) : null;
              const midAbHomeScore = pa.home_score != null ? pa.home_score - (seg.isTop ? 0 : paResultRuns) : null;

              const renderScoreSpan = (runs, awayScore, homeScore) => {
                if (runs <= 0 || awayScore == null || homeScore == null) return null;
                const awayDisp = displayTeamAbbrev(linescoreData.away_team) || linescoreData.away_team;
                const homeDisp = displayTeamAbbrev(linescoreData.home_team) || linescoreData.home_team;
                const battingTeam = seg.isTop ? linescoreData.away_team : linescoreData.home_team;
                const awayScored = linescoreData.away_team === battingTeam;
                const homeScored = linescoreData.home_team === battingTeam;
                return (
                  <>
                    <span style={{ color: "#FF5EDC" }}>- {runs} Run{runs !== 1 ? "s" : ""} score{runs === 1 ? "s" : ""}.{" "}</span>
                    <span>
                      <span style={{ color: awayScored ? "#FFC46A" : "#E0E2EC", fontWeight: awayScored ? 700 : 600 }}>{awayDisp} {awayScore}</span>
                      <span style={{ color: "rgba(180,184,210,0.6)" }}> - </span>
                      <span style={{ color: homeScored ? "#FFC46A" : "#E0E2EC", fontWeight: homeScored ? 700 : 600 }}>{homeDisp} {homeScore}</span>
                    </span>
                  </>
                );
              };

              const handleClick = () => {
                setPbpActivePa(paKey);
                setPbpPitchHover(null);
                setPbpExpanded(prev => ({ ...prev, [paKey]: !prev[paKey] }));
              };

              return (
                <React.Fragment key={pi}>
                  {isPitcherChange && (
                    <div className="card-pbp-relief">{pa.pitcher} relieved {prevPa.pitcher}</div>
                  )}
                  {midAbActions.map((action, ai) => (
                    <div key={`act-${ai}`} className="card-pbp-midab" style={{ color: action.scored ? "#FF5EDC" : "rgba(180,184,210,0.75)" }}>
                      {action.desc}
                    </div>
                  ))}
                  {actionRuns > 0 && midAbAwayScore != null && (
                    <div className="card-pbp-midab card-pbp-midab-score">{renderScoreSpan(actionRuns, midAbAwayScore, midAbHomeScore)}</div>
                  )}
                <div className="card-pbp-pa-row">
                  {/* Left: PA info (50% width) */}
                  <div className={`card-pbp-pa-card${isActive ? " card-pbp-pa-active" : ""}${isFeaturedPa ? " card-pbp-pa-featured" : " card-pbp-pa-other"}`} onClick={handleClick}>
                    <div className="card-pbp-row1">
                      <div className="card-pbp-left">
                        <span className="card-pbp-batter">{pa.batter}</span>
                        {paResultRuns > 0 && (
                          <span className="card-pbp-rbi">
                            {renderScoreSpan(paResultRuns, pa.away_score, pa.home_score)}
                          </span>
                        )}
                      </div>
                      <span className="card-pbp-result" style={{ color: resultColor }}>
                        {paResult.isError && paResult.errorOutType
                          ? <>{paResult.errorOutType} <span style={{ color: "#ffa3a3" }}>(Error)</span></>
                          : resultLabel}
                        {paResult.isK && (
                          paResult.isCalledStrikeThree
                            ? <span style={{ marginLeft: 3 }}>(<span style={{ display: "inline-block", transform: "scaleX(-1)" }}>K</span>)</span>
                            : <span style={{ marginLeft: 3 }}>(K)</span>
                        )}
                      </span>
                    </div>
                    <div className="card-pbp-row2">
                      <span className="card-pbp-vs">vs {pa.pitcher}</span>
                      <span className="card-pbp-pitch-meta">
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
                    {pa.description && (() => {
                      const isCIErr = paResult.isError || isCIOrErrorEvent(pa.result);
                      const _r = (pa.result || "").toLowerCase().replace(/\s+/g, "_");
                      const _isHit = _r === "single" || _r === "double" || _r === "triple";
                      const isHitWithOut = _isHit && /\bout at\b|\bout advancing\b|\bthrown out\b/i.test(pa.description);
                      const baseColor = isCIErr ? "#feffa3" : resultColor;
                      return (
                        <div className="card-pbp-desc" style={{ color: baseColor }}>
                          {getPADescriptionSpans(pa.description, { isCIOrError: isCIErr, isHitWithOut }).map((s, idx) => (
                            <span key={idx} style={s.style || undefined}>{s.text}</span>
                          ))}
                        </div>
                      );
                    })()}
                    {!isK && pa.launch_speed != null && (
                      <div className="card-pbp-evla">
                        {pa.launch_speed.toFixed(1)} EV{pa.launch_angle != null ? ` · ${pa.launch_angle.toFixed(0)}° LA` : ""}
                        {bbType && <span style={{ color: bbColor, fontStyle: "normal", fontWeight: 600, marginLeft: 6 }}>{bbType}</span>}
                      </div>
                    )}
                    {/* Expanded pitch-by-pitch table */}
                    {isExp && pa.pitches?.length > 0 && (
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
                              const actionColor = (p.is_error || isWildPitchOrPassedBall(p)) ? "#ffa3a3" : p.scored ? "#FF5EDC" : "rgba(180,184,210,0.7)";
                              return (
                                <div key={j} className="pbp-pitch-row pbp-action-row">
                                  <span className="pbp-action-desc" style={{ color: actionColor }}>{p.desc}</span>
                                </div>
                              );
                            }
                            const pColor = PITCH_COLORS[p.type] || "#888";
                            const isLastPitch = lastReal != null && p.num === lastReal.num;
                            const pResult = getTooltipResult(p, {
                              desc: p.desc,
                              paResult: isLastPitch ? pa.result : null,
                              isLastPitch,
                              launchAngle: isLastPitch ? pa.launch_angle : null,
                            });
                            const ia = p.inlineAction;
                            const iaColor = ia ? ((ia.is_error || isWildPitchOrPassedBall(ia)) ? "#ffa3a3" : ia.scored ? "#FF5EDC" : "rgba(180,184,210,0.7)") : null;
                            return (
                              <div key={j} className="pbp-pitch-row">
                                <span className="pbp-ph-num">{p.num}</span>
                                <span className="pbp-ph-count">{p.count}</span>
                                <span className="pbp-ph-speed">{p.speed != null ? Number(p.speed).toFixed(1) : "—"}</span>
                                <span className="pbp-ph-type" style={{ color: pColor }}>{p.type}</span>
                                <span className="pbp-ph-desc" style={{ color: pResult.color }}>
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
                  {/* Right: SZ plot (only next to active PA) */}
                  {isActive && realPitches.length > 0 && (
                    <div className="card-pbp-sz" style={{ position: "absolute", top: isFinalPa ? "auto" : 0, bottom: isFinalPa ? 0 : "auto", left: 689, zIndex: 10 }}>
                      <StrikeZonePBP
                        pitches={realPitches}
                        pitchColors={PITCH_COLORS}
                        result={pa.result}
                        resultLabel={resultLabel}
                        batter={pa.batter}
                        pitcher={pa.pitcher}
                        outs={pa.outs || 0}
                        stand={pa.stand || "R"}
                        launchSpeed={pa.launch_speed}
                        launchAngle={pa.launch_angle}
                        battedBallType={bbType}
                        rbi={pa.rbi || 0}
                        isStrikeoutResult={isK}
                        lastPitch={lastPitch}
                        onPitchHover={setPbpPitchHover}
                      />
                      {pbpPitchHover && (() => {
                        const hp = pbpPitchHover.pitch;
                        const hpColor = PITCH_COLORS[hp.type] || "#888";
                        const isLastPitch = realPitches.indexOf(hp) === realPitches.length - 1;
                        const result = getTooltipResult(hp, {
                          desc: hp.desc,
                          paResult: pa.result,
                          isLastPitch,
                          launchAngle: isLastPitch ? pa.launch_angle : null,
                        });

                        const isBIP = isLastPitch && hp.launch_speed != null && hp.launch_angle != null &&
                          (hp.desc || "").toLowerCase().includes("in play");
                        const bbTag2 = isBIP ? classifyBattedBallFull(hp.launch_speed, hp.launch_angle) : null;
                        const bbColor2 = bbTag2 ? (BATTED_BALL_COLORS[bbTag2] || "rgba(180,184,210,0.7)") : null;

                        const countParts = (hp.count || "0-0").split("-");
                        const balls = countParts[0] || "0";
                        const strikes = countParts[1] || "0";

                        return (
                          <div className="pitch-tooltip" style={(() => {
                            const tx = pbpPitchHover.clientX + 16;
                            const ty = pbpPitchHover.clientY - 16;
                            const leftVp = tx + 300 > window.innerWidth ? pbpPitchHover.clientX - 310 : tx;
                            const topVp = ty < 10 ? pbpPitchHover.clientY + 16 : (ty + 280 > window.innerHeight ? pbpPitchHover.clientY - 280 : ty);
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
                                  ? <>{result.errorOutType} <span style={{ color: "#ffa3a3" }}>(Error)</span></>
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
                                {bbTag2 && (
                                  <div style={{ color: bbColor2, fontWeight: 600, fontSize: "0.85em", marginLeft: 12 }}>
                                    {bbTag2}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* vs Batter (left) | Strikeout sub-label (right) — full width above body columns */}
                            <div className="pt-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, fontSize: "0.85em" }}>
                              <span>vs {pa.batter}</span>
                              {result.isK && result.subLabel && (
                                <span style={{ color: "rgba(180,184,210,0.7)" }}>{result.subLabel}</span>
                              )}
                            </div>

                            {/* Body: text left, strikezone right */}
                            <div style={{ display: "flex", gap: 10 }}>
                              <div style={{ flex: 1 }}>
                                <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                                  {seg.isTop ? "Top" : "Bot"} {ordinal(seg.inning)} | {pa.outs || 0} Out{(pa.outs || 0) !== 1 ? "s" : ""}
                                </div>
                                <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                                  {pa.outs || 0} Outs | {balls}-{strikes}
                                </div>
                                {hp.pfx_z != null && hp.pfx_x != null && (
                                  <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
                                    iVB {hp.pfx_z.toFixed(1)}" · iHB {(-hp.pfx_x).toFixed(1)}"
                                    {hp.release_extension != null && ` · Ext ${hp.release_extension.toFixed(1)}ft`}
                                  </div>
                                )}
                                {runsScoredOnPitch(hp) > 0 && (
                                  <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em", color: "#FF5EDC", fontWeight: 600 }}>
                                    {runsScoredOnPitch(hp)} Run{runsScoredOnPitch(hp) !== 1 ? "s" : ""}
                                  </div>
                                )}
                              </div>
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
                                      const isLeft = (pa.stand || "R") === "L";
                                      const lx = isLeft ? 6 : 59;
                                      const letters = isLeft ? ["L", "H", "B"] : ["R", "H", "B"];
                                      return letters.map((ch, idx) => (
                                        <text key={idx} x={lx} y={24 + idx * 10} fill="rgba(150,155,185,0.28)" fontSize="7" fontWeight="bold" textAnchor="middle" dominantBaseline="middle" fontFamily="'DM Sans', sans-serif">{ch}</text>
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
                    </div>
                  )}
                </div>
                </React.Fragment>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
