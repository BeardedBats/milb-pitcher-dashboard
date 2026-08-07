import {
  nextRetryDelay,
  parseRetryAfter,
  jitter,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_MAX_MS,
  DEFAULT_RETRY_BUDGET_MS,
  MAX_SERVER_RETRY_AFTER_MS,
} from "../pollBackoff";

describe("nextRetryDelay", () => {
  test("doubles from the base delay", () => {
    const seen = [1, 2, 3, 4, 5].map((n) => nextRetryDelay(n));
    expect(seen).toEqual([2000, 4000, 8000, 16000, 30000]);
  });

  test("never exceeds the ceiling, however many attempts", () => {
    for (const n of [5, 10, 50, 1000]) {
      expect(nextRetryDelay(n)).toBeLessThanOrEqual(DEFAULT_RETRY_MAX_MS);
    }
    expect(Number.isFinite(nextRetryDelay(1e6))).toBe(true);
  });

  test("honours custom base and ceiling", () => {
    expect(nextRetryDelay(1, { baseMs: 500, maxMs: 3000 })).toBe(500);
    expect(nextRetryDelay(3, { baseMs: 500, maxMs: 3000 })).toBe(2000);
    expect(nextRetryDelay(9, { baseMs: 500, maxMs: 3000 })).toBe(3000);
  });

  test("attempt is clamped to at least 1", () => {
    expect(nextRetryDelay(0)).toBe(DEFAULT_RETRY_BASE_MS);
    expect(nextRetryDelay(-4)).toBe(DEFAULT_RETRY_BASE_MS);
  });

  // The server hint must be a floor, never a throttle release: a buggy or
  // hostile retry_after of 0 must not turn the loop back into a hot poll.
  test("a server hint can only slow the client down", () => {
    expect(nextRetryDelay(1, { retryAfterMs: 15000 })).toBe(15000);
    expect(nextRetryDelay(1, { retryAfterMs: 0 })).toBe(2000);
    expect(nextRetryDelay(5, { retryAfterMs: 1000 })).toBe(30000);
  });

  test("a server hint may exceed the local ceiling but not the hard cap", () => {
    expect(nextRetryDelay(1, { retryAfterMs: 60000 })).toBe(60000);
    expect(nextRetryDelay(1, { retryAfterMs: 99 * 60 * 1000 }))
      .toBe(MAX_SERVER_RETRY_AFTER_MS);
  });
});

describe("parseRetryAfter", () => {
  test("reads seconds as milliseconds", () => {
    expect(parseRetryAfter(15)).toBe(15000);
    expect(parseRetryAfter("15")).toBe(15000);
    expect(parseRetryAfter(0)).toBe(0);
  });

  test("rejects absent, non-numeric and negative values", () => {
    for (const bad of [null, undefined, "", "soon", NaN, -5, {}]) {
      expect(parseRetryAfter(bad)).toBeNull();
    }
  });

  test("clamps an absurd hint to the hard cap", () => {
    expect(parseRetryAfter(86400)).toBe(MAX_SERVER_RETRY_AFTER_MS);
  });
});

describe("jitter", () => {
  test("stays within [delay * (1 - ratio), delay]", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const d = jitter(10000, 0.2, () => r);
      expect(d).toBeLessThanOrEqual(10000);
      expect(d).toBeGreaterThanOrEqual(8000);
    }
  });

  test("a zero ratio is a no-op", () => {
    expect(jitter(1234, 0, () => 1)).toBe(1234);
  });

  test("never goes negative even at a full-ratio worst case", () => {
    expect(jitter(1000, 1, () => 1)).toBe(0);
  });
});

// The whole point of the change: an endpoint stuck on 202 must produce a
// bounded, small number of requests instead of an unbounded stream. The old
// flat 2.5s loop measured 473 requests in 45 minutes.
describe("retry budget", () => {
  const attemptsWithinBudget = (opts = {}) => {
    let waited = 0;
    let attempts = 0;
    for (let n = 1; n < 10000; n += 1) {
      const delay = nextRetryDelay(n, opts);
      if (waited + delay > DEFAULT_RETRY_BUDGET_MS) break;
      waited += delay;
      attempts += 1;
    }
    return attempts;
  };

  test("bounded attempt count with no server hint", () => {
    const attempts = attemptsWithinBudget();
    expect(attempts).toBeGreaterThan(3);   // still responsive early on
    expect(attempts).toBeLessThan(20);     // and nothing like the old loop
  });

  test("the server hint reduces it further", () => {
    expect(attemptsWithinBudget({ retryAfterMs: 15000 }))
      .toBeLessThanOrEqual(attemptsWithinBudget());
  });
});
