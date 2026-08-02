import { useEffect, useRef, useState } from "react";
import { fetchGameLinescore } from "../utils/api";

const POLL_MS = 60000;

function hasLinescoreInnings(ls) {
  return !!(ls && Array.isArray(ls.innings) && ls.innings.length > 0);
}

export function projectLatestGameDecision(sortedLog, linescore) {
  if (!sortedLog || sortedLog.length === 0 || !linescore || linescore.is_final !== false || !linescore.totals) {
    return null;
  }
  const last = sortedLog[sortedLog.length - 1];
  if (!last?.game_pk) return null;

  const homeRuns = linescore.totals.home?.runs || 0;
  const awayRuns = linescore.totals.away?.runs || 0;
  const isHome = last.home_team && last.team === last.home_team;
  const teamRuns = isHome ? homeRuns : awayRuns;
  const oppRuns = isHome ? awayRuns : homeRuns;
  let projectedDecision = "ND";
  if (teamRuns > oppRuns) projectedDecision = "W";
  else if (teamRuns < oppRuns) projectedDecision = "L";
  return { game_pk: last.game_pk, projectedDecision };
}

export function usePolledLinescore(gamePk, initialData = null) {
  const seedHasInnings = hasLinescoreInnings(initialData);
  const [linescoreData, setLinescoreData] = useState(seedHasInnings ? initialData : null);

  // Track initialData and current linescore via refs so changes to either
  // don't trigger effect re-runs. The hook re-fires ONLY when gamePk changes.
  // Without this, parent passing cardData.linescore (which the backend sets to
  // an empty {} placeholder) would overwrite a just-fetched linescore and
  // blank out the scoreboard / PBP / velocity-trend sections of the card.
  const initialDataRef = useRef(initialData);
  initialDataRef.current = initialData;
  const linescoreRef = useRef(linescoreData);
  linescoreRef.current = linescoreData;

  useEffect(() => {
    if (!gamePk) {
      setLinescoreData(null);
      return undefined;
    }

    let cancelled = false;
    const doFetch = () => {
      fetchGameLinescore(gamePk)
        .then(ls => { if (!cancelled) setLinescoreData(ls); })
        .catch(() => { if (!cancelled) setLinescoreData(null); });
    };

    // If we already have real innings data (parent just set it, or it was
    // seeded from initialData), trust it — don't wipe and re-fetch.
    if (hasLinescoreInnings(linescoreRef.current)) {
      // nothing to do; polling will keep live games fresh
    } else if (hasLinescoreInnings(initialDataRef.current)) {
      setLinescoreData(initialDataRef.current);
    } else {
      setLinescoreData(null);
      doFetch();
    }

    const interval = setInterval(() => {
      if (linescoreRef.current && linescoreRef.current.is_final === false) doFetch();
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gamePk]);

  return { linescoreData, setLinescoreData };
}

export function useProjectedLatestGame(sortedLog) {
  const lastGamePk = sortedLog && sortedLog.length > 0
    ? sortedLog[sortedLog.length - 1]?.game_pk
    : null;
  const { linescoreData } = usePolledLinescore(lastGamePk);
  return projectLatestGameDecision(sortedLog, linescoreData);
}
