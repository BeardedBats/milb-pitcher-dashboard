import { fetchPitcherSeasonTotals, fetchOrgPage, fetchPlayerPageResource } from "../api";

// `res.ok` is TRUE for a 202, so a plain `if (!res.ok) throw` guard silently
// passes a "season cache is rebuilding" status body to the caller as if it were
// real data. Every season-materialized endpoint must go through the
// status-backed path instead, which reports the 202 rather than hiding it.
const mockResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const WARMUP_BODY = {
  status: "running",
  message: "Season cache is rebuilding",
  retry_after: 15,
};

describe("status-backed fetchers surface a 202 instead of returning it as data", () => {
  afterEach(() => { delete global.fetch; });

  const cases = [
    ["fetchPitcherSeasonTotals", () => fetchPitcherSeasonTotals(12345)],
    ["fetchOrgPage", () => fetchOrgPage("BOS")],
    ["fetchPlayerPageResource", () => fetchPlayerPageResource(12345)],
  ];

  test.each(cases)("%s reports 202 as a status, not a payload", async (_name, call) => {
    global.fetch = jest.fn(async () => mockResponse(202, WARMUP_BODY));

    const result = await call();

    expect(result.status).toBe(202);
    expect(result.body).toEqual(WARMUP_BODY);
    // The regression guard: the warmup body must never be handed back as the
    // resource itself.
    expect(result).not.toEqual(WARMUP_BODY);
  });

  test.each(cases)("%s returns the payload on 200", async (_name, call) => {
    const payload = { totals: { ip: 12.1, k: 18 } };
    global.fetch = jest.fn(async () => mockResponse(200, payload));

    const result = await call();

    expect(result.status).toBe(200);
    expect(result.body).toEqual(payload);
  });

  test.each(cases)("%s still throws on a genuine error status", async (_name, call) => {
    global.fetch = jest.fn(async () => mockResponse(500, { error: "boom" }));

    await expect(call()).rejects.toThrow(/500/);
  });
});

describe("fetchPitcherSeasonTotals request shape", () => {
  afterEach(() => { delete global.fetch; });

  test("sends pitcher_id, start_date and end_date", async () => {
    global.fetch = jest.fn(async () => mockResponse(200, {}));

    await fetchPitcherSeasonTotals(660271, "2026-03-25", "2026-08-06");

    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain("/api/pitcher-season-totals?");
    expect(url).toContain("pitcher_id=660271");
    expect(url).toContain("start_date=2026-03-25");
    expect(url).toContain("end_date=2026-08-06");
  });
});
