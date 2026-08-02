import React, { useMemo } from "react";
import { getPitchColor } from "../constants";

export default function UsageBar({ pitchTable, side, title }) {
  const bars = useMemo(() => {
    if (!pitchTable || !pitchTable.length) return [];
    const rows = pitchTable.map(r => {
      const countKey = side === "R" ? "count_vs_r" : "count_vs_l";
      const usageKey = side === "R" ? "usage_vs_r" : "usage_vs_l";
      return { pitch_name: r.pitch_name, count: r[countKey] || 0, usage: r[usageKey] || 0 };
    }).filter(r => r.count > 0);
    rows.sort((a, b) => b.usage - a.usage);
    return rows;
  }, [pitchTable, side]);

  if (!bars.length) return null;

  return (
    <div className="usage-card">
      {title && <div className="usage-title">{title}</div>}
      {bars.map(b => (
        <div className="usage-bar-row" key={b.pitch_name}>
          <div className="usage-bar-label" style={{ color: getPitchColor(b.pitch_name) }}>
            {b.pitch_name}
          </div>
          <div className="usage-bar-track">
            <div className="usage-bar-fill" style={{
              width: `${Math.min(b.usage, 100)}%`,
              background: getPitchColor(b.pitch_name),
              opacity: 0.8,
            }} />
          </div>
          <div className="usage-bar-pct" style={{ color: getPitchColor(b.pitch_name) }}>{Math.round(b.usage)}%</div>
        </div>
      ))}
    </div>
  );
}
