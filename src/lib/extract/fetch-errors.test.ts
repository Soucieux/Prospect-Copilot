import { describe, expect, it } from "vitest";
import { FetchPageError, isRetryableFetchError } from "@/lib/extract/fetch-errors";

describe("FetchPageError", () => {
  it("defaults to a non-retryable failure with no status", () => {
    const error = new FetchPageError("blocked_host", "Blocked");
    expect(error.retryable).toBe(false);
    expect(error.status).toBeNull();
    expect(error.retryAfterMs).toBeNull();
    expect(error.name).toBe("FetchPageError");
  });

  it("carries the retry metadata it was given", () => {
    const error = new FetchPageError("http_status", "HTTP 429", {
      retryable: true,
      status: 429,
      retryAfterMs: 1_500,
    });
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(1_500);
  });
});

describe("isRetryableFetchError", () => {
  it("retries only an explicitly classified temporary failure", () => {
    expect(
      isRetryableFetchError(
        new FetchPageError("temporary_dns", "dns", { retryable: true }),
      ),
    ).toBe(true);
    expect(
      isRetryableFetchError(new FetchPageError("blocked_host", "blocked")),
    ).toBe(false);
  });

  it("does not retry an unclassified failure", () => {
    expect(isRetryableFetchError(new Error("boom"))).toBe(false);
    expect(isRetryableFetchError(null)).toBe(false);
  });
});
