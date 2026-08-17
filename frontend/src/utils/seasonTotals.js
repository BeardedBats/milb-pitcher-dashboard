function ipToThirds(ipVal) {
  const parts = String(ipVal || "0.0").split(".");
  const full = parseInt(parts[0], 10) || 0;
  const thirds = parseInt(parts[1], 10) || 0;
  return full * 3 + thirds;
}

function normalizeReplacementGame(game) {
  if (!game || game.game_pk == null) return null;
  return {
    ...game,
    game_pk: Number(game.game_pk),
  };
}

export function aggregateGameLogTotals(log, replacementGame = null) {
  if (!log || log.length === 0) return null;

  const replacement = normalizeReplacementGame(replacementGame);
  const normalizedLog = log.map((game) => {
    if (!replacement || Number(game.game_pk) !== replacement.game_pk) return game;
    return {
      ...game,
      ...replacement,
      date: game.date || replacement.date,
      team: game.team || replacement.team,
      opponent: game.opponent || replacement.opponent,
      home_team: game.home_team || replacement.home_team,
    };
  });

  const totalPitches = normalizedLog.reduce((sum, g) => sum + (g.pitches || 0), 0);
  const ipThirds = normalizedLog.reduce((sum, g) => sum + ipToThirds(g.ip), 0);
  // 2Str% is a PA rate, so the numerator and denominator must come from the
  // SAME games. Rows without a pa_count (the non-Statcast levels published
  // two_strike_pas alone before backend _METRICS_VERSION 6) sit out of the rate
  // entirely rather than adding a numerator with nothing to divide by — that
  // mismatch is what printed 115% on a AA-then-AAA season line.
  // PAR% still uses every row's two_strike_pas: its numerator (ks) comes off
  // the box score and is present on every row regardless of level.
  const ratedGames = normalizedLog.filter((g) => (g.pa_count || 0) > 0);
  const totalPa = ratedGames.reduce((sum, g) => sum + (g.pa_count || 0), 0);
  const ratedTwoStrikePas = ratedGames.reduce((sum, g) => sum + (g.two_strike_pas || 0), 0);
  const twoStrikePas = normalizedLog.reduce((sum, g) => sum + (g.two_strike_pas || 0), 0);
  const whiffs = normalizedLog.reduce((sum, g) => sum + (g.whiffs || 0), 0);
  const strikes = normalizedLog.reduce((sum, g) => sum + (g.strikes || 0), 0);
  const ks = normalizedLog.reduce((sum, g) => sum + (g.ks || 0), 0);

  return {
    games: normalizedLog.length,
    games_started: normalizedLog.reduce((sum, g) => sum + (g.games_started || 0), 0),
    ip: `${Math.floor(ipThirds / 3)}.${ipThirds % 3}`,
    ip_thirds: ipThirds,
    hits: normalizedLog.reduce((sum, g) => sum + (g.hits || 0), 0),
    bbs: normalizedLog.reduce((sum, g) => sum + (g.bbs || 0), 0),
    ks,
    hrs: normalizedLog.reduce((sum, g) => sum + (g.hrs || 0), 0),
    er: normalizedLog.reduce((sum, g) => sum + (g.er || 0), 0),
    runs: normalizedLog.reduce((sum, g) => sum + (g.runs || 0), 0),
    batters_faced: normalizedLog.reduce((sum, g) => sum + (g.batters_faced || 0), 0),
    whiffs,
    swstr_pct: totalPitches > 0 ? (whiffs / totalPitches) * 100 : 0,
    csw_pct: totalPitches > 0
      ? normalizedLog.reduce((sum, g) => sum + ((g.csw_pct || 0) * (g.pitches || 0)), 0) / totalPitches
      : 0,
    strike_pct: totalPitches > 0 ? (strikes / totalPitches) * 100 : 0,
    two_str_pct: totalPa > 0 ? (ratedTwoStrikePas / totalPa) * 100 : 0,
    par_pct: twoStrikePas > 0 ? (ks / twoStrikePas) * 100 : 0,
    pitches: totalPitches,
    pa_count: totalPa,
    two_strike_pas: twoStrikePas,
    wins: normalizedLog.filter(g => g.decision === "W").length,
    losses: normalizedLog.filter(g => g.decision === "L").length,
  };
}
