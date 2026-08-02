import React from "react";
import { displayTeamAbbrev } from "../constants";

// Player-info column of the pitcher card header: name (optionally a link to the
// player page) and the team/hand/opponent meta line (optionally a link to the
// game card). The weather line and next-starts strip were MLB-only features
// (stadium coords / a Google Sheet of MLB probables) and are gone in this build.
export default function PitcherHeader({
  nameWithOrg,
  playerHref,
  pitcherId,
  onPlayerClick,
  team,
  hand,
  dateDisplay,
  oppPrefix,
  opponent,
  cardHref,
  onGameClick,
}) {
  return (
    <div className="card-info">
      {onPlayerClick && pitcherId ? (
        <a className="card-name" href={playerHref} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); onPlayerClick(pitcherId, e); } }} style={{ cursor: "pointer", textDecoration: "none" }}>{nameWithOrg}</a>
      ) : (
        <div className="card-name">{nameWithOrg}</div>
      )}
      <div className="card-meta">
        {displayTeamAbbrev(team)} · {hand}HP ·{" "}
        {onGameClick ? (
          <a className="card-game-link" href={cardHref} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); onGameClick(e); } }} role="button" tabIndex={0}>
            {dateDisplay} {oppPrefix} {displayTeamAbbrev(opponent)}
          </a>
        ) : (
          <span>{dateDisplay} {oppPrefix} {displayTeamAbbrev(opponent)}</span>
        )}
      </div>
    </div>
  );
}
