import React from "react";

// Box Score on the pitcher card: the single game line plus the season-totals
// rate row. Mechanically extracted from PitcherCard; behavior unchanged.
export default function BoxScoreSection({ result, nameWithOrg, projectedDecision, gameLive, seasonTotals }) {
  if (!result) return null;
  return (
    <div className="card-gameline-box">
      <div className="card-gameline-header">
        <span>Box Score</span>
        {gameLive && <span style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 400, marginLeft: "auto" }}>* = Decision if the game ended now</span>}
      </div>
      <table className="card-gameline-table">
        <thead>
          <tr>
            <th>Pitcher</th><th>Dec</th><th>IP</th><th>R</th><th>ER</th><th>Hits</th><th>BB</th>
            <th className="gameline-divider-right">K</th>
            <th>Whiffs</th><th>SwStr%</th><th>CSW%</th><th>Strike%</th><th>2Str%</th><th>PAR%</th><th>#</th><th>HR</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="card-pitcher-name" style={{ color: "#ffc277" }}>{nameWithOrg}</td>
            {(() => {
              const dec = result.decision || (projectedDecision ? projectedDecision : "ND");
              const isProjected = !result.decision && projectedDecision;
              const label = isProjected ? dec + "*" : dec;
              const color = dec === "W" ? "#6DE95D" : dec === "L" ? "#FF839B" : "#8a8eb0";
              return <td style={{ color, fontWeight: dec !== "ND" ? 700 : 500 }}>{label}</td>;
            })()}
            <td>{result.ip}</td>
            <td>{result.runs != null ? result.runs : "-"}</td>
            <td>{result.er}</td>
            <td>{result.hits}</td>
            <td>{result.bbs}</td>
            <td className="gameline-divider-right">{result.ks}</td>
            <td>{result.whiffs}</td>
            <td>{result.swstr_pct != null ? Math.round(result.swstr_pct) + "%" : "-"}</td>
            <td>{result.csw_pct != null ? Math.round(result.csw_pct) + "%" : "-"}</td>
            <td>{result.strike_pct != null ? Math.round(result.strike_pct) + "%" : "-"}</td>
            <td>{result.two_str_pct != null ? Math.round(result.two_str_pct) + "%" : "-"}</td>
            <td>{result.par_pct != null ? Math.round(result.par_pct) + "%" : "-"}</td>
            <td>{result.pitches}</td>
            <td>{result.hrs}</td>
          </tr>
          {(() => {
            const renderTotalsRow = (st, label, key) => {
              if (!st || !(st.games >= 1)) return null;
              const g = st.games;
              const gs = st.games_started || 0;
              const ipThirds = st.ip_thirds || 0;
              const totalIp = st.ip || `${Math.floor(ipThirds / 3)}.${ipThirds % 3}`;
              const ip = ipThirds / 3;
              const bf = st.batters_faced || 0;
              const wins = st.wins || 0;
              const losses = st.losses || 0;
              const era = ip > 0 ? ((st.er / ip) * 9).toFixed(2) : "-";
              const whip = ip > 0 ? ((st.hits + st.bbs) / ip).toFixed(2) : "-";
              const h9 = ip > 0 ? ((st.hits / ip) * 9).toFixed(1) : "-";
              const bbPct = bf > 0 ? (st.bbs / bf * 100).toFixed(1) + "%" : "-";
              const kPct = bf > 0 ? (st.ks / bf * 100).toFixed(1) + "%" : "-";
              const whfg = g > 0 ? (st.whiffs / g).toFixed(1) : "-";
              const ppg = g > 0 ? Math.round(st.pitches / g) : "-";
              const hr9 = ip > 0 ? ((st.hrs / ip) * 9).toFixed(2) : "-";
              const gamesLabel = gs > 0 && gs !== g ? `${g} Games (${gs} GS)` : `${g} Games`;
              return (
                <tr className="pp-total-row" key={key}>
                  <td className="card-pitcher-name pp-total-label"><span className="rate-label">{label}</span>{gamesLabel}</td>
                  <td><span className="rate-label">W-L</span>{wins}-{losses}</td>
                  <td><span className="rate-label">IP</span>{totalIp}</td>
                  <td><span className="rate-label">ERA</span>{era}</td>
                  <td><span className="rate-label">WHIP</span>{whip}</td>
                  <td><span className="rate-label">H/9</span>{h9}</td>
                  <td><span className="rate-label">BB%</span>{bbPct}</td>
                  <td className="gameline-divider-right"><span className="rate-label">K%</span>{kPct}</td>
                  <td><span className="rate-label">Whf/G</span>{whfg}</td>
                  <td><span className="rate-label">SwStr%</span>{st.swstr_pct != null ? Math.round(st.swstr_pct) + "%" : "-"}</td>
                  <td><span className="rate-label">CSW%</span>{st.csw_pct != null ? Math.round(st.csw_pct) + "%" : "-"}</td>
                  <td><span className="rate-label">Strike%</span>{st.strike_pct != null ? Math.round(st.strike_pct) + "%" : "-"}</td>
                  <td><span className="rate-label">2Str%</span>{st.two_str_pct != null ? Math.round(st.two_str_pct) + "%" : "-"}</td>
                  <td><span className="rate-label">PAR%</span>{st.par_pct != null ? Math.round(st.par_pct) + "%" : "-"}</td>
                  <td><span className="rate-label">PPG</span>{ppg}</td>
                  <td><span className="rate-label">HR/9</span>{hr9}</td>
                </tr>
              );
            };
            return renderTotalsRow(seasonTotals, "Season Total", "row-single");
          })()}
        </tbody>
      </table>
    </div>
  );
}
