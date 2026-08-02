import { ordinalInning, formatBaseState } from "../gamePresentation";

describe("ordinalInning", () => {
  test("common ordinals", () => {
    expect(ordinalInning(1)).toBe("1st");
    expect(ordinalInning(2)).toBe("2nd");
    expect(ordinalInning(3)).toBe("3rd");
    expect(ordinalInning(4)).toBe("4th");
    expect(ordinalInning(9)).toBe("9th");
    expect(ordinalInning(21)).toBe("21st");
  });

  test("teens are always -th", () => {
    expect(ordinalInning(11)).toBe("11th");
    expect(ordinalInning(12)).toBe("12th");
    expect(ordinalInning(13)).toBe("13th");
  });
});

describe("formatBaseState", () => {
  test("empty / single / multiple", () => {
    expect(formatBaseState({})).toBe("Bases Empty");
    expect(formatBaseState({ on_1b: 1 })).toBe("Man on 1st");
    expect(formatBaseState({ on_2b: 1 })).toBe("Man on 2nd");
    expect(formatBaseState({ on_2b: 1, on_3b: 1 })).toBe("2nd & 3rd");
    expect(formatBaseState({ on_1b: 1, on_2b: 1, on_3b: 1 })).toBe("1st & 2nd & 3rd");
  });

  test("accepts a raw pitch object", () => {
    expect(formatBaseState({ on_1b: 12345, on_2b: null, on_3b: null })).toBe("Man on 1st");
  });
});
