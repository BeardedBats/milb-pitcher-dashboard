import { aggregateGameLogTotals } from "../seasonTotals";

// 2Str% is a plate-appearance rate. Its numerator (two_strike_pas) and its
// denominator (pa_count) reach the game log from two different producers —
// Savant for AAA/AFL, the play-by-play feed everywhere below — and while only
// one of them shipped a denominator, the Regular Season totals row divided a
// whole-season numerator by AAA-only plate appearances and printed 115%.

const game = (pk, extra = {}) => ({
  game_pk: pk, ip: "5.0", ks: 5, pitches: 80, ...extra,
});

describe("aggregateGameLogTotals — 2Str%", () => {
  it("pairs numerator and denominator per game", () => {
    const totals = aggregateGameLogTotals([
      game(1, { pa_count: 20, two_strike_pas: 10 }),
      game(2, { pa_count: 20, two_strike_pas: 14 }),
    ]);
    expect(totals.two_str_pct).toBeCloseTo(60);
    expect(totals.pa_count).toBe(40);
    expect(totals.two_strike_pas).toBe(24);
  });

  it("cannot exceed 100% when lower-level rows carry no pa_count", () => {
    const log = [];
    for (let i = 0; i < 10; i++) log.push(game(i, { pa_count: 20, two_strike_pas: 12 }));
    for (let i = 0; i < 9; i++) log.push(game(100 + i, { two_strike_pas: 10 }));
    const totals = aggregateGameLogTotals(log);
    expect(totals.two_str_pct).toBeCloseTo(60);   // 120 / 200
    expect(totals.two_str_pct).toBeLessThanOrEqual(100);
  });

  it("keeps PAR% on every game — its numerator exists at every level", () => {
    const totals = aggregateGameLogTotals([
      game(1, { ks: 6, pa_count: 20, two_strike_pas: 12 }),
      game(2, { ks: 6, two_strike_pas: 12 }),
    ]);
    expect(totals.ks).toBe(12);
    expect(totals.two_strike_pas).toBe(24);
    expect(totals.par_pct).toBeCloseTo(50);
  });

  it("reports 0 rather than NaN when no game has PA data", () => {
    const totals = aggregateGameLogTotals([game(1), game(2)]);
    expect(totals.two_str_pct).toBe(0);
    expect(totals.par_pct).toBe(0);
  });
});
