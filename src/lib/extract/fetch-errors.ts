/** Stable categories for failures produced by the secure page fetcher. */
export type FetchFailureCode =
  | "invalid_url"
  | "blocked_host"
  | "temporary_dns"
  | "permanent_dns"
  | "timeout"
  | "connection_reset"
  | "http_status"
  | "unsupported_content_type"
  | "response_too_large"
  | "redirect_limit"
  | "certificate"
  | "unavailable";

/** Metadata carried by a classified page-fetch failure. */
export interface FetchPageErrorOptions {
  cause?: unknown;
  retryable?: boolean;
  status?: number;
  retryAfterMs?: number | null;
}

/** A fetch failure whose retry behavior can be decided without parsing text. */
export class FetchPageError extends Error {
  public readonly code: FetchFailureCode;
  public readonly retryable: boolean;
  public readonly status: number | null;
  public readonly retryAfterMs: number | null;

  /**
   * Create a classified fetch failure.
   * @param code stable failure category
   * @param message diagnostic message that must not be shown directly to users
   * @param options optional cause, retry decision, status, and retry delay
   */
  public constructor(
    code: FetchFailureCode,
    message: string,
    options: FetchPageErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "FetchPageError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/**
 * Determine whether an unknown failure is safe to retry.
 * @param caught unknown thrown value
 * @returns true only for an explicitly classified temporary failure
 */
export function isRetryableFetchError(caught: unknown): boolean {
  return caught instanceof FetchPageError && caught.retryable;
}
