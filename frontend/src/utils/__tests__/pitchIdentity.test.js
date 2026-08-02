import { samePitchIdentity } from "../pitchIdentity";

describe("samePitchIdentity", () => {
  const base = { at_bat_number: 5, pitch_number: 3, game_pk: 777001 };

  test("same game/at-bat/pitch → identical", () => {
    expect(samePitchIdentity(base, { ...base })).toBe(true);
  });

  test("any differing key → not identical", () => {
    expect(samePitchIdentity(base, { ...base, pitch_number: 4 })).toBe(false);
    expect(samePitchIdentity(base, { ...base, at_bat_number: 6 })).toBe(false);
    expect(samePitchIdentity(base, { ...base, game_pk: 777002 })).toBe(false);
  });

  test("null inputs → false", () => {
    expect(samePitchIdentity(null, base)).toBe(false);
    expect(samePitchIdentity(base, null)).toBe(false);
  });
});
