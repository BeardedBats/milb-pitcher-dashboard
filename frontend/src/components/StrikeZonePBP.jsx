import React, { useEffect, useRef, useState } from "react";
import { displayAbbrev } from "../constants";
import { getTooltipResult } from "../utils/pitchFilters";
import { getDesktopZoom } from "../utils/desktopZoom";
import { normalizePlateZ } from "../utils/strikezone";

const BATTED_BALL_COLORS = {
  "Barrel": "#ffa3a3",
  "Solid": "#ffc277",
  "Burner": "#ffc277",
  "Flare/Burner": "#8feaff",
  "Flare": "#8feaff",
  "Under": "#65ff9c",
  "Topped": "#65ff9c",
  "Poor": "#65ff9c",
};

// PBP-only circle color overrides (don't affect text, tables, or other plots)
const PBP_CIRCLE_OVERRIDES = {
  "Four-Seamer": "#931c33",
  "Changeup": "#228B22",
  "Cutter": "#8d7373",
  "Sweeper": "#ff40ed",
  "Slider": "#a73cd9",
  "Sinker": "#af8033",
};

// Saturate a hex color for more vibrant circles
function saturateColor(hex, factor = 1.3) {
  if (!hex || hex.startsWith("rgba")) return hex;
  // Parse hex
  let r, g, b;
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  }
  // Convert to HSL-like saturation boost
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  // Push each channel away from gray
  const gray = (r + g + b) / 3;
  r = Math.min(255, Math.max(0, Math.round(gray + (r - gray) * factor)));
  g = Math.min(255, Math.max(0, Math.round(gray + (g - gray) * factor)));
  b = Math.min(255, Math.max(0, Math.round(gray + (b - gray) * factor)));
  return `rgb(${r}, ${g}, ${b})`;
}

