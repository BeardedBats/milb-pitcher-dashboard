import {
  getHashParts,
  parseBaseballHash,
  buildCardHash,
  buildPlayerHash,
  buildTeamHash,
  isNewWindowClick,
  homePath,
  isRehabPath,
  REHAB_PATH,
} from "../navigation";

describe("hash builders", () => {
  test("buildCardHash / buildPlayerHash / buildTeamHash produce the documented routes", () => {
    expect(buildCardHash({ date: "2026-06-15", pitcherId: 600001, gamePk: 777001 }))
      .toBe("card/2026-06-15/600001/777001");
    expect(buildPlayerHash(669373)).toBe("player/669373");
    expect(buildTeamHash("NYY")).toBe("team/NYY");
  });
});

describe("parseBaseballHash", () => {
  test("round-trips a card route built by buildCardHash", () => {
    const hash = buildCardHash({ date: "2026-06-15", pitcherId: 600001, gamePk: 777001 });
    expect(parseBaseballHash("#" + hash)).toEqual({
      type: "card", date: "2026-06-15", pitcherId: 600001, gamePk: 777001,
    });
  });

  test("parses player and team routes", () => {
    expect(parseBaseballHash("#player/669373")).toEqual({ type: "player", pitcherId: 669373 });
    expect(parseBaseballHash("#team/NYY")).toEqual({ type: "team", team: "NYY" });
  });

  test("empty and malformed hashes resolve to home (no-op)", () => {
    expect(parseBaseballHash("")).toEqual({ type: "home" });
    expect(parseBaseballHash("#")).toEqual({ type: "home" });
    // missing gamePk → not a valid card route
    expect(parseBaseballHash("#card/2026-06-15/600001")).toEqual({ type: "home" });
  });

  test("getHashParts strips a leading # and splits on /", () => {
    expect(getHashParts("#card/2026-06-15/1/2")).toEqual(["card", "2026-06-15", "1", "2"]);
    expect(getHashParts("")).toEqual([]);
  });
});

describe("isNewWindowClick", () => {
  test("true for ctrl/meta/middle-click, false otherwise", () => {
    expect(isNewWindowClick({ ctrlKey: true })).toBe(true);
    expect(isNewWindowClick({ metaKey: true })).toBe(true);
    expect(isNewWindowClick({ button: 1 })).toBe(true);
    expect(isNewWindowClick({})).toBeFalsy();
    expect(isNewWindowClick(null)).toBeFalsy();
  });
});

describe("path routes", () => {
  const setPath = (pathname) => {
    delete window.location;
    window.location = { pathname, origin: "https://example.test" };
  };

  test("isRehabPath matches /rehab with or without a trailing slash", () => {
    setPath(REHAB_PATH);
    expect(isRehabPath()).toBe(true);
    setPath("/rehab/");
    expect(isRehabPath()).toBe(true);
    setPath("/");
    expect(isRehabPath()).toBe(false);
    setPath("/rehabilitation");
    expect(isRehabPath()).toBe(false);
  });

  test("homePath strips the rehab segment so hash links never inherit it", () => {
    setPath(REHAB_PATH);
    expect(homePath()).toBe("/");
    setPath("/rehab/");
    expect(homePath()).toBe("/");
    setPath("/");
    expect(homePath()).toBe("/");
  });
});
