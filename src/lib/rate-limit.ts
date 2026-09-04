/**
 * Fixed-window request limiting for the chat endpoint.
 *
 * The endpoint is unauthenticated and performs outbound page fetches from the
 * server's own address, so without a limit one caller can use it to amplify
 * traffic at third-party sites regardless of whose model key pays for the run.
 * State is per-process and in-memory, which suits the stateless single-server
 * deployment this project documents; a multi-instance deployment needs a
 * shared store instead.
 *
 * The caller is identified from `x-forwarded-for`, which the client controls
 * unless a proxy overwrites it. Behind such a proxy the limit is per client
 * address; exposed directly, a caller can vary the header to get a fresh
 * window, so the limit bounds accidental floods rather than a determined
 * attacker. Raising that bar needs an authenticated identity, not a better
 * header.
 */

/** Length of one counting window. */
const WINDOW_MS = 60_000;

/** Requests one caller may start within a window. */
const MAX_REQUESTS_PER_WINDOW = 20;

/**
 * Most callers tracked at once. The map is itself memory a caller can grow by
 * varying its address, so it is bounded as well as pruned.
 */
const MAX_TRACKED_CALLERS = 10_000;

/** Caller key used when no forwarded address is present, as in local use. */
const LOCAL_CALLER = "local";

const callerWindows = new Map<string, { count: number; resetAt: number }>();

/**
 * Identify the caller by its first forwarded address.
 * @param headers the incoming request headers
 * @returns the caller key, or a shared local key when none is forwarded
 */
export function callerKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || LOCAL_CALLER;
}

/**
 * Drop windows that have already expired, and clear the map entirely if it is
 * still oversized afterwards so tracking cannot grow without bound.
 * @param now current epoch milliseconds
 */
function pruneExpired(now: number): void {
  for (const [key, tracked] of callerWindows) {
    if (tracked.resetAt <= now) callerWindows.delete(key);
  }
  if (callerWindows.size > MAX_TRACKED_CALLERS) callerWindows.clear();
}

/**
 * Count one request against its caller's window.
 * @param key caller key from `callerKey`
 * @param now current epoch milliseconds, injectable for deterministic tests
 * @returns whether the request is allowed, and when the window resets
 */
export function consumeRequest(
  key: string,
  now: number = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  pruneExpired(now);
  const tracked = callerWindows.get(key);
  if (tracked === undefined || tracked.resetAt <= now) {
    callerWindows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  tracked.count += 1;
  return {
    allowed: tracked.count <= MAX_REQUESTS_PER_WINDOW,
    retryAfterSeconds: Math.ceil((tracked.resetAt - now) / 1_000),
  };
}

/** Discard all tracked windows. Exists so tests start from a known state. */
export function resetRateLimit(): void {
  callerWindows.clear();
}
