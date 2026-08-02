import React, { useRef, useEffect, useState, useCallback } from "react";
import { PITCH_COLORS, getPitchColor, PITCH_DESC_COLORS, getSZResultColor, BATTED_BALL_COLORS } from "../constants";
import { classifyBattedBall } from "../utils/formatting";
import { getTooltipResult, runsScoredOnPitch } from "../utils/pitchFilters";
import { vpToZoomCoord, getDesktopZoom } from "../utils/desktopZoom";
import { normalizePlateZ, DISPLAY_SZ_TOP, DISPLAY_SZ_BOT } from "../utils/strikezone";
import { ordinalInning as ordinal, formatBaseState } from "../utils/gamePresentation";
import { samePitchIdentity } from "../utils/pitchIdentity";

const DEFAULT_W = 310, DEFAULT_H = 345;
const PAD = { top: 16, right: 16, bottom: 44, left: 16 };
const X_RANGE = [-2, 2];
const Y_RANGE = [0.5, 4.5];
const HIT_RADIUS = 10;

function toCanvas(px, pz, W, H) {
  const PLOT_W = W - PAD.left - PAD.right;
  const PLOT_H = H - PAD.top - PAD.bottom;
  const x = PAD.left + ((px - X_RANGE[0]) / (X_RANGE[1] - X_RANGE[0])) * PLOT_W;
  const y = PAD.top + ((Y_RANGE[1] - pz) / (Y_RANGE[1] - Y_RANGE[0])) * PLOT_H;
  return [x, y];
}

