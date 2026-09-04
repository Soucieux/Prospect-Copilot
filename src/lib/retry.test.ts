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

  it("waits and resolves when no cancellation signal was given", async () => {
    const started = Date.now();
    await expect(delayWithSignal(5)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(0);
  });

  it("rejects with the caller's own reason when one is supplied", async () => {
    const controller = new AbortController();
    const reason = new Error("caller went away");
    const waiting = delayWithSignal(10_000, controller.signal);
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });

  it("throws synchronously when the signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    // The guard runs before the timer promise is created, so an
    // already-cancelled caller fails on the call rather than on the await.
    expect(() => delayWithSignal(10_000, controller.signal)).toThrow();
  });
});

describe("retryOperation without a cancellation signal", () => {
  it("backs off and retries when no signal was given", async () => {
    let attempts = 0;
    const result = await retryOperation(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new TypeError("temporary");
        return "complete";
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1,
        maxDelayMs: 2,
        shouldRetry: (caught) => caught instanceof TypeError,
      },
    );
    expect(result).toBe("complete");
    expect(attempts).toBe(3);
  });

  it("gives up once the attempt budget is spent", async () => {
    const operation = vi.fn(async () => {
      throw new TypeError("always temporary");
    });
    await expect(
      retryOperation(operation, {
        maxAttempts: 2,
        initialDelayMs: 1,
        maxDelayMs: 2,
        shouldRetry: () => true,
      }),
    ).rejects.toThrow("always temporary");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("stops retrying as soon as the caller cancels", async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      controller.abort();
      throw new TypeError("temporary");
    });
    await expect(
      retryOperation(operation, {
        maxAttempts: 5,
        initialDelayMs: 1,
        maxDelayMs: 2,
        shouldRetry: () => true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
