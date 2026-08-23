import { describe, expect, it, vi } from "vitest";
import { LlmTimeoutError } from "@/lib/llm";
import {
  delayWithSignal,
  isRetryableStructuredLlmError,
  retryOperation,
} from "@/lib/retry";

describe("retryOperation", () => {
  it("classifies a provider timeout as retryable", () => {
    expect(isRetryableStructuredLlmError(new LlmTimeoutError())).toBe(true);
  });

  it("retries a classified temporary failure within the attempt budget", async () => {
    let attempts = 0;
    const result = await retryOperation(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("temporary");
        return "complete";
      },
      {
        maxAttempts: 2,
        initialDelayMs: 0,
        maxDelayMs: 0,
        shouldRetry: (caught) => caught instanceof TypeError,
      },
    );

    expect(result).toBe("complete");
    expect(attempts).toBe(2);
  });

  it("does not retry a permanent failure", async () => {
    const operation = vi.fn(async () => {
      throw new Error("permanent");
    });
    await expect(
      retryOperation(operation, {
        maxAttempts: 3,
        initialDelayMs: 0,
        maxDelayMs: 0,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow("permanent");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe("delayWithSignal", () => {
  it("rejects immediately when the caller cancels", async () => {
    const controller = new AbortController();
    const waiting = delayWithSignal(10_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});
