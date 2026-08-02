import React, { useState, useEffect } from "react";
import { PITCH_TYPE_FILTERS, PITCH_COLORS } from "../constants";

export default function ReclassifyModal({ pitch, gamePk, pitcherId, date, onConfirm, onClose }) {
  const [newType, setNewType] = useState("");

  useEffect(() => {
    const handleKey = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  if (!pitch) return null;

  const currentName = pitch.pitch_name || "Unknown";
  const currentColor = PITCH_COLORS[currentName] || "#ccc";

  const handleSubmit = () => {
    if (!newType || newType === currentName) return;
    onConfirm({
      game_pk: gamePk,
      pitcher_id: pitcherId,
      at_bat_number: pitch.at_bat_number,
      pitch_number: pitch.pitch_number,
      new_pitch_type: newType,
      date: date || "",
    });
  };

  return (
    <div className="reclass-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="reclass-panel">
        <div className="reclass-header">
          <span className="reclass-title">Reclassify Pitch</span>
          <button className="reclass-close" onClick={onClose}>&times;</button>
        </div>
        <div className="reclass-body">
          <div className="reclass-current">
            Currently classified as:
            <span className="reclass-current-type" style={{ color: currentColor }}>{currentName}</span>
          </div>
          {pitch.release_speed && (
            <div className="reclass-detail">{pitch.release_speed.toFixed(1)} mph</div>
          )}
          {pitch.batter_name && (
            <div className="reclass-detail">vs {pitch.batter_name}</div>
          )}
          <div className="reclass-select-label">Change to:</div>
          <select className="reclass-dropdown" value={newType} onChange={e => setNewType(e.target.value)}>
            <option value="">-- Select pitch type --</option>
            {PITCH_TYPE_FILTERS.map(pt => (
              <option key={pt} value={pt} disabled={pt === currentName}>{pt}</option>
            ))}
          </select>
        </div>
        <div className="reclass-actions">
          <button className="reclass-btn reclass-btn-cancel" onClick={onClose}>Cancel</button>
          <button className="reclass-btn reclass-btn-confirm" onClick={handleSubmit} disabled={!newType || newType === currentName}>
            Change
          </button>
        </div>
      </div>
    </div>
  );
}
