import { beforeEach, describe, expect, it } from "vitest";
import { callerKey, consumeRequest, resetRateLimit } from "./rate-limit";

beforeEach(() => {
  resetRateLimit();
});

describe("callerKey", () => {
  it("uses the first forwarded address", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(callerKey(headers)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip when nothing was forwarded", () => {
    const headers = new Headers({ "x-real-ip": " 198.51.100.4 " });
    expect(callerKey(headers)).toBe("198.51.100.4");
  });

  it("prefers a forwarded address over x-real-ip", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.7",
      "x-real-ip": "198.51.100.4",
    });
    expect(callerKey(headers)).toBe("203.0.113.7");
  });

  it("skips an empty forwarded address rather than keying on it", () => {
    const headers = new Headers({
      "x-forwarded-for": "  ",
      "x-real-ip": "198.51.100.4",
    });
    expect(callerKey(headers)).toBe("198.51.100.4");
  });

  it("falls back to a shared local key when nothing is forwarded", () => {
    expect(callerKey(new Headers())).toBe("local");
  });
});

describe("consumeRequest", () => {
  it("allows a normal burst and then refuses further requests", () => {
    const allowed = Array.from(
      { length: 20 },
      () => consumeRequest("caller", 1_000).allowed,
    );
    expect(allowed.every(Boolean)).toBe(true);

    const refused = consumeRequest("caller", 1_000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts each caller separately", () => {
    for (let attempt = 0; attempt < 21; attempt++) {
      consumeRequest("noisy", 1_000);
    }
    expect(consumeRequest("quiet", 1_000).allowed).toBe(true);
  });

  it("starts a fresh window once the previous one expires", () => {
    for (let attempt = 0; attempt < 21; attempt++) {
      consumeRequest("caller", 1_000);
    }
    expect(consumeRequest("caller", 1_000).allowed).toBe(false);
    expect(consumeRequest("caller", 120_000).allowed).toBe(true);
  });
});
