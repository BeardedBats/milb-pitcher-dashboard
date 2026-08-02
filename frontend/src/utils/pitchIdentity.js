// Pitch identity comparison — pure helper shared by the strike-zone and
// movement plots for "is this the same physical pitch?" (cross-plot hover
// highlighting). A pitch is uniquely identified by its game, at-bat, and
// pitch number. No React imports.
export function samePitchIdentity(a, b) {
  if (!a || !b) return false;
  return a.at_bat_number === b.at_bat_number
    && a.pitch_number === b.pitch_number
    && a.game_pk === b.game_pk;
}
