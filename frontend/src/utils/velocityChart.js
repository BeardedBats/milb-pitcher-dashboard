// Which velocity-trend chart the player page should render.
//
// The two charts are not interchangeable: the game chart (VelocityTrendV2)
// orders pitches by at_bat_number and slices the lane into inning panels with
// per-inning velo headers. Both of those only mean anything inside ONE game —
// at_bat_number restarts every game, and "3rd inning" names six different
// innings across a six-start season. So the game chart is used exactly when
// the pitches on screen come from a single game, and the season chart
// (VelocityTrend, one swim lane per pitch type) covers everything else.

/**
 * Resolve the one game the current view is showing, or null for a multi-game view.
 *
 * @param {string|number} gameFilter  the Game dropdown value ("all" or a game_pk)
 * @param {Array<{game_pk: string|number}>} gameLog  the pitcher's season game log
 * @returns {string|number|null} the game_pk, or null when more than one game is in view
 */
export function resolveSingleGamePk(gameFilter, gameLog) {
  if (gameFilter != null && gameFilter !== "all") return gameFilter;
  const log = gameLog || [];
  if (log.length === 1) return log[0].game_pk;
  return null;
}

/**
 * Chart mode for VelocityChart, given the resolved single game (or null).
 * @returns {"game"|"season"}
 */
export function velocityChartMode(singleGamePk) {
  return singleGamePk ? "game" : "season";
}

/**
 * "2026-08-14" → "8/14". Panel header label for a game-sliced chart.
 */
export function shortGameDate(d) {
  if (!d) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  return m ? `${Number(m[2])}/${Number(m[3])}` : String(d);
}

/**
 * X-axis tick spacing for the velocity chart, scaled to the size of the frame.
 * One start prints 15/30/45…; a season's 1,500 pitches would otherwise print a
 * hundred labels on top of each other. 15 is the floor, so a single game keeps
 * the spacing the game card has always had.
 */
export function axisTickStep(totalPitches) {
  const raw = (totalPitches || 0) / 10; // aim for ~10 labels across the axis
  for (const step of [15, 25, 50, 100, 150, 200, 250, 500, 1000]) {
    if (step >= raw) return step;
  }
  return Math.ceil(raw / 1000) * 1000;
}
