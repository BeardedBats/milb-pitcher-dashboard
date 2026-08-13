import { csvEscape, rowsToCsv, csvSlug } from "../csv";

describe("csvEscape", () => {
  test("passes plain values through", () => {
    expect(csvEscape("AAA")).toBe("AAA");
    expect(csvEscape(26.3)).toBe("26.3");
    expect(csvEscape(0)).toBe("0");
  });
  test("null/undefined become empty cells", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });
  test("quotes delimiters and doubles embedded quotes", () => {
    expect(csvEscape("Guerrero, Vlad")).toBe('"Guerrero, Vlad"');
    expect(csvEscape('the "Kid"')).toBe('"the ""Kid"""');
    expect(csvEscape("a\nb")).toBe('"a\nb"');
  });
});

describe("rowsToCsv", () => {
  const cols = [
    { key: "pitcher", label: "Pitcher" },
    { key: "ip", label: "IP" },
    { key: "opp", label: "Opp", value: r => (r.home ? "" : "@ ") + r.opp },
  ];
  test("header from labels, cells raw, value() override honored", () => {
    const csv = rowsToCsv(cols, [
      { pitcher: "Jackson Kent", ip: "6.1", opp: "SWB", home: false },
      { pitcher: "Bradley Hanner", ip: null, opp: "BUF", home: true },
    ]);
    expect(csv).toBe(
      "Pitcher,IP,Opp\r\n" +
      "Jackson Kent,6.1,@ SWB\r\n" +
      "Bradley Hanner,,BUF\r\n"
    );
  });
});

describe("csvSlug", () => {
  test("lowercases, strips accents and punctuation", () => {
    expect(csvSlug("Jesús Luzardo")).toBe("jesus-luzardo");
    expect(csvSlug("O'Neill, Tyler Jr.")).toBe("o-neill-tyler-jr");
  });
});
