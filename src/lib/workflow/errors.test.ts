import { describe, expect, it } from "vitest";
import { RouterOutputError } from "@/lib/agent/router";
import { LlmError } from "@/lib/llm";
import { isRetryableRouterError } from "@/lib/workflow/errors";

describe("isRetryableRouterError", () => {
  it("retries invalid structured router output", () => {
    expect(isRetryableRouterError(new RouterOutputError())).toBe(true);
  });

  it("retries temporary provider statuses only", () => {
    expect(isRetryableRouterError(new LlmError("busy", 503))).toBe(true);
    expect(isRetryableRouterError(new LlmError("rate limited", 429))).toBe(true);
    expect(isRetryableRouterError(new LlmError("bad key", 401))).toBe(false);
    expect(isRetryableRouterError(new LlmError("bad request", 400))).toBe(false);
  });

  it("retries the bare TypeError Node reports for a transport failure", () => {
    expect(isRetryableRouterError(new TypeError("fetch failed"))).toBe(true);
  });

  it("does not retry an unclassified failure", () => {
    expect(isRetryableRouterError(new Error("unknown"))).toBe(false);
    expect(isRetryableRouterError("not an error")).toBe(false);
  });
});
