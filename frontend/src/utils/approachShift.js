// Approach-shift detector — the gated single-changepoint analysis behind the
// Regular Season pitch-mix table's "Approach shift" divider.
//
// It finds the one split that best separates two usage phases on a handedness
// split, and — unlike a naive detector that always draws a line — only reports
// it when the split clears a significance floor. A flat-usage pitcher yields
// no divider.
//
// Gating is the caller's job for the parts that need table context (handedness
// split + per-game pitch-to-side counts); this module owns the phase-length
// gate, the magnitude metric (total-variation distance), and the significance
// test. See RegularSeasonTable for how qualifying games are assembled.

// ----- config constants (documented in CLAUDE.md) -----
export const MIN_SIDE_PITCHES = 15; // a game qualifies only if pitchesToSide >= this
export const MIN_PHASE_GAMES = 3;   // each side of a candidate split needs >= this many qualifying games
export const MIN_TVD = 8;           // magnitude floor (points of total-variation distance)
const SIG_P = 0.05;                 // permutation-test p-value ceiling
const N_PERM = 1000;                // permutation iterations

// Average mix vector across a set of aligned, normalized game vectors.
function avgVec(rows) {
  const len = rows[0].length;
  const out = new Array(len).fill(0);
  for (const v of rows) for (let i = 0; i < len; i++) out[i] += v[i];
  for (let i = 0; i < len; i++) out[i] /= rows.length;
  return out;
}

// Total-variation distance between two mix vectors (each summing to ~100).
// 0.5 * Σ|after − before|, so it reads as "points of mix that moved".
function tvd(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(b[i] - a[i]);
  return 0.5 * s;
}

// Best split (max TVD) over the valid candidate boundaries. Returns the
// boundary index k (phases are [0,k) and [k,n)) and its TVD, or null.
function bestSplit(vecs) {
  const n = vecs.length;
  let best = null;
  for (let k = MIN_PHASE_GAMES; k <= n - MIN_PHASE_GAMES; k++) {
    const before = avgVec(vecs.slice(0, k));
    const after = avgVec(vecs.slice(k));
    const mag = tvd(before, after);
    if (!best || mag > best.mag) best = { k, mag, before, after };
  }
  return best;
}

// Deterministic PRNG (mulberry32) seeded from the data, so the permutation
// test gives the same verdict every recompute — no on/off flicker at the
// boundary across re-renders.
function makeRng(vecs) {
  let h = 2166136261 >>> 0;
  for (const v of vecs) for (const x of v) {
    h ^= Math.round(x * 1000);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let a = h || 1;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Detect the approach shift among already-qualifying games.
//   games   — chronological qualifying games: { rowIndex, date, vec, side }
//             where vec is the game's tracked mix normalized to sum 100,
//             aligned to `pitchKeys`.
//   pitchKeys — pitch display names aligned to each vec's indices.
// Returns null (no significant shift) or:
//   { rowIndex, date, tvd, before, after, nBefore, nAfter, movers, pValue, qualified }
export function detectApproachShift(games, pitchKeys) {
  const n = games.length;
  if (n < MIN_PHASE_GAMES * 2) return null; // not enough qualifying games for two phases

  const vecs = games.map(g => g.vec);
  const observed = bestSplit(vecs);
  if (!observed) return null;

  // Significance: how often does a random reordering of the same games yield a
  // best-split TVD at least as large? p < SIG_P AND the move clears MIN_TVD.
  const rng = makeRng(vecs);
  let ge = 0;
  for (let i = 0; i < N_PERM; i++) {
    const b = bestSplit(shuffled(vecs, rng));
    if (b && b.mag >= observed.mag) ge++;
  }
  const pValue = (ge + 1) / (N_PERM + 1);
  if (pValue >= SIG_P || observed.mag < MIN_TVD) return null;

  const movers = pitchKeys
    .map((key, i) => ({ key, from: observed.before[i], to: observed.after[i], delta: observed.after[i] - observed.before[i] }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const afterGame = games[observed.k];
  return {
    rowIndex: afterGame.rowIndex, // table index of the first "after"-phase game
    date: afterGame.date,
    tvd: observed.mag,
    before: observed.before,
    after: observed.after,
    nBefore: observed.k,
    nAfter: n - observed.k,
    movers,
    pValue,
    qualified: n,
  };
}
