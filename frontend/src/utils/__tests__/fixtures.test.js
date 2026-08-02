// Lightweight, fixture-driven checks over the domain utilities. These exercise
// the shared filter/aggregation logic against representative backend-shaped
// payloads (snake_case rows) without rendering React.
import pitches from "../../__fixtures__/pitches.json";
import pitchDataRows from "../../__fixtures__/pitchDataRows.json";
import pitcherResultRows from "../../__fixtures__/pitcherResultRows.json";
import teamPitchers from "../../__fixtures__/teamPitchers.json";
import gameLinescore from "../../__fixtures__/gameLinescore.json";
import playerPage from "../../__fixtures__/playerPage.json";
import pitcherCard from "../../__fixtures__/pitcherCard.json";

import { classifyPitchResult, matchesResultFilter } from "../pitchFilters";
import { aggregateGameLogTotals } from "../seasonTotals";

describe("fixtures expose the expected backend-shaped fields", () => {
  test("pitch data rows and result rows carry snake_case metric fields", () => {
    expect(pitchDataRows[0]).toHaveProperty("pitch_name");
    expect(pitchDataRows[0]).toHaveProperty("csw_pct");
    expect(pitcherResultRows[0]).toHaveProperty("pitcher_id");
    expect(teamPitchers[0]).toHaveProperty("pitcher_id");
  });

  test("linescore / card / player-page fixtures have their core shape", () => {
    expect(gameLinescore.innings.length).toBeGreaterThan(0);
    expect(gameLinescore).toHaveProperty("totals.home.runs");
    expect(pitcherCard.result).toHaveProperty("game_pk");
    expect(Array.isArray(playerPage.game_log)).toBe(true);
  });
});

describe("classifyPitchResult over the pitches fixture", () => {
  test("each pitch classifies into its expected category", () => {
    const cats = pitches.map(classifyPitchResult);
    expect(cats).toEqual([
      "Whiff",        // swinging_strike
      "Called Strike",// called_strike
      "HR",           // hit_into_play + home_run
      "Ball",         // ball
      "Foul",         // foul
      "Out",          // hit_into_play + field_out
    ]);
  });
});

describe("matchesResultFilter", () => {
  test("a whiff matches a Whiff-only filter but not a Ball-only filter", () => {
    const whiff = pitches[0];
    expect(matchesResultFilter(whiff, new Set(["Whiff"]))).toBe(true);
    expect(matchesResultFilter(whiff, new Set(["Ball"]))).toBe(false);
  });

  test("the Run(s) overlay matches a run-scoring pitch regardless of its base category", () => {
    const homer = pitches[2]; // runs_scored: 1
    expect(matchesResultFilter(homer, new Set(["Run(s)"]))).toBe(true);
  });
});

describe("aggregateGameLogTotals over the player-page game log", () => {
  test("sums games and counting stats", () => {
    const totals = aggregateGameLogTotals(playerPage.game_log);
    expect(totals.games).toBe(playerPage.game_log.length);
    const ksSum = playerPage.game_log.reduce((s, g) => s + (g.ks || 0), 0);
    expect(totals.ks).toBe(ksSum);
    expect(totals.wins).toBe(1);
    expect(totals.losses).toBe(1);
  });

  test("returns null for an empty log", () => {
    expect(aggregateGameLogTotals([])).toBeNull();
  });
});
