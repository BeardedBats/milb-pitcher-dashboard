import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { PITCH_COLORS, BATTED_BALL_COLORS, displayTeamAbbrev } from "../constants";
import { isRunScored, getTooltipResult, getPBPResultColor, getPADescriptionSpans, isCIOrErrorEvent, runsScoredOnPitch } from "../utils/pitchFilters";
import { classifyBattedBall } from "../utils/formatting";
import { vpToZoomCoord, getDesktopZoom } from "../utils/desktopZoom";
import { normalizePlateZ, DISPLAY_SZ_TOP, DISPLAY_SZ_BOT } from "../utils/strikezone";
import { ordinalInning as ordinal, formatBaseState } from "../utils/gamePresentation";
import { shortGameDate, axisTickStep } from "../utils/velocityChart";

const DOT_R = 4.5;
const DOT_PAD = 3;
const GLOW_R = 12;

// PA result colors are sourced from getPBPResultColor (utils/pitchFilters) so
// Scoreboard, this component, PitcherCard, and PlayByPlayModal stay in sync.

export default function VelocityTrendV2({ pitches, onReclassify, isMobile, linescoreData, pitcherId, groupBy = "inning" }) {
  const displayAbbrev = (abbr) => displayTeamAbbrev(abbr);
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const dotsRef = useRef([]);
  const inningHeadersRef = useRef([]); // hit regions for inning headers
  const [hover, setHover] = useState(null);
  const [inningHover, setInningHover] = useState(null); // { inning, x, y }
  const inningTooltipRef = useRef(null);
  const [inningClampedPos, setInningClampedPos] = useState(null);
  const [dims, setDims] = useState({ w: 0 });
  const [highlightType, setHighlightType] = useState(null);
  const [lockedType, setLockedType] = useState(null);
  const [mobileTooltipVis, setMobileTooltipVis] = useState(null);

  // The chart is sliced into vertical panels, each with a velo header above it.
  // ONE game slices by inning; a multi-game frame (the player page's All Games)
  // slices by game — panelling a season by inning would pool every start's 3rd
  // inning into one header. Everything downstream is panel-generic, so the two
  // modes are the same chart with a different definition of "panel".
  const byGame = groupBy === "game";

  const { ordered, panelBounds, typeStats, pitchTypes, globalMin, globalMax, panelStats } = useMemo(() => {
    if (!pitches || pitches.length === 0)
      return { ordered: [], panelBounds: [], typeStats: {}, pitchTypes: [], globalMin: 0, globalMax: 0, panelStats: {} };

    const sorted = [...pitches].sort((a, b) => {
      // at_bat_number restarts every game, so across games the date leads.
      if (byGame) {
        const da = a.game_date || "", db = b.game_date || "";
        if (da !== db) return da < db ? -1 : 1;
        const ga = String(a.game_pk ?? ""), gb = String(b.game_pk ?? "");
        if (ga !== gb) return ga < gb ? -1 : 1;
      }
      if (a.at_bat_number != null && b.at_bat_number != null) {
        if (a.at_bat_number !== b.at_bat_number) return a.at_bat_number - b.at_bat_number;
        return (a.pitch_number || 0) - (b.pitch_number || 0);
      }
      return 0;
    });

    const keyOf = (p) => {
      const raw = byGame ? p.game_pk : p.inning;
      return raw == null ? null : String(raw);
    };
    const labelOf = (p) => (byGame ? shortGameDate(p.game_date) : ordinal(p.inning));

    const bounds = [];
    let lastKey = null;
    const ord = sorted.map((p, i) => {
      const key = keyOf(p);
      if (key != null && key !== lastKey) {
        // pitchIdx = first pitch of this panel; prevPitchIdx = last pitch of the previous one
        bounds.push({ pitchIdx: i + 1, prevPitchIdx: i, key, label: labelOf(p), inning: p.inning });
        lastKey = key;
      }
      return { ...p, _seqNum: i + 1, _panelKey: key };
    });

    const stats = {};
    let gMin = Infinity, gMax = -Infinity;
    // Per-panel velo. The fb/cutter buckets drive the default header (fastball
    // family); byType holds every pitch type so the header can switch to a
    // single focused type (legend lock or pitch-overview selection).
    const panStats = {};
    const mkBucket = () => ({ sum: 0, count: 0, min: Infinity, max: -Infinity });
    const addToBucket = (b, v) => { b.sum += v; b.count++; b.min = Math.min(b.min, v); b.max = Math.max(b.max, v); };
    for (const p of ord) {
      const name = p.pitch_name;
      if (!name || p.release_speed == null) continue;
      if (!stats[name]) stats[name] = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
      const s = stats[name];
      s.min = Math.min(s.min, p.release_speed);
      s.max = Math.max(s.max, p.release_speed);
      s.sum += p.release_speed;
      s.count++;
      gMin = Math.min(gMin, p.release_speed);
      gMax = Math.max(gMax, p.release_speed);

      // Per-panel velo: fastball-family default buckets + a per-type map
      const key = p._panelKey;
      if (key != null) {
        if (!panStats[key]) panStats[key] = { fb: mkBucket(), cutter: mkBucket(), byType: {} };
        const is = panStats[key];
        if (name === "Four-Seamer" || name === "Sinker") addToBucket(is.fb, p.release_speed);
        else if (name === "Cutter") addToBucket(is.cutter, p.release_speed);
        if (!is.byType[name]) is.byType[name] = mkBucket();
        addToBucket(is.byType[name], p.release_speed);
      }
    }
    for (const k of Object.keys(stats)) stats[k].avg = stats[k].sum / stats[k].count;

    // Sort pitch types by avg velo descending
    const types = Object.keys(stats).sort((a, b) => stats[b].avg - stats[a].avg);

    return { ordered: ord, panelBounds: bounds, typeStats: stats, pitchTypes: types, globalMin: gMin, globalMax: gMax, panelStats: panStats };
  }, [pitches, byGame]);

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

  const LEGEND_H = 32;
  const H = isMobile ? 280 : 340;

  // Locked type takes priority over hover
  const activeHighlight = lockedType || highlightType;
  // The pitch type whose per-inning velo drives the inning headers: an
  // explicitly locked legend type, or the sole remaining type once the
  // pitch-overview selection has filtered the data down to one. Null falls
  // back to the fastball-family default.
  const focusedType = lockedType || (pitchTypes.length === 1 ? pitchTypes[0] : null);

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dims.w === 0 || ordered.length === 0 || pitchTypes.length === 0) return;

    const W = dims.w;
    // Multiply DPR by the body zoom factor — the page lives inside
    // body { zoom: 1.25 } on desktop, which bilinearly upscales canvas
    // bitmaps. Allocating a 1.25× larger bitmap and ctx.scale-ing back to
    // CSS coords means the post-zoom paint lands 1:1 on screen pixels.
    const dpr = (window.devicePixelRatio || 1) * getDesktopZoom();
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const PAD = { top: 46, bottom: 40, left: 20, right: 70 };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const laneInnerPad = 6;
    const innerTop = PAD.top + laneInnerPad;
    const innerH = plotH - laneInnerPad * 2;

    ctx.fillStyle = "#252840";
    ctx.fillRect(0, 0, W, H);

    const totalPitches = ordered.length;
    const toX = (pn) => PAD.left + ((pn - 1) / Math.max(totalPitches - 1, 1)) * plotW;

    // Add 0.5mph padding to velocity range
    const veloPad = 0.5;
    const veloMin = globalMin - veloPad;
    const veloMax = globalMax + veloPad;
    const veloRange = veloMax - veloMin || 1;
    const toY = (velo) => innerTop + ((veloMax - velo) / veloRange) * innerH;

    // Build per-pitch panel index so dots can be clamped to their own panel
    const pitchPanelIdx = new Array(ordered.length).fill(0);
    for (let i = 0; i < panelBounds.length; i++) {
      const start = panelBounds[i].pitchIdx - 1;
      const end = i + 1 < panelBounds.length ? panelBounds[i + 1].pitchIdx - 1 : ordered.length;
      for (let j = start; j < end; j++) {
        pitchPanelIdx[j] = i;
      }
    }

    // Full lane background
    ctx.fillStyle = "rgba(255,255,255,0.02)";
    ctx.fillRect(PAD.left, innerTop, plotW, innerH);

    // Alternating panel shading
    const containerTop = innerTop;
    const containerBot = innerTop + innerH;
    // Precompute divider X positions (midpoint between last/first pitch of adjacent panels)
    const dividerXs = panelBounds.map(bd =>
      bd.prevPitchIdx > 0 ? (toX(bd.prevPitchIdx) + toX(bd.pitchIdx)) / 2 : PAD.left
    );
    for (let i = 0; i < panelBounds.length; i++) {
      const sx = dividerXs[i];
      const ex = i + 1 < dividerXs.length ? dividerXs[i + 1] : PAD.left + plotW;
      if (i % 2 === 1) {
        ctx.fillStyle = "rgba(255,255,255,0.02)";
        ctx.fillRect(sx, containerTop, ex - sx, containerBot - containerTop);
      }
    }

    // Draw dots — clamp each dot to its own inning's panel bounds
    const dots = [];
    for (const p of ordered) {
      if (!p.pitch_name || p.release_speed == null) continue;
      const color = PITCH_COLORS[p.pitch_name] || "#888";
      const rawX = toX(p._seqNum);
      // Determine this pitch's panel left/right edges
      const iIdx = pitchPanelIdx[p._seqNum - 1] || 0;
      const panelLeft = dividerXs[iIdx];
      const panelRight = iIdx + 1 < dividerXs.length ? dividerXs[iIdx + 1] : PAD.left + plotW;
      // Clamp dot within its own panel
      const cx = Math.max(panelLeft + DOT_PAD + DOT_R, Math.min(panelRight - DOT_PAD - DOT_R, rawX));
      const rawY = toY(p.release_speed);
      const cy = Math.max(innerTop + DOT_R + DOT_PAD, Math.min(innerTop + innerH - DOT_R - DOT_PAD, rawY));

      const isDimmed = activeHighlight && p.pitch_name !== activeHighlight;

      // Glow for run-scored pitches
      if (isRunScored(p) && !isDimmed) {
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
      ctx.globalAlpha = isDimmed ? 0.2 : 0.85;
      ctx.beginPath();
      ctx.arc(cx, cy, DOT_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      dots.push({ x: cx, y: cy, pitch: p });
    }

    // Panel dividers
    for (let i = 0; i < panelBounds.length; i++) {
      if (panelBounds[i].prevPitchIdx <= 0) continue;
      const x = dividerXs[i];
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

    // Panel headers: "<label>: avg (min / max)" centered above each panel —
    // "3rd" for an inning-sliced chart, "8/14" for a game-sliced one.
    // Default tracks the fastball family (4-seam/sinker, cutter fallback); when
    // a single pitch type is focused (legend lock or pitch-overview selection)
    // the headers show that type's per-panel velo instead.
    const headerBucket = (is) => {
      if (!is) return null;
      if (focusedType) return is.byType[focusedType] || null;
      return is.fb.count > 0 ? is.fb : is.cutter;
    };
    // Frame-wide avg of the same series; per-panel delta colors against it.
    let gameRefSum = 0, gameRefCount = 0;
    for (const key of Object.keys(panelStats)) {
      const bucket = headerBucket(panelStats[key]);
      if (bucket && bucket.count > 0) { gameRefSum += bucket.sum; gameRefCount += bucket.count; }
    }
    const gameRefAvg = gameRefCount > 0 ? gameRefSum / gameRefCount : 0;

    // 5-step gradient: cyan → light blue → tertiary → light red → four-seamer red
    const VELO_GRADIENT = [
      { threshold: -1.5, color: "#55e8ff" },   // cyan
      { threshold: -0.75, color: "#7DC8F0" },   // light blue
      { threshold: 0.75, color: "#E0E2EC" },    // table text
      { threshold: 1.5, color: "#F0889A" },      // light red
      { threshold: Infinity, color: "#FF839B" }, // four-seamer red
    ];
    function veloGradientColor(delta) {
      for (const step of VELO_GRADIENT) {
        if (delta <= step.threshold) return step.color;
      }
      return VELO_GRADIENT[VELO_GRADIENT.length - 1].color;
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const headerHitRegions = [];
    const HDR_BOLD = "bold 12.5px 'DM Sans', sans-serif";
    const HDR_PLAIN = "12.5px 'DM Sans', sans-serif";
    for (let i = 0; i < panelBounds.length; i++) {
      const bd = panelBounds[i];
      const sx = dividerXs[i];
      const ex = i + 1 < dividerXs.length ? dividerXs[i + 1] : PAD.left + plotW;
      const centerX = (sx + ex) / 2;

      const is = panelStats[bd.key];
      const bucket = headerBucket(is);
      if (!bucket || bucket.count === 0) continue;

      const avg = bucket.sum / bucket.count;
      const delta = avg - gameRefAvg;
      const headerColor = veloGradientColor(delta);

      const avgOnly = avg.toFixed(1);
      // A panel with no name (a game row missing game_date) shows its velo alone
      // rather than a stray ": 95.4".
      const label = bd.label ? `${bd.label}: ${avgOnly}` : avgOnly;
      const range = `(${bucket.min.toFixed(1)} / ${bucket.max.toFixed(1)})`;

      // Headers degrade with panel width instead of overlapping into mush — a
      // 26-start season packs panels into a fraction of an inning's width.
      // Shed the range first, then break the one-line header into stacked
      // name-over-velo, and only give up the panel's identity when even its
      // name won't fit.
      const avail = ex - sx - 6;
      ctx.font = HDR_BOLD;
      const wLabel = ctx.measureText(label).width;
      const wAvg = ctx.measureText(avgOnly).width;
      ctx.font = HDR_PLAIN;
      const wRange = ctx.measureText(range).width;
      const wName = ctx.measureText(bd.label).width;

      let line1 = null, line2 = null;
      if (wLabel <= avail && wRange <= avail) {
        line1 = { text: label, font: HDR_BOLD, color: headerColor };
        line2 = { text: range, font: HDR_PLAIN, color: "#E0E2EC" };
      } else if (wLabel <= avail) {
        line1 = { text: label, font: HDR_BOLD, color: headerColor };
      } else if (bd.label && wName <= avail && wAvg <= avail) {
        line1 = { text: bd.label, font: HDR_PLAIN, color: "#E0E2EC" };
        line2 = { text: avgOnly, font: HDR_BOLD, color: headerColor };
      } else if (wAvg <= avail) {
        line1 = { text: avgOnly, font: HDR_BOLD, color: headerColor };
      } else {
        continue;
      }

      // Vertically center the header (two lines with a 4px gap, or one line)
      // between the top of the canvas and the chart
      const lineH = 12.5;
      const gap = 4;
      const totalH = line2 ? lineH * 2 + gap : lineH;
      const midY = containerTop / 2;
      const line1Y = midY - totalH / 2 + lineH / 2;
      const line2Y = line1Y + lineH + gap;

      ctx.globalAlpha = 1;
      ctx.textBaseline = "middle";
      ctx.font = line1.font;
      ctx.fillStyle = line1.color;
      ctx.fillText(line1.text, centerX, line1Y);
      if (line2) {
        ctx.font = line2.font;
        ctx.fillStyle = line2.color;
        ctx.fillText(line2.text, centerX, line2Y);
      }

      // Store hit region for panel header hover (inning tooltip is inning-only)
      headerHitRegions.push({ inning: bd.inning, left: sx, right: ex, top: 0, bottom: containerTop });
    }
    inningHeadersRef.current = headerHitRegions;

    // Right side label area
    const rx = PAD.left + plotW + 8;

    // Swim lane overlay when a pitch type is locked
    if (lockedType && typeStats[lockedType]) {
      const ls = typeStats[lockedType];
      const laneColor = PITCH_COLORS[lockedType] || "#888";
      const laneTopY = toY(ls.max);
      const laneBotY = toY(ls.min);
      const laneAvgY = toY(ls.avg);

      // Top and bottom boundary lines
      ctx.save();
      ctx.strokeStyle = laneColor;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, laneTopY);
      ctx.lineTo(PAD.left + plotW, laneTopY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(PAD.left, laneBotY);
      ctx.lineTo(PAD.left + plotW, laneBotY);
      ctx.stroke();

      // Semi-transparent lane fill
      ctx.fillStyle = laneColor;
      ctx.globalAlpha = 0.06;
      ctx.fillRect(PAD.left, laneTopY, plotW, laneBotY - laneTopY);

      // Dotted average line
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = laneColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, laneAvgY);
      ctx.lineTo(PAD.left + plotW, laneAvgY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Right-side labels for locked type: max, avg, min — with anti-overlap
      ctx.font = "bold 10px 'DM Sans', sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const LANE_LABEL_H = 14; // ~10px font + 2px padding each side
      const laneMidY = innerTop + innerH / 2;
      const laneLabels = [
        { y: laneTopY, text: ls.max.toFixed(1), alpha: 0.8 },
        { y: laneAvgY, text: ls.avg.toFixed(1), alpha: 1 },
        { y: laneBotY, text: ls.min.toFixed(1), alpha: 0.8 },
      ].sort((a, b) => a.y - b.y);
      // Multi-pass: resolve overlaps by pushing the label further from chart center
      for (let pass = 0; pass < laneLabels.length; pass++) {
        let anyOverlap = false;
        for (let i = 1; i < laneLabels.length; i++) {
          const gap = laneLabels[i].y - laneLabels[i - 1].y;
          if (gap < LANE_LABEL_H) {
            anyOverlap = true;
            const pairMid = (laneLabels[i - 1].y + laneLabels[i].y) / 2;
            if (pairMid <= laneMidY) {
              // Top half: keep top label, push bottom one down
              laneLabels[i].y = laneLabels[i - 1].y + LANE_LABEL_H;
            } else {
              // Bottom half: keep bottom label, push top one up
              laneLabels[i - 1].y = laneLabels[i].y - LANE_LABEL_H;
            }
          }
        }
        if (!anyOverlap) break;
      }
      for (const lbl of laneLabels) {
        ctx.fillStyle = laneColor;
        ctx.globalAlpha = lbl.alpha;
        ctx.fillText(lbl.text, rx, lbl.y);
      }
      ctx.globalAlpha = 1;
    } else {
      // Default: hardest at top, softest at bottom (global range labels)
      ctx.font = "bold 10px 'DM Sans', sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(180,184,210,0.5)";
      ctx.fillText(globalMax.toFixed(1), rx, innerTop + 6);
      ctx.fillText(globalMin.toFixed(1), rx, innerTop + innerH - 4);

      // Right side: per-type average velocity labels with anti-overlap
      const avgLabels = pitchTypes.map(type => {
        const s = typeStats[type];
        const y = toY(s.avg);
        const color = PITCH_COLORS[type] || "#888";
        return { type, y, label: s.avg.toFixed(1), color };
      });

      // Anti-overlap: ensure at least 2px padding between labels (LABEL_H = text height + padding)
      const LABEL_H = 14; // ~10px font + 2px padding each side
      const chartMidY = innerTop + innerH / 2;
      const resolvedLabels = [...avgLabels].sort((a, b) => a.y - b.y);
      // Multi-pass: resolve overlaps by pushing the label further from chart center
      for (let pass = 0; pass < resolvedLabels.length; pass++) {
        let anyOverlap = false;
        for (let i = 1; i < resolvedLabels.length; i++) {
          const prev = resolvedLabels[i - 1];
          const cur = resolvedLabels[i];
          const gap = cur.y - prev.y;
          if (gap < LABEL_H) {
            anyOverlap = true;
            const overlap = LABEL_H - gap;
            const pairMid = (prev.y + cur.y) / 2;
            if (pairMid <= chartMidY) {
              // Top half: keep top label, push bottom one down
              cur.y = prev.y + LABEL_H;
            } else {
              // Bottom half: keep bottom label, push top one up
              prev.y = cur.y - LABEL_H;
            }
          }
        }
        if (!anyOverlap) break;
      }

      for (const lbl of resolvedLabels) {
        const isDimmed = activeHighlight && lbl.type !== activeHighlight;
        ctx.fillStyle = lbl.color;
        ctx.globalAlpha = isDimmed ? 0.3 : 0.9;
        ctx.font = "bold 10px 'DM Sans', sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(lbl.label, rx, lbl.y);
        ctx.globalAlpha = 1;
      }
    }

    // X-axis: cumulative pitch numbers, spaced to the size of the frame
    ctx.fillStyle = "#FFFFF0";
    ctx.font = "12px 'DM Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const tickStep = axisTickStep(totalPitches);
    for (let i = tickStep; i <= totalPitches; i += tickStep) {
      ctx.fillText(i, toX(i), containerBot + 8);
    }

    dotsRef.current = dots;
  }, [ordered, pitchTypes, typeStats, panelBounds, panelStats, dims, globalMin, globalMax, activeHighlight, lockedType, focusedType]);

  // Hover handling
  const handleMouseMove = useCallback(
    (e) => {
      if (isMobile) return; // mobile uses tap instead
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (dims.w / rect.width);
      const my = (e.clientY - rect.top) * (H / rect.height);

      // Check inning header hover first
      const headers = inningHeadersRef.current;
      let hitHeader = null;
      for (const h of headers) {
        if (mx >= h.left && mx <= h.right && my >= h.top && my <= h.bottom) {
          hitHeader = h;
          break;
        }
      }
      // Play-by-play behind a header is an inning-panel idea — a game panel
      // covers nine of them, and the season chart has no linescore anyway.
      if (hitHeader && hitHeader.inning != null && !byGame && linescoreData?.plays) {
        setInningHover({ inning: hitHeader.inning, x: e.clientX, y: e.clientY });
        setHover(null);
        canvas.style.cursor = "default";
        return;
      } else {
        setInningHover(null);
      }

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
    [dims, isMobile, H, linescoreData, byGame]
  );

  const handleMouseLeave = useCallback(() => {
    if (!isMobile) {
      setHover(null);
      setInningHover(null);
    }
  }, [isMobile]);

  const handleClick = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);
    const dots = dotsRef.current;
    let near = null, md = 14;
    for (const d of dots) {
      const dist = Math.hypot(mx - d.x, my - d.y);
      if (dist < md) { md = dist; near = d; }
    }

    if (isMobile) {
      // Mobile: show/hide tooltip on tap
      if (near) {
        if (mobileTooltipVis && mobileTooltipVis.pitch === near.pitch) {
          setMobileTooltipVis(null);
        } else {
          setMobileTooltipVis({ pitch: near.pitch, x: e.clientX, y: e.clientY });
        }
      } else {
        setMobileTooltipVis(null);
      }
    } else {
      // Desktop: reclassify on click
      if (near && onReclassify) onReclassify(near.pitch);
    }
  }, [isMobile, mobileTooltipVis, onReclassify]);

  const handleLegendClick = (type) => {
    setLockedType(prev => prev === type ? null : type);
  };

  const hp = hover?.pitch;
  const mobileShowTooltip = isMobile && mobileTooltipVis;

  const handleTapElsewhere = useCallback((e) => {
    if (isMobile && mobileTooltipVis && !e.target.closest(".pitch-tooltip")) {
      setMobileTooltipVis(null);
    }
  }, [isMobile, mobileTooltipVis]);

  // --- Inning tooltip helpers (scoreboard-style play-by-play) ---
  const getPlays = useCallback((inning, isTop) => {
    if (!linescoreData?.plays) return [];
    const half = linescoreData.plays.find(p => p.inning === inning && p.top === isTop);
    return half ? half.pas : [];
  }, [linescoreData]);

  // Gather plays for the inning tooltip — show only the half where the featured pitcher was pitching
  // If no featured pitcher, show both halves
  const inningTooltipHalves = useMemo(() => {
    if (!inningHover || !linescoreData?.plays) return [];
    const inn = inningHover.inning;
    const halves = [];
    const topPas = getPlays(inn, true);
    if (topPas.length > 0) halves.push({ isTop: true, pas: topPas, inning: inn });
    const botPas = getPlays(inn, false);
    if (botPas.length > 0) halves.push({ isTop: false, pas: botPas, inning: inn });
    // If we have a featured pitcher, filter to only halves where they pitched
    if (pitcherId && halves.length > 0) {
      const pitcherHalves = halves.filter(h => h.pas.some(pa => pa.pitcher_id === pitcherId));
      if (pitcherHalves.length > 0) return pitcherHalves;
    }
    return halves;
  }, [inningHover, linescoreData, getPlays, pitcherId]);

  // Determine which halves the featured pitcher pitched in
  const pitcherHalfInnings = useMemo(() => {
    const result = {};
    for (const half of inningTooltipHalves) {
      const isPitching = pitcherId && half.pas.some(pa => pa.pitcher_id === pitcherId);
      result[half.isTop ? "top" : "bot"] = isPitching;
    }
    return result;
  }, [inningTooltipHalves, pitcherId]);

  // Cumulative pitch counts for featured pitcher
  const cumulativePitchCount = useMemo(() => {
    if (!pitcherId || !linescoreData?.plays || !inningHover) return 0;
    return linescoreData.plays.reduce((sum, half) => {
      if (half.inning > inningHover.inning) return sum;
      return sum + (half.pas || []).reduce((s, pa) => {
        return s + (pa.pitcher_id === pitcherId && pa.pitches ? pa.pitches.length : 0);
      }, 0);
    }, 0);
  }, [pitcherId, linescoreData, inningHover]);

  // Viewport-clamp the inning tooltip
  useEffect(() => {
    if (!inningHover || !inningTooltipRef.current) return;
    const tooltipRect = inningTooltipRef.current.getBoundingClientRect();
    const padding = 10;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let left = inningHover.x;
    let top = inningHover.y + 12; // below cursor
    if (left - tooltipRect.width / 2 < padding) left = tooltipRect.width / 2 + padding;
    else if (left + tooltipRect.width / 2 > viewportWidth - padding) left = viewportWidth - tooltipRect.width / 2 - padding;
    if (top + tooltipRect.height > viewportHeight - padding) top = inningHover.y - tooltipRect.height - 12;
    setInningClampedPos({ left, top });
  }, [inningHover]);

  // Empty-state return sits below every hook so they run unconditionally
  // (react-hooks/rules-of-hooks).
  if (!pitches || pitches.length === 0 || pitchTypes.length === 0) {
    return (
      <div className="velocity-trend-empty" style={{ padding: 32, textAlign: "center", color: "var(--text-dim)" }}>
        No pitch data available for velocity trend.
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="velocity-trend-wrap" style={{ position: "relative", width: "100%" }} onClick={handleTapElsewhere}>
      {/* Pitch type legend — horizontal, text only (no dots), centered */}
      <div
        style={{ display: "flex", gap: 0, padding: "6px 20px 10px", flexWrap: "wrap", justifyContent: "center", width: "fit-content", margin: "0 auto" }}
        onMouseLeave={() => { if (!lockedType) setHighlightType(null); }}
      >
        {pitchTypes.map(type => {
          const color = PITCH_COLORS[type] || "#888";
          const isDimmed = activeHighlight && activeHighlight !== type;
          return (
            <span
              key={type}
              onClick={() => handleLegendClick(type)}
              onMouseEnter={() => { if (!lockedType) setHighlightType(type); }}
              style={{
                color,
                opacity: isDimmed ? 0.4 : 1,
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
                transition: "opacity 0.15s",
                fontFamily: "'DM Sans', sans-serif",
                padding: "2px 10px",
              }}
            >
              {type}
            </span>
          );
        })}
      </div>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: H + "px", borderRadius: 8, display: "block", cursor: onReclassify ? "pointer" : "default" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      />
      {hp && !isMobile && <VelocityTooltipV2 pitch={hp} x={hover.x} y={hover.y} />}
      {mobileShowTooltip && <VelocityTooltipV2Mobile pitch={mobileTooltipVis.pitch} x={mobileTooltipVis.x} y={mobileTooltipVis.y} onClose={() => setMobileTooltipVis(null)} />}

      {/* Inning header tooltip — scoreboard-style play-by-play */}
      {inningHover && inningTooltipHalves.length > 0 && linescoreData && (
        <div ref={inningTooltipRef} className="sb-tooltip"
          style={{
            // Inline coords are in body's zoomed coord system; convert from
            // viewport coords so the tooltip lands at the intended pixel.
            left: vpToZoomCoord(inningClampedPos?.left || inningHover.x),
            top: vpToZoomCoord(inningClampedPos?.top || (inningHover.y + 12)),
            transform: "translateX(-50%)",
          }}>
          {inningTooltipHalves.map((half, hi) => {
            const isFeaturedPitcherPitching = pitcherHalfInnings[half.isTop ? "top" : "bot"];
            const tooltipInningPitches = half.pas.reduce((sum, pa) => {
              return sum + (pa.pitcher_id === pitcherId && pa.pitches ? pa.pitches.length : 0);
            }, 0);

            return (
              <React.Fragment key={hi}>
                {hi > 0 && <div style={{ borderTop: "1px solid var(--border, rgba(255,255,255,0.1))", margin: "8px 0" }} />}
                <div className="sb-tooltip-hdr" style={{
                  fontSize: "14px", fontWeight: 700, marginBottom: "8px",
                  display: "flex", flexDirection: "row", gap: "4px",
                  alignItems: "baseline", textTransform: "none", letterSpacing: "normal",
                }}>
                  <span style={{ color: isFeaturedPitcherPitching ? "var(--accent, #38BDF8)" : "var(--text-bright)" }}>
                    {half.isTop ? `Top ${ordinal(half.inning)}` : `Bot ${ordinal(half.inning)}`}
                  </span>
                  <span style={{ color: "var(--text-dim)" }}>—</span>
                  <span style={{ color: isFeaturedPitcherPitching ? "var(--accent, #38BDF8)" : "var(--text-bright)" }}>
                    {half.pas[0]?.pitcher || "Unknown"}
                  </span>
                  <span style={{ color: "var(--text-dim)" }}>vs.</span>
                  <span style={{ color: "var(--text-dim)" }}>
                    {displayAbbrev(half.isTop ? linescoreData.home_team : linescoreData.away_team)}
                  </span>
                </div>
                {isFeaturedPitcherPitching && (
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6, display: "flex", gap: 12 }}>
                    <span>Total Pitches: <span style={{ color: "var(--text-bright)", fontWeight: 600 }}>{cumulativePitchCount}</span></span>
                    <span>Pitches: <span style={{ color: "var(--text-bright)", fontWeight: 600 }}>{tooltipInningPitches}</span></span>
                  </div>
                )}
                {half.pas.map((pa, i) => {
                  const prevPa = i > 0 ? half.pas[i - 1] : null;
                  const isPitcherChange = prevPa && prevPa.pitcher_id !== pa.pitcher_id;
                  const isFeaturedPa = isFeaturedPitcherPitching && pa.pitcher_id === pitcherId;
                  const resultColor = isFeaturedPa ? getPBPResultColor(pa.result) : null;
                  const isCIErr = isCIOrErrorEvent(pa.result);
                  const _r = (pa.result || "").toLowerCase().replace(/\s+/g, "_");
                  const _isHit = _r === "single" || _r === "double" || _r === "triple";
                  const isHitWithOut = _isHit && /\bout at\b|\bout advancing\b|\bthrown out\b/i.test(pa.description || "");
                  const midAbActions = (pa.pitches || []).filter(p => p.is_action && (p.scored || ["Wild Pitch", "Caught Stealing", "Pickoff CS", "Passed Ball", "Balk"].some(e => (p.event_type || "").toLowerCase().includes(e.toLowerCase()) || (p.desc || "").toLowerCase().includes(e.toLowerCase()))));
                  const actionRuns = midAbActions.filter(a => a.scored).reduce((sum) => sum + 1, 0);
                  let runsScored = 0;
                  if (pa.home_score != null && pa.away_score != null) {
                    const prevHome = prevPa?.home_score ?? null;
                    const prevAway = prevPa?.away_score ?? null;
                    if (prevHome != null && prevAway != null) {
                      runsScored = (pa.home_score + pa.away_score) - (prevHome + prevAway);
                    } else if (i === 0) {
                      const prevHalfPlays = getPlays(half.isTop ? half.inning - 1 : half.inning, half.isTop ? false : true);
                      const lastPrevPa = prevHalfPlays.length > 0 ? prevHalfPlays[prevHalfPlays.length - 1] : null;
                      if (lastPrevPa && lastPrevPa.home_score != null && lastPrevPa.away_score != null) {
                        runsScored = (pa.home_score + pa.away_score) - (lastPrevPa.home_score + lastPrevPa.away_score);
                      } else if (pa.rbi > 0) { runsScored = pa.rbi; }
                    }
                  }
                  if (runsScored < 0) runsScored = 0;
                  const paResultRuns = Math.max(0, runsScored - actionRuns);
                  const midAbAwayScore = pa.away_score != null ? pa.away_score - (half.isTop ? paResultRuns : 0) : null;
                  const midAbHomeScore = pa.home_score != null ? pa.home_score - (half.isTop ? 0 : paResultRuns) : null;

                  return (
                    <React.Fragment key={i}>
                      {isPitcherChange && (
                        <div className="sb-tooltip-relief">
                          {prevPa.pitcher} relieved by {pa.pitcher}
                        </div>
                      )}
                      <div className={`sb-tooltip-pa${isFeaturedPa ? " sb-hl" : ""}`}
                        style={isFeaturedPa ? { color: resultColor || "var(--text-bright)", fontWeight: 600 } : (isCIErr ? { color: "#feffa3", fontWeight: 600 } : {})}>
                        {(() => {
                          const desc = pa.description || `${pa.batter}: ${pa.result}`;
                          // Centralized sentence-level coloring so "scores" sentences,
                          // CI/error batter events, and hit-with-out outs render
                          // consistently across all PBP tooltips.
                          const spans = getPADescriptionSpans(desc, { isCIOrError: isCIErr, isHitWithOut });
                          return spans.map((s, idx) => (
                            <span key={idx} style={s.style || undefined}>{s.text}</span>
                          ));
                        })()}
                        {midAbActions.length > 0 && midAbActions.map((action, ai) => (
                          <div key={`action-${ai}`} style={{ fontSize: 10, padding: "1px 0 1px 0", lineHeight: 1.3, fontStyle: "italic", color: action.scored ? "#FF5EDC" : "rgba(180,184,210,0.7)" }}>
                            {action.desc}
                          </div>
                        ))}
                        {actionRuns > 0 && midAbAwayScore != null && (
                          <div style={{ fontSize: 10, padding: "1px 0 3px 0", lineHeight: 1.3 }}>
                            <span style={{ color: "#FF5EDC", fontWeight: 600 }}>{actionRuns} run{actionRuns > 1 ? "s" : ""} score{actionRuns === 1 ? "s" : ""}</span>{" "}
                            <span style={{ color: "var(--text-bright)" }}>
                              <span style={{ color: half.isTop ? "#ffc277" : "var(--text-bright)" }}>{displayAbbrev(linescoreData.away_team)}</span>
                              {" "}{midAbAwayScore} - {midAbHomeScore}{" "}
                              <span style={{ color: half.isTop ? "var(--text-bright)" : "#ffc277" }}>{displayAbbrev(linescoreData.home_team)}</span>
                            </span>
                          </div>
                        )}
                        {paResultRuns > 0 && pa.home_score != null && (
                          <div style={{ fontSize: 10, padding: "1px 0 3px 0", lineHeight: 1.3 }}>
                            <span style={{ color: "#FF5EDC", fontWeight: 600 }}>{paResultRuns} run{paResultRuns > 1 ? "s" : ""} score{paResultRuns === 1 ? "s" : ""}</span>{" "}
                            <span style={{ color: "var(--text-bright)" }}>
                              <span style={{ color: half.isTop ? "#ffc277" : "var(--text-bright)" }}>{displayAbbrev(linescoreData.away_team)}</span>
                              {" "}{pa.away_score} - {pa.home_score}{" "}
                              <span style={{ color: half.isTop ? "var(--text-bright)" : "#ffc277" }}>{displayAbbrev(linescoreData.home_team)}</span>
                            </span>
                          </div>
                        )}
                      </div>
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VelocityTooltipV2Mobile({ pitch: p, x, y, onClose }) {
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
    // Inline coords are in zoomed coord system on desktop; convert from
    // viewport coords so the tooltip lands at the cursor.
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

function VelocityTooltipV2({ pitch: p, x, y }) {
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
    left: vpToZoomCoord(leftVp),
    top: vpToZoomCoord(topVp),
    zIndex: 1000,
    pointerEvents: "none",
  };

  return (
    <div className="pitch-tooltip" style={style}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: isBIP ? 0 : 4 }}>
        <div style={{ whiteSpace: "nowrap" }}>
          <span style={{ color: dc, fontWeight: 600 }}>{p.pitch_name}</span>
          <span style={{ marginLeft: 6, color: "#e0e2ec" }}>
            {p.release_speed ? p.release_speed.toFixed(1) + " mph" : ""}
          </span>
          <span style={{ marginLeft: 6, color: "rgba(180,184,210,0.5)", fontSize: "0.85em" }}>#{p._seqNum}</span>
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
