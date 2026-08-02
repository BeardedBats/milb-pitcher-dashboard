import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { PITCH_COLORS } from "../constants";
import useIsMobile from "../hooks/useIsMobile";

// Horizontal gutter (px) between the full-width mobile menu and each viewport edge.
const MOBILE_GUTTER = 12;

/**
 * Generic checkbox-dropdown for filtering pitches.
 * mode = "pitch-type" | "pitch-result"
 *
 * Props:
 *  - options: string[]          — available option labels
 *  - selected: Set<string>      — currently-selected option labels
 *  - onChange: (Set<string>) =>  — called when selection changes
 *  - label: string              — button label text
 *  - quickActions: { label, fn(currentSet, allOptions) => newSet }[]
 *  - columns: number            — # of grid columns (default 1)
 *  - colorMap: { [label]: color } — optional dot colors
 *  - isMobile: boolean          — mobile mode (forces single column)
 */
export default function PitchFilterDropdown({
  options, selected, onChange, label, quickActions, columns = 1, colorMap, menuHeader, isMobile: isMobileProp,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const detectedMobile = useIsMobile();
  // Prefer the explicit prop when a parent passes one; otherwise self-detect.
  const isMobile = isMobileProp != null ? isMobileProp : detectedMobile;
  const [menuStyle, setMenuStyle] = useState(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // On mobile, anchor the full-width menu to the VIEWPORT with position:fixed
  // instead of position:absolute relative to the button. The absolute+right:0
  // approach overflowed the left edge whenever the button wasn't flush against
  // the right viewport edge (the bug Safari surfaced). We keep it vertically
  // pinned just below the button by measuring the button rect.
  useLayoutEffect(() => {
    if (!open || !isMobile) {
      setMenuStyle(null);
      return;
    }
    const reposition = () => {
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      setMenuStyle({
        position: "fixed",
        top: Math.round(rect.bottom + 4),
        left: MOBILE_GUTTER,
        right: MOBILE_GUTTER,
        minWidth: 0,
        maxWidth: "none",
        maxHeight: `calc(100vh - ${Math.round(rect.bottom + 4)}px - ${MOBILE_GUTTER}px)`,
      });
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, isMobile]);

  const allSelected = options.length > 0 && options.every(o => selected.has(o));
  const noneSelected = selected.size === 0;
  const someFiltered = !allSelected && !noneSelected;

  const toggle = (opt) => {
    const next = new Set(selected);
    if (next.has(opt)) next.delete(opt);
    else next.add(opt);
    onChange(next);
  };

  const selectAll = () => onChange(new Set(options));
  const deselectAll = () => onChange(new Set());

  return (
    <div className="pf-dropdown" ref={ref}>
      <button
        className={`pf-dropdown-btn${someFiltered ? " pf-filtered" : ""}`}
        onClick={() => setOpen(!open)}
      >
        {label}
        {someFiltered && <span className="pf-badge">{selected.size}</span>}
      </button>
      {open && (
        <div className={`pf-menu${!isMobile && columns > 1 ? " pf-multi-col" : ""}`} style={menuStyle || undefined}>
          {menuHeader && <div className="pf-menu-header">{menuHeader}</div>}
          <div className="pf-quick-row">
            <span className="pf-quick" onClick={selectAll}>All</span>
            <span className="pf-quick" onClick={deselectAll}>None</span>
            {quickActions?.map((qa, i) => (
              <span key={i} className="pf-quick" onClick={() => onChange(qa.fn(selected, options))}>{qa.label}</span>
            ))}
          </div>
          <div className="pf-options" style={!isMobile && columns > 1 ? { gridTemplateColumns: `repeat(${columns}, 1fr)` } : undefined}>
            {options.map(opt => (
              <label key={opt} className="pf-option" onClick={() => toggle(opt)}>
                <span className={`pf-check${selected.has(opt) ? " pf-checked" : ""}`}>
                  {selected.has(opt) ? "✓" : ""}
                </span>
                {colorMap?.[opt] && (
                  <span className="pf-color-dot" style={{ background: colorMap[opt] }} />
                )}
                <span className="pf-opt-label">{opt}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
