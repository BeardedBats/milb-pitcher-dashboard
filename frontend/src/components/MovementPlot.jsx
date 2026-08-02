import React, { useRef, useEffect, useState, useCallback } from "react";
import { PITCH_COLORS, getPitchColor, BATTED_BALL_COLORS } from "../constants";
import { classifyBattedBall } from "../utils/formatting";
import { getTooltipResult, runsScoredOnPitch } from "../utils/pitchFilters";
import { vpToZoomCoord, getDesktopZoom } from "../utils/desktopZoom";
import { normalizePlateZ, DISPLAY_SZ_TOP, DISPLAY_SZ_BOT } from "../utils/strikezone";
import { ordinalInning as ordinal, formatBaseState } from "../utils/gamePresentation";
import { samePitchIdentity } from "../utils/pitchIdentity";

const DEFAULT_W = 345, DEFAULT_H = 345;
const PAD = { top: 16, right: 16, bottom: 16, left: 16 };
const RANGE = 25;
const HIT_RADIUS = 10;

function toCanvas(ihb, ivb, W, H) {
  const PLOT_W = W - PAD.left - PAD.right;
  const PLOT_H = H - PAD.top - PAD.bottom;
  const x = PAD.left + ((ihb + RANGE) / (2 * RANGE)) * PLOT_W;
  const y = PAD.top + ((RANGE - ivb) / (2 * RANGE)) * PLOT_H;
  return [x, y];
}

