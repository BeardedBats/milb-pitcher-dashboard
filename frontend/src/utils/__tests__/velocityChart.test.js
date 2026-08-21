import { resolveSingleGamePk, velocityChartMode, shortGameDate, axisTickStep } from "../velocityChart";

const LOG = [
  { game_pk: 801, date: "2026-08-02" },
  { game_pk: 802, date: "2026-08-08" },
  { game_pk: 803, date: "2026-08-14" },
];

describe("resolveSingleGamePk", () => {
  test("a dropdown pick is the game in view", () => {
    // The <select> hands back strings — the raw value rides through unchanged.
    expect(resolveSingleGamePk("802", LOG)).toBe("802");
  });

  test("All Games over a multi-game season resolves to nothing", () => {
    expect(resolveSingleGamePk("all", LOG)).toBeNull();
  });

  test("All Games over a one-start season is still one game", () => {
    expect(resolveSingleGamePk("all", [LOG[0]])).toBe(801);
  });

  test("an empty or missing log resolves to nothing", () => {
    expect(resolveSingleGamePk("all", [])).toBeNull();
    expect(resolveSingleGamePk("all", undefined)).toBeNull();
  });
});

describe("velocityChartMode", () => {
  test("one game in view gets the inning-aware game chart", () => {
    expect(velocityChartMode("802")).toBe("game");
    expect(velocityChartMode(801)).toBe("game");
  });

  test("a multi-game frame gets the season chart", () => {
    // at_bat_number restarts every game and innings repeat, so the game
    // chart's ordering and inning panels would both be nonsense here.
    expect(velocityChartMode(null)).toBe("season");
    expect(velocityChartMode(undefined)).toBe("season");
    expect(velocityChartMode("")).toBe("season");
  });
});

describe("shortGameDate", () => {
  test("renders an ISO game date as a compact panel label", () => {
    expect(shortGameDate("2026-08-14")).toBe("8/14");
    expect(shortGameDate("2026-03-25T00:00:00")).toBe("3/25");
  });

  test("passes anything unparseable through, and empties to empty", () => {
    expect(shortGameDate("")).toBe("");
    expect(shortGameDate(null)).toBe("");
    expect(shortGameDate("Opening Day")).toBe("Opening Day");
  });
});

describe("axisTickStep", () => {
  test("a single start keeps the game card's 15-pitch spacing", () => {
    // 15/30/45/60/75 is what the card has always drawn — the floor exists so
    // routing the season chart through the same code can't change it.
    expect(axisTickStep(82)).toBe(15);
    expect(axisTickStep(150)).toBe(15);
  });

  test("a season's pitch count spreads the ticks out", () => {
    // ~10 labels across the axis, whatever the frame size.
    expect(axisTickStep(1500)).toBe(150);
    expect(axisTickStep(2400)).toBe(250);
    for (const total of [82, 400, 1500, 2400, 6000]) {
      expect(total / axisTickStep(total)).toBeLessThanOrEqual(11);
    }
  });

  test("degenerate counts still give a usable step", () => {
    expect(axisTickStep(0)).toBe(15);
    expect(axisTickStep(undefined)).toBe(15);
  });
});
