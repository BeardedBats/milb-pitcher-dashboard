import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { PITCH_COLORS, BATTED_BALL_COLORS } from "../constants";
import { isRunScored, getTooltipResult, runsScoredOnPitch } from "../utils/pitchFilters";
import { classifyBattedBall, hexToRgba } from "../utils/formatting";
import { vpToZoomCoord, getDesktopZoom } from "../utils/desktopZoom";
import { normalizePlateZ, DISPLAY_SZ_TOP, DISPLAY_SZ_BOT } from "../utils/strikezone";
import { ordinalInning as ordinal, formatBaseState } from "../utils/gamePresentation";

const DOT_R = 4.5;
const DOT_PAD = 3;
const GLOW_R = 12;
const LABEL_COLOR = "#FFFFF0";

export default function VelocityTrend({ pitches, isMobile }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const dotsRef = useRef([]);
  const [hover, setHover] = useState(null);
  const [dims, setDims] = useState({ w: 0 });
  const [mobileTooltipVis, setMobileTooltipVis] = useState(null);

  // Process pitches: sequential ordering, inning boundaries, type stats
  const { ordered, inningBounds, typeStats, pitchTypes } = useMemo(() => {
    if (!pitches || pitches.length === 0)
      return { ordered: [], inningBounds: [], typeStats: {}, pitchTypes: [] };

    // Sort pitches by at_bat_number then pitch_number, or fallback to array order
    const sorted = [...pitches].sort((a, b) => {
      if (a.at_bat_number != null && b.at_bat_number != null) {
        if (a.at_bat_number !== b.at_bat_number) return a.at_bat_number - b.at_bat_number;
        return (a.pitch_number || 0) - (b.pitch_number || 0);
      }
      return 0;
    });

    // Assign sequential pitch numbers and detect inning boundaries
    const bounds = [];
    let lastInning = null;
    const ord = sorted.map((p, i) => {
      const inn = p.inning;
      if (inn != null && inn !== lastInning) {
        bounds.push({ pitchIdx: i + 1, inning: inn });
        lastInning = inn;
      }
      return { ...p, _seqNum: i + 1 };
    });

    // Compute per-type stats
    const stats = {};
    for (const p of ord) {
      const name = p.pitch_name;
      if (!name || p.release_speed == null) continue;
      if (!stats[name]) stats[name] = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
      const s = stats[name];
      s.min = Math.min(s.min, p.release_speed);
      s.max = Math.max(s.max, p.release_speed);
      s.sum += p.release_speed;
      s.count++;
    }
    for (const k of Object.keys(stats)) stats[k].avg = stats[k].sum / stats[k].count;

    // Sort pitch types by avg velo descending
    const types = Object.keys(stats).sort((a, b) => stats[b].avg - stats[a].avg);

    return { ordered: ord, inningBounds: bounds, typeStats: stats, pitchTypes: types };
  }, [pitches]);

  // Measure container width
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setDims((d) => ({ ...d, w }));
      }
    });
    ro.observe(el);
    setDims((d) => ({ ...d, w: el.offsetWidth }));
    return () => ro.disconnect();
  }, []);

  // Compute dynamic lane heights: 4 pitches = baseline (99px), scale linearly
  const BASE_LANE_H = 99; // height when a pitch type has exactly 4 pitches
  const PITCHES_BASELINE = 4;
  const MIN_LANE_H = 50;
  const perPitchH = BASE_LANE_H / PITCHES_BASELINE;

  const laneHeights = useMemo(() => {
    return pitchTypes.map(type => {
      const count = typeStats[type]?.count || 1;
      return Math.max(MIN_LANE_H, Math.round(perPitchH * count));
    });
  }, [pitchTypes, typeStats]);

  const PAD_TOP = 24, PAD_BOTTOM = 40;
  const totalH = PAD_TOP + PAD_BOTTOM + laneHeights.reduce((a, b) => a + b, 0);

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dims.w === 0 || ordered.length === 0 || pitchTypes.length === 0) return;

    const W = dims.w;
    const H = totalH;
    // Compensate for body { zoom: 1.25 } on desktop — see VelocityTrendV2.
    const dpr = (window.devicePixelRatio || 1) * getDesktopZoom();
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const PAD = { top: PAD_TOP, bottom: PAD_BOTTOM, left: 100, right: 60 };
    const plotW = W - PAD.left - PAD.right;
    const laneInnerPad = 6;

    ctx.fillStyle = "#252840";
    ctx.fillRect(0, 0, W, H);

    const totalPitches = ordered.length;
    const toX = (pn) => PAD.left + ((pn - 1) / Math.max(totalPitches - 1, 1)) * plotW;

    // Compute lane geometry with per-type dynamic heights
    let cumulativeY = PAD.top;
    const laneInfo = pitchTypes.map((type, ti) => {
      const s = typeStats[type];
      const thisLaneH = laneHeights[ti];
      const laneTop = cumulativeY;
      const innerTop = laneTop + laneInnerPad;
      const innerH = thisLaneH - laneInnerPad * 2;
      const range = s.max - s.min || 1;
      const toY = (velo) => innerTop + ((s.max - velo) / range) * innerH;
      cumulativeY += thisLaneH;
      return { type, ti, laneTop, laneH: thisLaneH, innerTop, innerH, toY, s };
    });

    const containerTop = laneInfo[0].innerTop;
    const lastLane = laneInfo[laneInfo.length - 1];
    const containerBot = lastLane.innerTop + lastLane.innerH;

    // Vertical barriers for dot x-clamping
    const barriers = [PAD.left, PAD.left + plotW];
    for (const bd of inningBounds) {
      if (bd.pitchIdx > 1) barriers.push(toX(bd.pitchIdx) - 2);
    }
    barriers.sort((a, b) => a - b);

    function adjustDotX(rawX) {
      let cx = rawX + DOT_R;
      for (const bx of barriers) {
        if (cx - DOT_R < bx + DOT_PAD && cx + DOT_R > bx - DOT_PAD) {
          cx = bx + DOT_PAD + DOT_R;
        }
      }
      if (cx + DOT_R + DOT_PAD > PAD.left + plotW) {
        cx = PAD.left + plotW - DOT_PAD - DOT_R;
      }
      return cx;
    }

    // Alternating inning panels
    for (let i = 0; i < inningBounds.length; i++) {
      const bd = inningBounds[i];
      const sx = bd.pitchIdx <= 1 ? PAD.left : toX(bd.pitchIdx) - 2;
      const ex =
        i + 1 < inningBounds.length
          ? toX(inningBounds[i + 1].pitchIdx) - 2
          : PAD.left + plotW;
      if (i % 2 === 1) {
        ctx.fillStyle = "rgba(255,255,255,0.02)";
        ctx.fillRect(sx, containerTop, ex - sx, containerBot - containerTop);
      }
    }

    // Draw lanes and dots
    const dots = [];

    laneInfo.forEach(({ type, laneTop, laneH: thisLaneH, innerTop, innerH, toY, s }) => {
      const color = PITCH_COLORS[type] || "#888";

      // Range band
      ctx.fillStyle = hexToRgba(color, 0.08);
      ctx.fillRect(PAD.left, innerTop, plotW, innerH);

      // Left label
      ctx.fillStyle = color;
      ctx.font = "bold 12px 'DM Sans', sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(type, PAD.left - 10, laneTop + thisLaneH / 2);

      // Right labels: Max / Avg / Min
      const rx = PAD.left + plotW + 8;
      ctx.font = "bold 10px 'DM Sans', sans-serif";
      ctx.textAlign = "left";
      ctx.fillStyle = color;
      ctx.fillText(s.max.toFixed(1), rx, innerTop + 6);
      ctx.globalAlpha = 0.5;
      ctx.fillText(s.avg.toFixed(1), rx, laneTop + thisLaneH / 2);
      ctx.globalAlpha = 1;
      ctx.fillText(s.min.toFixed(1), rx, innerTop + innerH - 4);

      // Dots
      const typePitches = ordered.filter((p) => p.pitch_name === type && p.release_speed != null);
      for (const p of typePitches) {
        const rawX = toX(p._seqNum);
        const cx = adjustDotX(rawX);
        const rawY = toY(p.release_speed);
        const cy = Math.max(
          innerTop + DOT_R + DOT_PAD,
          Math.min(innerTop + innerH - DOT_R - DOT_PAD, rawY)
        );

        // Glow for run-scored pitches (pitch-type color)
        if (isRunScored(p)) {
          const hex = PITCH_COLORS[p.pitch_name] || "#888888";
          const r = parseInt(hex.slice(1, 3), 16);
          const g = parseInt(hex.slice(3, 5), 16);
          const b = parseInt(hex.slice(5, 7), 16);
          ctx.save();
          const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, GLOW_R);
          grad.addColorStop(0, `rgba(${r},${g},${b},0.6)`);
          grad.addColorStop(0.45, `rgba(${r},${g},${b},0.2)`);
          grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(cx, cy, GLOW_R, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        ctx.fillStyle = color;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(cx, cy, DOT_R, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        dots.push({ x: cx, y: cy, pitch: p });
      }
    });

    // Inning dividers
    for (const bd of inningBounds) {
      if (bd.pitchIdx <= 1) continue;
      const x = toX(bd.pitchIdx) - 2;
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, containerTop);
      ctx.lineTo(x, containerBot);
      ctx.stroke();
      ctx.restore();
    }

    // X-axis: pitch numbers at intervals of 15
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = "12px 'DM Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 15; i <= totalPitches; i += 15) {
      ctx.fillText(i, toX(i), containerBot + 8);
    }

    dotsRef.current = dots;
  }, [ordered, pitchTypes, typeStats, inningBounds, dims, laneHeights, totalH]);

  // Hover handling
  const handleMouseMove = useCallback(
    (e) => {
      if (isMobile) return; // mobile uses tap instead
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (dims.w / rect.width);
      const my = (e.clientY - rect.top) * (totalH / rect.height);
      const dots = dotsRef.current;
      let near = null;
      let md = 18;
      for (const d of dots) {
        const dist = Math.sqrt((mx - d.x) ** 2 + (my - d.y) ** 2);
        if (dist < md) {
          md = dist;
          near = d;
        }
      }
      if (near) {
        setHover({ pitch: near.pitch, x: e.clientX, y: e.clientY });
      } else {
        setHover(null);
      }
      canvas.style.cursor = near ? "pointer" : "default";
    },
    [dims, totalH, isMobile]
  );

  const handleMouseLeave = useCallback(() => {
    if (!isMobile) setHover(null);
  }, [isMobile]);

  const handleCanvasClick = useCallback((e) => {
    if (!isMobile) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (dims.w / rect.width);
    const my = (e.clientY - rect.top) * (totalH / rect.height);
    const dots = dotsRef.current;
    let near = null, md = 18;
    for (const d of dots) {
      const dist = Math.sqrt((mx - d.x) ** 2 + (my - d.y) ** 2);
      if (dist < md) { md = dist; near = d; }
    }

    if (near) {
      if (mobileTooltipVis && mobileTooltipVis.pitch === near.pitch) {
        setMobileTooltipVis(null);
      } else {
        setMobileTooltipVis({ pitch: near.pitch, x: e.clientX, y: e.clientY });
      }
    } else {
      setMobileTooltipVis(null);
    }
  }, [isMobile, mobileTooltipVis, dims, totalH]);

  const handleTapElsewhere = useCallback((e) => {
    if (isMobile && mobileTooltipVis && !e.target.closest(".pitch-tooltip")) {
      setMobileTooltipVis(null);
    }
  }, [isMobile, mobileTooltipVis]);

  if (!pitches || pitches.length === 0 || pitchTypes.length === 0) {
    return (
      <div className="velocity-trend-empty" style={{ padding: 32, textAlign: "center", color: "var(--text-dim)" }}>
        No pitch data available for velocity trend.
      </div>
    );
  }

  const hp = hover?.pitch;
  const mobileShowTooltip = isMobile && mobileTooltipVis;

  return (
    <div ref={wrapRef} className="velocity-trend-wrap" style={{ position: "relative", width: "100%" }} onClick={handleTapElsewhere}>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: totalH + "px", borderRadius: 8, display: "block" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleCanvasClick}
      />
      {hp && !isMobile && <VelocityTooltip pitch={hp} x={hover.x} y={hover.y} />}
      {mobileShowTooltip && <VelocityTooltipMobile pitch={mobileTooltipVis.pitch} x={mobileTooltipVis.x} y={mobileTooltipVis.y} onClose={() => setMobileTooltipVis(null)} />}
    </div>
  );
}


