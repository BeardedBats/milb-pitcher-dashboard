import React from "react";

// One game's pitch mix as a single 100%-width stacked composition bar.
// Segments are in canonical arsenal order; an untracked remainder renders as a
// faint neutral "other" segment so the bar never silently normalizes away the
// mass it isn't showing. Each segment exposes "pitch · % · velo" on hover/tap
// (styled tooltip) and via title/aria-label for keyboard + screen readers.
export default function PitchMixBar({ segments, other }) {
  if (!segments || segments.length === 0) return <span className="gl-mix-empty">—</span>;
  const tip = (s) => `${s.name} · ${Math.round(s.pct)}%${s.velo != null ? ` · ${s.velo.toFixed(1)} mph` : ""}`;
  return (
    <div className="gl-mixbar" role="img" aria-label={segments.map(tip).join(", ") || "no tracked pitches"}>
      {segments.map((s) => (
        <div
          key={s.name}
          className="gl-mixbar-seg"
          style={{ width: `${s.pct}%`, background: s.color }}
          title={tip(s)}
          aria-hidden="true"
        >
          <span className="gl-mixbar-tip"><b style={{ color: s.color }}>{s.code}</b> {Math.round(s.pct)}%{s.velo != null ? ` · ${s.velo.toFixed(1)}` : ""}</span>
        </div>
      ))}
      {other > 0.5 && (
        <div
          className="gl-mixbar-seg gl-mixbar-other"
          style={{ width: `${other}%` }}
          title={`Other / untracked · ${Math.round(other)}%`}
          aria-hidden="true"
        >
          <span className="gl-mixbar-tip">Other {Math.round(other)}%</span>
        </div>
      )}
    </div>
  );
}