export default function StrikeZonePBP({ pitches, pitchColors, result, resultLabel, batter, pitcher, outs, stand, launchSpeed, launchAngle, battedBallType, rbi, isStrikeoutResult, lastPitch, onPitchHover, homeScore, awayScore, awayTeam, homeTeam, pitcherTeam }) {
  const canvasRef = useRef(null);
  const [hoveredPitch, setHoveredPitch] = useState(null);

  const WIDTH = 320;
  const HEIGHT = 420;

  const ZONE_W = 170;
  const ZONE_H = 190;
  const ZONE_CX = WIDTH / 2;
  const ZONE_CY = HEIGHT / 2 + 20;
  const ZONE_LEFT = ZONE_CX - ZONE_W / 2;
  const ZONE_RIGHT = ZONE_CX + ZONE_W / 2;
  const ZONE_TOP = ZONE_CY - ZONE_H / 2;
  const ZONE_BOT = ZONE_CY + ZONE_H / 2;

  // Visible plotting bounds (beyond which we clip)
  const PLOT_PAD = 45;
  const PLOT_LEFT = ZONE_LEFT - PLOT_PAD;
  const PLOT_RIGHT = ZONE_RIGHT + PLOT_PAD;
  const PLOT_TOP = ZONE_TOP - PLOT_PAD;
  const PLOT_BOT = ZONE_BOT + PLOT_PAD;

  const toX = (plateX) => ZONE_LEFT + ((-plateX + 0.83) / 1.66) * ZONE_W;
  // Expects a plate_z already normalized onto the fixed [1.5, 3.5] reference
  // zone (see normalizePlateZ) so pitches sit relative to each batter's zone.
  const toY = (plateZ) => ZONE_TOP + ((3.5 - plateZ) / 2.0) * ZONE_H;

  const drawBatterLabel = (ctx, x, y, isLefty) => {
    ctx.save();
    ctx.fillStyle = "rgba(150, 155, 185, 0.28)";
    ctx.font = "bold 14px 'DM Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const spacing = 18;
    if (isLefty) {
      ctx.fillText("L", x, y - spacing);
      ctx.fillText("H", x, y);
      ctx.fillText("B", x, y + spacing);
    } else {
      ctx.fillText("R", x, y - spacing);
      ctx.fillText("H", x, y);
      ctx.fillText("B", x, y + spacing);
    }
    ctx.restore();
  };

  const handleCanvasMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas || !pitches) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = WIDTH / rect.width;
    const scaleY = HEIGHT / rect.height;
    const clientX = (e.clientX - rect.left) * scaleX;
    const clientY = (e.clientY - rect.top) * scaleY;
    const hitRadius = 16;
    let nearest = null;
    let minDist = hitRadius;
    pitches.forEach((pitch, idx) => {
      if (pitch.plate_x == null || pitch.plate_z == null) return;
      const rawCx = toX(pitch.plate_x);
      const rawCy = toY(normalizePlateZ(pitch.plate_z, pitch.sz_top, pitch.sz_bot));
      // Use clamped (display) coordinates for OOB pitches so hover matches drawn position
      const cx = Math.max(PLOT_LEFT, Math.min(PLOT_RIGHT, rawCx));
      const cy = Math.max(PLOT_TOP, Math.min(PLOT_BOT, rawCy));
      const dist = Math.sqrt((clientX - cx) ** 2 + (clientY - cy) ** 2);
      if (dist < minDist) {
        minDist = dist;
        nearest = { pitch, index: idx, x: clientX, y: clientY };
      }
    });
    if (nearest) {
      setHoveredPitch(nearest.index);
      if (onPitchHover) onPitchHover({ pitch: nearest.pitch, x: nearest.x, y: nearest.y, clientX: e.clientX, clientY: e.clientY });
    } else {
      setHoveredPitch(null);
      if (onPitchHover) onPitchHover(null);
    }
  };

  const handleCanvasMouseLeave = () => {
    setHoveredPitch(null);
    if (onPitchHover) onPitchHover(null);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pitches || pitches.length === 0) return;
    // Compensate for body { zoom: 1.25 } on desktop — bigger bitmap so the
    // post-zoom paint lands 1:1 on screen pixels (no bilinear blur). The
    // canvas's CSS width/height are set inline in the JSX below.
    const dpr = (window.devicePixelRatio || 1) * getDesktopZoom();
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = "#2E3150";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // ── Header: Match tooltip color scheme ──
    const HPAD = 14;
    ctx.textBaseline = "top";

    // Compute result using tooltip system for consistent colors
    const lp = pitches[pitches.length - 1];
    const tooltipResult = result ? getTooltipResult({}, {
      desc: lp?.desc || "",
      paResult: result,
      isLastPitch: true,
      launchAngle: launchAngle,
    }) : null;

    // Row 1: Hitter name (left) | Result + K symbol (right)
    ctx.fillStyle = "rgba(224, 226, 236, 0.9)";
    ctx.font = "bold 14px 'DM Sans', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(batter, HPAD, 10);

    if (tooltipResult) {
      ctx.fillStyle = tooltipResult.color;
      ctx.font = "bold 14px 'DM Sans', sans-serif";
      ctx.textAlign = "right";
      let resultText = tooltipResult.label;
      if (tooltipResult.isK) {
        resultText += tooltipResult.isCalledStrikeThree ? " (Ꝁ)" : " (K)";
      }
      ctx.fillText(resultText, WIDTH - HPAD, 10);
    }

    // Row 2: vs Pitcher left, MPH + Pitch Type right
    ctx.font = "12px 'DM Sans', sans-serif";
    ctx.fillStyle = "rgba(180, 184, 210, 0.6)";
    ctx.textAlign = "left";
    ctx.fillText(`vs ${pitcher || "Unknown"}`, HPAD, 30);

    if (lastPitch) {
      const mphText = lastPitch.speed ? Number(lastPitch.speed).toFixed(1) : "";
      const typeText = lastPitch.type || "";
      const typeColor = pitchColors[typeText] || "#888";
      ctx.textAlign = "right";
      ctx.fillStyle = "#E0E2EC";
      ctx.font = "bold 12px 'DM Sans', sans-serif";
      const typeWidth = ctx.measureText(typeText).width;
      const gap = 4;
      ctx.fillText(mphText, WIDTH - HPAD - typeWidth - gap, 30);
      ctx.fillStyle = typeColor;
      ctx.font = "bold 12px 'DM Sans', sans-serif";
      ctx.fillText(typeText, WIDTH - HPAD, 30);
    }
    const row2Y = 48;

    // Row 3: EV/LA + batted ball type (for balls in play), or final count
    if (!isStrikeoutResult && launchSpeed != null) {
      ctx.textAlign = "left";
      let evlaText = `${launchSpeed.toFixed(1)} EV`;
      if (launchAngle != null) evlaText += ` · ${Math.round(launchAngle)}° LA`;
      ctx.fillStyle = "rgba(180, 184, 210, 0.55)";
      ctx.font = "italic 11px 'DM Sans', sans-serif";
      ctx.fillText(evlaText, HPAD, row2Y);

      if (battedBallType) {
        ctx.fillStyle = BATTED_BALL_COLORS[battedBallType] || "rgba(180,184,210,0.6)";
        ctx.font = "bold 11px 'DM Sans', sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(battedBallType, WIDTH - HPAD, row2Y);
      }
    } else if (result && !launchSpeed && !isStrikeoutResult) {
      if (lp?.count) {
        ctx.fillStyle = "rgba(180, 184, 210, 0.55)";
        ctx.font = "italic 11px 'DM Sans', sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(`Final count: ${lp.count}`, HPAD, row2Y);
      }
    }

    // Strike zone box
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = 2;
    ctx.strokeRect(ZONE_LEFT, ZONE_TOP, ZONE_W, ZONE_H);

    // 3x3 grid
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      const x = ZONE_LEFT + (i / 3) * ZONE_W;
      ctx.beginPath(); ctx.moveTo(x, ZONE_TOP); ctx.lineTo(x, ZONE_BOT); ctx.stroke();
      const y = ZONE_TOP + (i / 3) * ZONE_H;
      ctx.beginPath(); ctx.moveTo(ZONE_LEFT, y); ctx.lineTo(ZONE_RIGHT, y); ctx.stroke();
    }

    // Home plate
    const plateCX = ZONE_CX;
    const plateW = 72;
    const plateH = 36;
    const bevelH = 12;
    const plateTopY = HEIGHT - 10 - plateH;
    ctx.beginPath();
    ctx.moveTo(plateCX, plateTopY);
    ctx.lineTo(plateCX + plateW / 2, plateTopY + bevelH);
    ctx.lineTo(plateCX + plateW / 2, plateTopY + plateH);
    ctx.lineTo(plateCX - plateW / 2, plateTopY + plateH);
    ctx.lineTo(plateCX - plateW / 2, plateTopY + bevelH);
    ctx.closePath();
    ctx.fillStyle = "rgba(140, 145, 175, 0.22)";
    ctx.fill();
    ctx.strokeStyle = "rgba(160, 164, 190, 0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Batter label
    const isLeftyBatter = stand === "L";
    const batterX = isLeftyBatter ? ZONE_LEFT - 30 : ZONE_RIGHT + 30;
    const batterY = ZONE_CY;
    drawBatterLabel(ctx, batterX, batterY, isLeftyBatter);

    // Draw pitches
    pitches.forEach((pitch, idx) => {
      if (pitch.plate_x == null || pitch.plate_z == null) return;
      const rawCx = toX(pitch.plate_x);
      const rawCy = toY(normalizePlateZ(pitch.plate_z, pitch.sz_top, pitch.sz_bot));
      const rawColor = PBP_CIRCLE_OVERRIDES[pitch.type] || pitchColors[pitch.type] || "#888888";
      const color = saturateColor(rawColor, 1.35);

      const desc = (pitch.desc || "").toLowerCase();
      const radius = 14;
      const isBall = desc.includes("ball") && !desc.includes("in play");
      const isFilled = !isBall;

      // Check if pitch is out of bounds
      const isOOB = rawCx < PLOT_LEFT || rawCx > PLOT_RIGHT || rawCy < PLOT_TOP || rawCy > PLOT_BOT;

      if (isOOB) {
        // Clamp to edge and draw half-circle
        const cx = Math.max(PLOT_LEFT, Math.min(PLOT_RIGHT, rawCx));
        const cy = Math.max(PLOT_TOP, Math.min(PLOT_BOT, rawCy));

        // Determine which edge(s) it's clipped to for arc direction
        let startAngle = 0;
        let endAngle = Math.PI;
        if (rawCx < PLOT_LEFT) { startAngle = -Math.PI / 2; endAngle = Math.PI / 2; }
        else if (rawCx > PLOT_RIGHT) { startAngle = Math.PI / 2; endAngle = 3 * Math.PI / 2; }
        else if (rawCy < PLOT_TOP) { startAngle = 0; endAngle = Math.PI; }
        else if (rawCy > PLOT_BOT) { startAngle = Math.PI; endAngle = 2 * Math.PI; }

        ctx.beginPath();
        ctx.arc(cx, cy, radius, startAngle, endAngle);
        if (isFilled) {
          ctx.fillStyle = color;
          ctx.fill();
        } else {
          ctx.strokeStyle = color;
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }

        // Pitch number
        ctx.fillStyle = isFilled ? "#fff" : color;
        ctx.font = "bold 12px 'DM Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // Offset number slightly toward center
        const numOffX = rawCx < PLOT_LEFT ? 5 : rawCx > PLOT_RIGHT ? -5 : 0;
        const numOffY = rawCy < PLOT_TOP ? 5 : rawCy > PLOT_BOT ? -5 : 0;
        ctx.fillText((idx + 1).toString(), cx + numOffX, cy + numOffY);
      } else {
        // Normal pitch circle
        if (isFilled) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(rawCx, rawCy, radius, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = color;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(rawCx, rawCy, radius, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Pitch number
        ctx.fillStyle = isFilled ? "#fff" : color;
        ctx.font = "bold 14px 'DM Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText((idx + 1).toString(), rawCx, rawCy + 0.5);
      }

      // Hover highlight ring
      const displayCx = isOOB ? Math.max(PLOT_LEFT, Math.min(PLOT_RIGHT, rawCx)) : rawCx;
      const displayCy = isOOB ? Math.max(PLOT_TOP, Math.min(PLOT_BOT, rawCy)) : rawCy;
      if (hoveredPitch === idx) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(displayCx, displayCy, radius + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  }, [pitches, pitchColors, result, resultLabel, batter, pitcher, outs, stand, launchSpeed, launchAngle, battedBallType, hoveredPitch, rbi, isStrikeoutResult, lastPitch, homeScore, awayScore, awayTeam, homeTeam, pitcherTeam]);

  return (
    <canvas
      ref={canvasRef}
      className="pbp-sz-canvas"
      style={{
        display: "block",
        width: WIDTH + "px",
        height: HEIGHT + "px",
        borderRadius: "6px",
        cursor: hoveredPitch != null ? "pointer" : "default",
      }}
      onMouseMove={handleCanvasMouseMove}
      onMouseLeave={handleCanvasMouseLeave}
    />
  );
}