export default function MovementPlot({ pitches, hand, onReclassify, isMobile = false, highlightPitch, highlightType, onPitchHover }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const containerRef = useRef(null);
  const [hover, setHover] = useState(null);

  // Build pitch positions for hit detection
  const pitchPositions = useRef([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    // Compensate for body { zoom: 1.25 } on desktop — bigger bitmap so the
    // post-zoom paint lands 1:1 on screen pixels (no bilinear blur).
    const dpr = (window.devicePixelRatio || 1) * getDesktopZoom();

    // Determine responsive sizing
    let W = DEFAULT_W, H = DEFAULT_H;
    if (isMobile && containerRef.current) {
      const containerWidth = containerRef.current.offsetWidth;
      if (containerWidth > 0) {
        W = Math.min(containerWidth - 24, 345);
        H = W; // Square plot
      } else {
        W = 290;
        H = 290;
      }
    }

    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#2E3150";
    ctx.fillRect(0, 0, W, H);

    const PLOT_W = W - PAD.left - PAD.right;
    const PLOT_H = H - PAD.top - PAD.bottom;
    const [cx, cy] = toCanvas(0, 0, W, H);
    const pxPerInch = PLOT_W / (2 * RANGE);

    const radii = [6, 12, 18, 24];
    radii.forEach(r => {
      const rPx = r * pxPerInch;
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(110, 114, 155, 0.45)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = "rgba(180, 184, 210, 0.7)";
      ctx.font = "500 11px DM Sans, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(r + '"', cx, cy - rPx - 3);
    });

    ctx.strokeStyle = "rgba(100, 104, 140, 0.35)";
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(cx, PAD.top); ctx.lineTo(cx, PAD.top + PLOT_H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PAD.left, cy); ctx.lineTo(PAD.left + PLOT_W, cy); ctx.stroke();

    // Draw arm angle radius line from center outward (right for RHP, left for LHP)
    if (pitches && pitches.length) {
      const armAngles = pitches.filter(p => p.arm_angle != null).map(p => p.arm_angle);
      if (armAngles.length > 0) {
        const avgArmAngle = armAngles.reduce((a, b) => a + b, 0) / armAngles.length;
        const rad = avgArmAngle * Math.PI / 180;
        // RHP releases to the right (positive x), LHP to the left
        const isRHP = hand === "R";
        const dir = isRHP ? 1 : -1;
        // Line from center to edge of plot
        const lineLen = Math.max(PLOT_W, PLOT_H) * 0.55;
        const dx = dir * Math.cos(rad) * lineLen;
        const dy = -Math.sin(rad) * lineLen; // canvas y is inverted
        ctx.save();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + dx, cy + dy);
        ctx.stroke();
        ctx.setLineDash([]);
        // Framed box label at end of line, clamped inside canvas
        const labelText = `${avgArmAngle.toFixed(0)}°`;
        ctx.font = "700 10px DM Sans, sans-serif";
        const textWidth = ctx.measureText(labelText).width;
        const boxPad = 4;
        const boxW = textWidth + boxPad * 2;
        const boxH = 16;
        const endX = cx + dx;
        const endY = cy + dy;
        // Position box just past the line end
        let boxX = isRHP ? endX + 4 : endX - boxW - 4;
        let boxY = endY - boxH / 2;
        // Clamp to stay inside canvas
        boxX = Math.max(2, Math.min(boxX, W - boxW - 2));
        boxY = Math.max(2, Math.min(boxY, H - boxH - 2));
        // Draw frame
        ctx.strokeStyle = "#f0f1f5";
        ctx.lineWidth = 1;
        ctx.strokeRect(boxX, boxY, boxW, boxH);
        // Draw text
        ctx.fillStyle = "#f0f1f5";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(labelText, boxX + boxPad, boxY + boxH / 2);
        ctx.restore();
      }
    }

    const positions = [];
    if (pitches && pitches.length) {
      const isHighlighting = highlightPitch || highlightType;
      const withCoords = [];
      pitches.forEach((p, idx) => {
        if (p.pfx_x == null || p.pfx_z == null) return;
        const ihb = -p.pfx_x;
        const ivb = p.pfx_z;
        const [x, y] = toCanvas(ihb, ivb, W, H);
        if (x < PAD.left - 8 || x > PAD.left + PLOT_W + 8 || y < PAD.top - 8 || y > PAD.top + PLOT_H + 8) return;
        const isMatch = highlightPitch ? samePitchIdentity(p, highlightPitch) : (highlightType ? p.pitch_name === highlightType : true);
        withCoords.push({ x, y, idx, pitch: p, isMatch });
      });
      if (isHighlighting) withCoords.sort((a, b) => (a.isMatch ? 1 : 0) - (b.isMatch ? 1 : 0));
      withCoords.forEach(({ x, y, idx, pitch: p, isMatch }) => {
        positions.push({ x, y, idx, pitch: p });
        const color = getPitchColor(p.pitch_name);
        const isDimmed = isHighlighting && !isMatch;
        ctx.globalAlpha = isDimmed ? 0.12 : 0.85;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = isDimmed ? 0.08 : 0.3;
        ctx.strokeStyle = "#111";
        ctx.lineWidth = 0.8;
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    }
    pitchPositions.current = positions;
  }, [pitches, hand, isMobile, highlightPitch, highlightType]);

  const findNearest = useCallback((mx, my) => {
    let closest = null;
    let minDist = HIT_RADIUS;
    for (const pos of pitchPositions.current) {
      const d = Math.sqrt((mx - pos.x) ** 2 + (my - pos.y) ** 2);
      if (d < minDist) { minDist = d; closest = pos; }
    }
    return closest;
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (isMobile) return; // Skip mouse move on mobile
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // Convert viewport pixels → canvas drawing coords (CSS pixels). Body
    // zoom on desktop scales the displayed box by getDesktopZoom(), so we
    // divide by that to undo it. Independent of devicePixelRatio.
    const z = getDesktopZoom();
    const mx = (e.clientX - rect.left) / z;
    const my = (e.clientY - rect.top) / z;
    const nearest = findNearest(mx, my);
    if (nearest) {
      setHover({
        pitch: nearest.pitch,
        x: e.clientX,
        y: e.clientY,
      });
      if (onPitchHover) onPitchHover(nearest.pitch);
    } else {
      setHover(null);
      if (onPitchHover) onPitchHover(null);
    }
  }, [findNearest, isMobile, onPitchHover]);

  const handleMouseLeave = useCallback(() => {
    setHover(null);
    if (onPitchHover) onPitchHover(null);
  }, [onPitchHover]);

  const handleClick = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // See handleMouseMove — body zoom undo, dpr-independent.
    const z = getDesktopZoom();
    const mx = (e.clientX - rect.left) / z;
    const my = (e.clientY - rect.top) / z;
    const nearest = findNearest(mx, my);
    if (nearest) {
      if (isMobile) {
        // On mobile, tap shows tooltip
        setHover({
          pitch: nearest.pitch,
          x: e.clientX,
          y: e.clientY,
        });
      } else if (onReclassify) {
        // On desktop, click can trigger reclassify
        onReclassify(nearest.pitch);
      }
    } else if (isMobile) {
      // On mobile, tap on empty area closes tooltip
      setHover(null);
    }
  }, [findNearest, isMobile, onReclassify]);

  // On mobile, tapping anywhere off the plot/tooltip dismisses the tooltip.
  // (Taps on the canvas are handled by handleClick — switch pitch or close on
  // an empty spot. The tooltip is a DOM descendant of containerRef, so taps on
  // it are treated as "inside" and don't dismiss.)
  useEffect(() => {
    if (!isMobile || !hover) return;
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setHover(null);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [isMobile, hover]);

  const p = hover?.pitch;

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block", width: "100%" }}>
      <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
        <canvas
          ref={canvasRef}
          style={{ borderRadius: 6, cursor: onReclassify ? "pointer" : "default", touchAction: "none" }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
        />
      {hover && p && (() => {
        const result = getTooltipResult(p);
        const isBIP = !!p.events && p.launch_speed != null && p.launch_angle != null &&
          (p.description || "").toLowerCase() === "hit_into_play";
        const bbTag = isBIP ? classifyBattedBall(p.launch_speed, p.launch_angle) : null;
        const bbColor = bbTag ? (BATTED_BALL_COLORS[bbTag] || "rgba(180,184,210,0.7)") : null;

        return (
          <div className={isMobile ? "pitch-tooltip mobile-tooltip" : "pitch-tooltip"} style={(() => {
            if (isMobile) {
              return {
                position: "fixed",
                bottom: 16,
                left: 16,
                right: 16,
                transform: "none",
                minWidth: "auto",
                zIndex: 1000,
                pointerEvents: "auto",
              };
            }
            const tx = hover.x + 16;
            const ty = hover.y - 16;
            const leftVp = tx + 300 > window.innerWidth ? hover.x - 310 : tx;
            const topVp = ty < 10 ? hover.y + 16 : (ty + 280 > window.innerHeight ? hover.y - 280 : ty);
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
                <span style={{ color: PITCH_COLORS[p.pitch_name] || "#ccc", fontWeight: 600 }}>
                  {p.pitch_name}
                </span>
                <span style={{ marginLeft: 6, color: "#e0e2ec" }}>
                  {p.release_speed ? p.release_speed.toFixed(1) + " mph" : ""}
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

            {/* vs Batter (left) | Strikeout sub-label (right) — full width above body columns */}
            {(p.batter_name || p.batter) && (
              <div className="pt-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, fontSize: "0.85em" }}>
                <span>vs {p.batter_name || p.batter}</span>
                {result.isK && result.subLabel && (
                  <span style={{ color: "rgba(180,184,210,0.7)" }}>{result.subLabel}</span>
                )}
              </div>
            )}

            {/* Body: text left, strikezone right */}
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}>
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
                      const pitchColor = getPitchColor(p.pitch_name);
                      return (
                        <circle cx={dotX} cy={dotY} r="4" fill={pitchColor} stroke="rgba(0,0,0,0.4)" strokeWidth="0.8" />
                      );
                    })()}
                  </svg>
                </div>
              )}
            </div>
          </div>
        );
      })()}
      </div>
    </div>
  );
}
