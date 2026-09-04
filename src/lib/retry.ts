import { ZodError } from "zod";
import { LlmError, LlmStructuredOutputError } from "@/lib/llm";

/** Provider statuses worth one more attempt; the single owner of this policy. */
export const RETRYABLE_LLM_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Settings for one bounded, cancellable retry boundary. */
export interface RetryOperationOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal;
  shouldRetry: (caught: unknown) => boolean;
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
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
  });
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
      const exponential = options.initialDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * options.initialDelayMs);
      await delayWithSignal(
        Math.min(exponential + jitter, options.maxDelayMs),
        options.signal,
      );
    }
  }
}

/**
 * Classify failures from one structured LLM operation.
 * @param caught unknown provider, JSON, or schema failure
 * @returns true for temporary provider failures and repairable output errors
 */
export function isRetryableStructuredLlmError(caught: unknown): boolean {
  if (caught instanceof LlmError) {
    return RETRYABLE_LLM_STATUSES.has(caught.status);
  }
  return (
    caught instanceof TypeError ||
    caught instanceof SyntaxError ||
    caught instanceof ZodError ||
    caught instanceof LlmStructuredOutputError
  );
}

/** Standard two-attempt policy for non-streamed structured model calls. */
export const STRUCTURED_LLM_RETRY_OPTIONS = {
  maxAttempts: 2,
  initialDelayMs: 300,
  maxDelayMs: 1_000,
  shouldRetry: isRetryableStructuredLlmError,
} as const;
