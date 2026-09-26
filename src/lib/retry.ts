/**
 * Cancellable waiting and bounded retry, with no knowledge of what is being
 * retried. The page fetcher and the model adapter both build on this module,
 * so it must not import either of them; each owns its own retry policy.
 */

/** Settings for one bounded, cancellable retry boundary. */
export interface RetryOperationOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal;
  shouldRetry: (caught: unknown) => boolean;
}

/** A timeout merged with caller cancellation for one operation. */
export interface AbortContext {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

/**
 * Wait for a delay while still reacting immediately to cancellation.
 * @param delayMs delay in milliseconds
 * @param signal optional cancellation signal
 * @returns a promise resolved after the delay
 */
export function delayWithSignal(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    /** Cancel the pending delay and reject with the abort reason. */
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Compute bounded exponential backoff with small jitter.
 * @param attempt one-based failed attempt number
 * @param initialDelayMs delay before the first retry, also the jitter range
 * @param maxDelayMs ceiling for the computed delay
 * @returns delay in milliseconds
 */
export function backoffDelayMs(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
): number {
  const exponential = initialDelayMs * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * initialDelayMs);
  return Math.min(exponential + jitter, maxDelayMs);
}

/**
 * Combine an operation timeout with caller cancellation.
 * @param timeoutMs how long the operation may run before it is aborted
 * @param signal optional caller cancellation signal
 * @returns the merged signal, a timeout probe, and a listener cleanup
 */
export function createAbortContext(
  timeoutMs: number,
  signal?: AbortSignal,
): AbortContext {
  const controller = new AbortController();
  let hasTimedOut = false;
  const timer = setTimeout(() => {
    hasTimedOut = true;
    controller.abort(new DOMException("Operation timed out", "TimeoutError"));
  }, timeoutMs);
  /** Forward the caller's abort into the combined signal. */
  const abortFromCaller = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => hasTimedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

/**
 * Execute an operation with one explicit retry owner and bounded backoff.
 * @param operation operation to execute
 * @param options retry budget, classifier, and cancellation signal
 * @returns the first successful result
 */
export async function retryOperation<Result>(
  operation: () => Promise<Result>,
  options: RetryOperationOptions,
): Promise<Result> {
  let attempt = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    attempt += 1;
    try {
      return await operation();
    } catch (caught) {
      options.signal?.throwIfAborted();
      if (attempt >= options.maxAttempts || !options.shouldRetry(caught)) {
        throw caught;
      }
      await delayWithSignal(
        backoffDelayMs(attempt, options.initialDelayMs, options.maxDelayMs),
        options.signal,
      );
    }
  }
}
