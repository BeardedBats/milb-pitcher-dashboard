import { formatPaResult, isStrikeoutResult } from "../pbpPresentation";

describe("formatPaResult", () => {
  test("out types with trajectory", () => {
    expect(formatPaResult("field_out", "ground_ball")).toBe("Groundout");
    expect(formatPaResult("field_out", "fly_ball")).toBe("Flyout");
    expect(formatPaResult("field_out", "line_drive")).toBe("Lineout");
    expect(formatPaResult("field_out", "popup")).toBe("Pop Out");
  });

  test("force out gets the (FC) suffix; fielder's choice is named", () => {
    expect(formatPaResult("force_out", "ground_ball")).toBe("Groundout (FC)");
    expect(formatPaResult("fielders_choice", "ground_ball")).toBe("Fielder's Choice");
    expect(formatPaResult("fielders_choice_out", "ground_ball")).toBe("Fielder's Choice");
  });

  test("special-cased and title-cased fallbacks", () => {
    expect(formatPaResult("catcher_interf")).toBe("Catcher Interference");
    expect(formatPaResult("strikeout")).toBe("Strikeout");
    expect(formatPaResult("grounded_into_double_play")).toBe("Grounded Into Double Play");
    expect(formatPaResult("")).toBe("");
  });
});

describe("isStrikeoutResult", () => {
  test("strikeout variants are true", () => {
    expect(isStrikeoutResult("strikeout")).toBe(true);
    expect(isStrikeoutResult("strikeout_double_play")).toBe(true);
  });

  test("non-strikeouts are false", () => {
    expect(isStrikeoutResult("walk")).toBe(false);
    expect(isStrikeoutResult(null)).toBe(false);
    expect(isStrikeoutResult("")).toBe(false);
  });
});