export default function StrikeZonePlot({ pitches, stand, colorMode = "pitch-type", onReclassify, isMobile = false, highlightPitch, highlightType, onPitchHover }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const containerRef = useRef(null);
  const [hover, setHover] = useState(null);
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
        W = Math.min(containerWidth - 24, 310);
        H = Math.round(W * DEFAULT_H / DEFAULT_W);
      } else {
        W = 280;
        H = 312;
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

    // One fixed-size reference zone for everyone; each pitch's height is
    // normalized onto it via normalizePlateZ so locations sit relative to the
    // batter's individual zone (matches Savant).
    const top = DISPLAY_SZ_TOP;
    const bot = DISPLAY_SZ_BOT;
    const [zl, zt] = toCanvas(-0.83, top, W, H);
    const [zr, zb] = toCanvas(0.83, bot, W, H);

    ctx.fillStyle = "rgba(100, 108, 150, 0.05)";
    ctx.fillRect(zl, zt, zr - zl, zb - zt);

    ctx.strokeStyle = "rgba(106, 110, 144, 0.45)";
    ctx.lineWidth = 1;
    ctx.strokeRect(zl, zt, zr - zl, zb - zt);

    const zoneW = (zr - zl) / 3;
    const zoneH = (zb - zt) / 3;
    ctx.strokeStyle = "rgba(72, 76, 112, 0.35)";
    ctx.lineWidth = 0.5;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(zl + zoneW * i, zt); ctx.lineTo(zl + zoneW * i, zb); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(zl, zt + zoneH * i); ctx.lineTo(zr, zt + zoneH * i); ctx.stroke();
    }

    // Home plate
    const plateW = zr - zl;
    const plateCX = (zl + zr) / 2;
    const plateStartY = zb + 60;
    const bevelH = Math.round(plateW * 0.12);
    const sideH = Math.round(plateW * 0.06);
    const totalH = bevelH + sideH;
    ctx.beginPath();
    ctx.moveTo(plateCX, plateStartY);
    ctx.lineTo(plateCX + plateW / 2, plateStartY + bevelH);
    ctx.lineTo(plateCX + plateW / 2, plateStartY + totalH);
    ctx.lineTo(plateCX - plateW / 2, plateStartY + totalH);
    ctx.lineTo(plateCX - plateW / 2, plateStartY + bevelH);
    ctx.closePath();
    ctx.fillStyle = "rgba(140, 145, 175, 0.22)";
    ctx.fill();
    ctx.strokeStyle = "rgba(160, 164, 190, 0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Pitch dots
    const positions = [];
    let filtered = (pitches || []).filter(p =>
      p.plate_x != null && p.plate_z != null && p.stand === stand
    );
    // PA Results mode: only show PA-ending pitches
    if (colorMode === "pa-result") {
      filtered = filtered.filter(p => p.events);
    }
    const isHighlighting = highlightPitch || highlightType;
    // Sort: draw dimmed pitches first, highlighted on top to avoid stacking opacity
    const DOT_R = 6.6;
    const EDGE_PAD = 2; // padding from plot boundary for clamped dots
    const plotLeft = PAD.left - EDGE_PAD;
    const plotRight = PAD.left + PLOT_W + EDGE_PAD;
    const plotTop = PAD.top - EDGE_PAD;
    const plotBot = PAD.top + PLOT_H + EDGE_PAD;
    const withCoords = [];
    filtered.forEach((p) => {
      const [rawX, rawY] = toCanvas(-p.plate_x, normalizePlateZ(p.plate_z, p.sz_top, p.sz_bot), W, H);
      const isOOB = rawX < plotLeft || rawX > plotRight || rawY < plotTop || rawY > plotBot;
      const cx = Math.max(plotLeft, Math.min(plotRight, rawX));
      const cy = Math.max(plotTop, Math.min(plotBot, rawY));
      const isMatch = highlightPitch ? samePitchIdentity(p, highlightPitch) : (highlightType ? p.pitch_name === highlightType : true);
      // Determine semi-circle arc direction for OOB pitches
      let arcStart = 0, arcEnd = Math.PI * 2;
      if (isOOB) {
        // Point arc inward from the clipped edge
        if (rawX < plotLeft)       { arcStart = -Math.PI / 2; arcEnd = Math.PI / 2; }
        else if (rawX > plotRight) { arcStart = Math.PI / 2; arcEnd = 3 * Math.PI / 2; }
        else if (rawY < plotTop)   { arcStart = 0; arcEnd = Math.PI; }
        else if (rawY > plotBot)   { arcStart = Math.PI; arcEnd = 2 * Math.PI; }
      }
      withCoords.push({ x: cx, y: cy, pitch: p, isMatch, isOOB, arcStart, arcEnd });
    });
    if (isHighlighting) withCoords.sort((a, b) => (a.isMatch ? 1 : 0) - (b.isMatch ? 1 : 0));
    withCoords.forEach(({ x, y, pitch: p, isMatch, isOOB, arcStart, arcEnd }) => {
      positions.push({ x, y, pitch: p });
      let color;
      if (colorMode === "pitch-result") {
        color = getSZResultColor(p);
      } else {
        color = getPitchColor(p.pitch_name);
      }
      const isDimmed = isHighlighting && !isMatch;
      ctx.globalAlpha = isDimmed ? 0.12 : 0.85;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, DOT_R, arcStart, arcEnd);
      if (!isOOB) ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = isDimmed ? 0.08 : 0.3;
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 0.8;
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    pitchPositions.current = positions;
  }, [pitches, stand, colorMode, isMobile, highlightPitch, highlightType]);

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
    // Convert viewport pixels → CSS pixels (the canvas drawing coord
    // system after ctx.scale). Body zoom on desktop scales the displayed
    // box by getDesktopZoom(); divide to undo. Independent of dpr.
    const z = getDesktopZoom();
    const mx = (e.clientX - rect.left) / z;
    const my = (e.clientY - rect.top) / z;
    const nearest = findNearest(mx, my);
    if (nearest) {
      setHover({ pitch: nearest.pitch, x: e.clientX, y: e.clientY });
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
        setHover({ pitch: nearest.pitch, x: e.clientX, y: e.clientY });
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
              // Compensate for body { zoom: 1.25 } on desktop — inline coords
              // are in zoomed coord system; mouse coords are in viewport px.
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
                      const rawDotX = 12 + ((-p.plate_x + 0.83) / 1.66) * 41;
                      const rawDotY = 8 + ((DISPLAY_SZ_TOP - normalizePlateZ(p.plate_z, p.sz_top, p.sz_bot)) / (DISPLAY_SZ_TOP - DISPLAY_SZ_BOT)) * 50;
                      const pitchColor = getPitchColor(p.pitch_name);
                      // Clamp to plot area with padding
                      const minX = 4, maxX = 61, minY = 4, maxY = 71;
                      const isOOB = rawDotX < minX || rawDotX > maxX || rawDotY < minY || rawDotY > maxY;
                      const dotX = Math.max(minX, Math.min(maxX, rawDotX));
                      const dotY = Math.max(minY, Math.min(maxY, rawDotY));
                      if (!isOOB) {
                        return <circle cx={dotX} cy={dotY} r="4" fill={pitchColor} stroke="rgba(0,0,0,0.4)" strokeWidth="0.8" />;
                      }
                      // Semi-circle: determine arc direction pointing inward
                      const r = 4;
                      let d;
                      if (rawDotX < minX)       d = `M${dotX},${dotY - r} A${r},${r} 0 0,1 ${dotX},${dotY + r}`;
                      else if (rawDotX > maxX)  d = `M${dotX},${dotY + r} A${r},${r} 0 0,1 ${dotX},${dotY - r}`;
                      else if (rawDotY < minY)  d = `M${dotX - r},${dotY} A${r},${r} 0 0,1 ${dotX + r},${dotY}`;
                      else                      d = `M${dotX + r},${dotY} A${r},${r} 0 0,1 ${dotX - r},${dotY}`;
                      return <path d={d} fill={pitchColor} stroke="rgba(0,0,0,0.4)" strokeWidth="0.8" />;
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