function VelocityTooltipMobile({ pitch: p, x, y, onClose }) {
  const dc = PITCH_COLORS[p.pitch_name] || "#888";
  const result = getTooltipResult(p);

  const isBIP = !!p.events && p.launch_speed != null && p.launch_angle != null &&
    (p.description || "").toLowerCase() === "hit_into_play";
  const bbTag = isBIP ? classifyBattedBall(p.launch_speed, p.launch_angle) : null;
  const bbColor = bbTag ? (BATTED_BALL_COLORS[bbTag] || "rgba(180,184,210,0.7)") : null;

  const tx = x + 16;
  const ty = y - 16;
  const leftVp = tx + 300 > window.innerWidth ? x - 310 : tx;
  const topVp = ty + 260 > window.innerHeight ? y - 260 : ty;
  const style = {
    position: "fixed",
    // Compensate for body { zoom: 1.25 } on desktop.
    left: vpToZoomCoord(leftVp),
    top: vpToZoomCoord(topVp),
    zIndex: 1000,
    pointerEvents: "auto",
  };

  return (
    <div className="pitch-tooltip mobile-tooltip" style={style}>
      <button onClick={onClose} style={{
        position: "absolute",
        top: 8,
        right: 8,
        background: "none",
        border: "none",
        color: "#e0e2ec",
        fontSize: 20,
        cursor: "pointer",
        padding: 0,
        width: 24,
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }}>×</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: isBIP ? 0 : 4 }}>
        <div style={{ whiteSpace: "nowrap" }}>
          <span style={{ color: dc, fontWeight: 600 }}>{p.pitch_name}</span>
          <span style={{ marginLeft: 6, color: "#e0e2ec" }}>
            {p.release_speed ? p.release_speed.toFixed(1) + " mph" : ""}
          </span>
          <span style={{ marginLeft: 6, color: "rgba(180,184,210,0.5)", fontSize: "0.85em" }}>#{p._seqNum}</span>
        </div>
        <div style={{ whiteSpace: "nowrap", color: result.color, fontWeight: 600, marginLeft: 12 }}>
          {result.label}
          {result.isK && (
            result.isCalledStrikeThree
              ? <span style={{ marginLeft: 3 }}>(<span style={{ display: "inline-block", transform: "scaleX(-1)" }}>K</span>)</span>
              : <span style={{ marginLeft: 3 }}>(K)</span>
          )}
        </div>
      </div>
      {isBIP && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
          {p.launch_speed != null && (
            <div style={{ fontSize: "0.85em", color: "#e0e2ec" }}>
              {p.launch_speed.toFixed(1)} EV · {p.launch_angle != null ? p.launch_angle.toFixed(0) + "° LA" : ""}
            </div>
          )}
          {bbTag && (
            <div style={{ color: bbColor, fontWeight: 600, fontSize: "0.85em", marginLeft: 12 }}>
              {bbTag}
            </div>
          )}
        </div>
      )}
      {(p.batter_name || p.batter) && (
        <div className="pt-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, fontSize: "0.85em" }}>
          <span>vs {p.batter_name || p.batter}</span>
          {result.isK && result.subLabel && (
            <span style={{ color: "rgba(180,184,210,0.7)" }}>{result.subLabel}</span>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          {p.inning != null && p.inning_topbot && (
            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
              {p.inning_topbot === "Top" ? "Top" : "Bot"} {ordinal(p.inning)} | {formatBaseState(p)}
            </div>
          )}
          {p.outs_when_up != null && p.balls != null && p.strikes != null && (
            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
              {p.outs_when_up} Outs | {p.balls}-{p.strikes}
            </div>
          )}
          {p.pfx_z != null && p.pfx_x != null && (
            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
              iVB {p.pfx_z.toFixed(1)}" · iHB {(-p.pfx_x).toFixed(1)}"
              {p.release_extension != null && ` · Ext ${p.release_extension.toFixed(1)}ft`}
            </div>
          )}
          {(() => {
            const runs = runsScoredOnPitch(p);
            return runs > 0 ? (
              <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em", color: "#FF5EDC", fontWeight: 600 }}>
                {runs} Run{runs !== 1 ? "s" : ""}
              </div>
            ) : null;
          })()}
        </div>
        {p.plate_x != null && p.plate_z != null && (
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
                const isLeft = p.stand === "L";
                const lx = isLeft ? 6 : 59;
                const letters = isLeft ? ["L", "H", "B"] : ["R", "H", "B"];
                return letters.map((ch, i) => (
                  <text key={i} x={lx} y={24 + i * 10} fill="rgba(150,155,185,0.28)" fontSize="7" fontWeight="bold" textAnchor="middle" dominantBaseline="middle" fontFamily="'DM Sans', sans-serif">{ch}</text>
                ));
              })()}
              {(() => {
                const dotX = 12 + ((-p.plate_x + 0.83) / 1.66) * 41;
                const dotY = 8 + ((DISPLAY_SZ_TOP - normalizePlateZ(p.plate_z, p.sz_top, p.sz_bot)) / (DISPLAY_SZ_TOP - DISPLAY_SZ_BOT)) * 50;
                return <circle cx={dotX} cy={dotY} r="4" fill={dc} stroke="rgba(0,0,0,0.4)" strokeWidth="0.8" />;
              })()}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

function VelocityTooltip({ pitch: p, x, y }) {
  const dc = PITCH_COLORS[p.pitch_name] || "#888";
  const result = getTooltipResult(p);

  const isBIP = !!p.events && p.launch_speed != null && p.launch_angle != null &&
    (p.description || "").toLowerCase() === "hit_into_play";
  const bbTag = isBIP ? classifyBattedBall(p.launch_speed, p.launch_angle) : null;
  const bbColor = bbTag ? (BATTED_BALL_COLORS[bbTag] || "rgba(180,184,210,0.7)") : null;

  const tx = x + 16;
  const ty = y - 16;
  const leftVp = tx + 300 > window.innerWidth ? x - 310 : tx;
  const topVp = ty + 260 > window.innerHeight ? y - 260 : ty;
  const style = {
    position: "fixed",
    // Compensate for body { zoom: 1.25 } on desktop.
    left: vpToZoomCoord(leftVp),
    top: vpToZoomCoord(topVp),
    zIndex: 1000,
    pointerEvents: "none",
  };

  return (
    <div className="pitch-tooltip" style={style}>
      {/* Header row 1: Pitch type + mph (left) | Result (right) */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: isBIP ? 0 : 4 }}>
        <div style={{ whiteSpace: "nowrap" }}>
          <span style={{ color: dc, fontWeight: 600 }}>{p.pitch_name}</span>
          <span style={{ marginLeft: 6, color: "#e0e2ec" }}>
            {p.release_speed ? p.release_speed.toFixed(1) + " mph" : ""}
          </span>
          <span style={{ marginLeft: 6, color: "rgba(180,184,210,0.5)", fontSize: "0.85em" }}>#{p._seqNum}</span>
        </div>
        <div style={{ whiteSpace: "nowrap", color: result.color, fontWeight: 600, marginLeft: 12 }}>
          {result.label}
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
          {p.launch_speed != null && (
            <div style={{ fontSize: "0.85em", color: "#e0e2ec" }}>
              {p.launch_speed.toFixed(1)} EV · {p.launch_angle != null ? p.launch_angle.toFixed(0) + "° LA" : ""}
            </div>
          )}
          {bbTag && (
            <div style={{ color: bbColor, fontWeight: 600, fontSize: "0.85em", marginLeft: 12 }}>
              {bbTag}
            </div>
          )}
        </div>
      )}

      {/* Body: text left, strikezone right */}
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          {/* vs Batter (left) | Strikeout sub-label (right) */}
          {(p.batter_name || p.batter) && (
            <div className="pt-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, fontSize: "0.85em" }}>
              <span>vs {p.batter_name || p.batter}</span>
              {result.isK && result.subLabel && (
                <span style={{ color: "rgba(180,184,210,0.7)" }}>{result.subLabel}</span>
              )}
            </div>
          )}

          {/* Inning + bases */}
          {p.inning != null && p.inning_topbot && (
            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
              {p.inning_topbot === "Top" ? "Top" : "Bot"} {ordinal(p.inning)} | {formatBaseState(p)}
            </div>
          )}

          {/* Outs + count */}
          {p.outs_when_up != null && p.balls != null && p.strikes != null && (
            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
              {p.outs_when_up} Outs | {p.balls}-{p.strikes}
            </div>
          )}

          {/* iVB + iHB + Extension */}
          {p.pfx_z != null && p.pfx_x != null && (
            <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em" }}>
              iVB {p.pfx_z.toFixed(1)}" · iHB {(-p.pfx_x).toFixed(1)}"
              {p.release_extension != null && ` · Ext ${p.release_extension.toFixed(1)}ft`}
            </div>
          )}
          {(() => {
            const runs = runsScoredOnPitch(p);
            return runs > 0 ? (
              <div className="pt-row" style={{ marginBottom: 4, fontSize: "0.85em", color: "#FF5EDC", fontWeight: 600 }}>
                {runs} Run{runs !== 1 ? "s" : ""}
              </div>
            ) : null;
          })()}
        </div>

        {/* RIGHT: Mini Strikezone SVG, aligned to bottom */}
        {p.plate_x != null && p.plate_z != null && (
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
                const isLeft = p.stand === "L";
                const lx = isLeft ? 6 : 59;
                const letters = isLeft ? ["L", "H", "B"] : ["R", "H", "B"];
                return letters.map((ch, i) => (
                  <text key={i} x={lx} y={24 + i * 10} fill="rgba(150,155,185,0.28)" fontSize="7" fontWeight="bold" textAnchor="middle" dominantBaseline="middle" fontFamily="'DM Sans', sans-serif">{ch}</text>
                ));
              })()}
              {(() => {
                const dotX = 12 + ((-p.plate_x + 0.83) / 1.66) * 41;
                const dotY = 8 + ((DISPLAY_SZ_TOP - normalizePlateZ(p.plate_z, p.sz_top, p.sz_bot)) / (DISPLAY_SZ_TOP - DISPLAY_SZ_BOT)) * 50;
                return <circle cx={dotX} cy={dotY} r="4" fill={dc} stroke="rgba(0,0,0,0.4)" strokeWidth="0.8" />;
              })()}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
