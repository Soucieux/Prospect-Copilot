import { describe, expect, it, vi } from "vitest";
import {
  backoffDelayMs,
  createAbortContext,
  delayWithSignal,
  retryOperation,
} from "@/lib/retry";

describe("backoffDelayMs", () => {
  it("doubles the delay per failed attempt and never exceeds the ceiling", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(backoffDelayMs(1, 300, 10_000)).toBe(300);
    expect(backoffDelayMs(2, 300, 10_000)).toBe(600);
    expect(backoffDelayMs(3, 300, 10_000)).toBe(1_200);
    expect(backoffDelayMs(10, 300, 1_000)).toBe(1_000);
    vi.restoreAllMocks();
  });

  it("adds jitter below the initial delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    expect(backoffDelayMs(1, 300, 10_000)).toBe(599);
    vi.restoreAllMocks();
  });
});

describe("createAbortContext", () => {
  it("aborts with a timeout once the deadline passes", async () => {
    const abort = createAbortContext(1);
    expect(abort.timedOut()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(abort.timedOut()).toBe(true);
    expect(abort.signal.aborted).toBe(true);
    expect(abort.signal.reason).toMatchObject({ name: "TimeoutError" });
    abort.cleanup();
  });

  it("forwards the caller's own cancellation without marking a timeout", () => {
    const controller = new AbortController();
    const reason = new Error("caller went away");
    const abort = createAbortContext(10_000, controller.signal);
    controller.abort(reason);
    expect(abort.signal.aborted).toBe(true);
    expect(abort.signal.reason).toBe(reason);
    expect(abort.timedOut()).toBe(false);
    abort.cleanup();
  });

  it("starts aborted when the caller had already cancelled", () => {
    const controller = new AbortController();
    controller.abort();
    const abort = createAbortContext(10_000, controller.signal);
    expect(abort.signal.aborted).toBe(true);
    abort.cleanup();
  });

  it("stops the deadline once cleaned up", async () => {
    const abort = createAbortContext(1);
    abort.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(abort.timedOut()).toBe(false);
    expect(abort.signal.aborted).toBe(false);
  });
});

describe("retryOperation", () => {
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
