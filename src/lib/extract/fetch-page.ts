/**
 * Server-side page fetching with a basic SSRF guard.
 * Only public http(s) origins are allowed; private IP ranges are blocked.
 *
 * Fetches go through node:http/https instead of the global fetch so that
 * every hop - including redirect targets - connects to the exact IP this
 * module already validated. That closes two gaps a plain
 * `fetch(url, { redirect: "follow" })` has: (1) fetch's automatic redirect
 * following never re-checks the redirect target, so a fetched page could
 * redirect to a loopback/link-local address; (2) validating a hostname and
 * then letting fetch resolve it again independently leaves a DNS-rebinding
 * window between the check and the connection.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import * as ipaddr from "ipaddr.js";
import {
  FetchPageError,
  isRetryableFetchError,
} from "@/lib/extract/fetch-errors";
import { delayWithSignal } from "@/lib/retry";

export interface FetchedPage {
  url: string;
  status: number;
  html: string;
  /** Bounded server-requested delay used internally by variant retry. */
  retryAfterMs?: number | null;
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;
const MAX_NETWORK_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 300;
const MAX_RETRY_DELAY_MS = 2_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Deliberately separate from the LLM retry policy in retry.ts: page fetching
// and provider calls are independent decisions that happen to agree today.
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const ACCEPTED_CONTENT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "application/xml",
  "text/xml",
];
const USER_AGENT =
  "Mozilla/5.0 (compatible; ProspectCopilot/0.1; +https://github.com) ";

// A URL may only reach a normal web port. Without this the fetcher would
// connect to any port on a public host, so distinct failure categories
// (connection_reset vs timeout vs http_status) would report which ports are
// open - turning prospect discovery into a port scanner.
const ALLOWED_PORTS = new Set(["80", "443"]);

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "instance-data",
]);

/**
 * Reject disallowed protocols, ports, and statically-blocked hostnames.
 * Shared by the initial URL parse and by every redirect hop.
 * @param url the URL to check
 * @throws Error when the protocol, port, or hostname is not allowed
 */
function assertAllowedProtocolAndHost(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchPageError(
      "invalid_url",
      `Unsupported protocol: ${url.protocol}`,
    );
  }
  if (BLOCKED_HOSTNAMES.has(url.hostname.toLowerCase())) {
    throw new FetchPageError(
      "blocked_host",
      `Blocked hostname: ${url.hostname}`,
    );
  }
  if (url.port !== "" && !ALLOWED_PORTS.has(url.port)) {
    throw new FetchPageError("blocked_host", `Blocked port: ${url.port}`);
  }
}

/**
 * Validate and normalize a URL for fetching.
 * @param raw the URL as provided by the caller
 * @returns parsed URL object
 * @throws Error when the URL is malformed or not http(s)
 */
export function normalizeUrl(raw: string): URL {
  const explicitProtocol = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (
    explicitProtocol &&
    !/^https?:$/i.test(explicitProtocol[1]) &&
    !raw.startsWith("https://") &&
    !raw.startsWith("http://")
  ) {
    throw new FetchPageError(
      "invalid_url",
      `Unsupported protocol: ${explicitProtocol[1]}:`,
    );
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch (caught) {
    throw new FetchPageError("invalid_url", `Invalid URL: ${raw}`, {
      cause: caught,
    });
  }
  assertAllowedProtocolAndHost(url);
  return url;
}

/**
 * Resolve a redirect Location header against the URL that produced it and
 * re-run the static allow checks on the result.
 * @param currentUrl the URL that returned the redirect
 * @param location the raw Location header value
 * @returns the validated next-hop URL
 * @throws Error when the target's protocol or hostname is not allowed
 */
function resolveRedirectTarget(currentUrl: URL, location: string): URL {
  const next = new URL(location, currentUrl);
  assertAllowedProtocolAndHost(next);
  return next;
}

/**
 * Check whether an IP address is public (not loopback/private/link-local).
 * @param ip the address to check
 * @returns true when public
 */
export function isPublicIp(ip: string): boolean {
  try {
    const normalized = ip.startsWith("[") && ip.endsWith("]")
      ? ip.slice(1, -1)
      : ip;
    return ipaddr.process(normalized).range() === "unicast";
  } catch {
    return false;
  }
}

/**
 * Await an operation while allowing its caller to stop waiting immediately.
 * @param operation the promise to await
 * @param signal optional cancellation signal
 * @returns the operation's value, or a rejection carrying the abort reason
 */
function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (caught) => {
        signal.removeEventListener("abort", onAbort);
        reject(caught);
      },
    );
  });
}

/**
 * Resolve a hostname (or accept an IP literal) and return every address it
 * maps to. Every request connects directly to one of these addresses - no
 * second lookup happens later - so there is no window for DNS to change
 * between validation and connection.
 * @param hostname the host to resolve
 * @param signal optional cancellation signal for the DNS lookup
 * @returns all resolved addresses, guaranteed public
 * @throws Error when resolution fails or any address is non-public
 * @internal exported for deterministic transport-boundary tests
 */
export async function resolvePublicAddresses(
  hostname: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const normalizedHostname =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const literal = isIP(normalizedHostname);
  if (literal !== 0) {
    if (!isPublicIp(normalizedHostname)) {
      throw new FetchPageError(
        "blocked_host",
        `Blocked non-public host: ${hostname}`,
      );
    }
    return [normalizedHostname];
  }
  let records: { address: string }[];
  try {
    records = await withAbort(lookup(normalizedHostname, { all: true }), signal);
  } catch (caught) {
    if (signal?.aborted) signal.throwIfAborted();
    const code =
      typeof caught === "object" && caught !== null && "code" in caught
        ? String((caught as { code: unknown }).code)
        : "";
    const temporary = code === "EAI_AGAIN";
    throw new FetchPageError(
      temporary ? "temporary_dns" : "permanent_dns",
      `Could not resolve host: ${hostname}`,
      { cause: caught, retryable: temporary },
    );
  }
  if (records.length === 0 || !records.every((record) => isPublicIp(record.address))) {
    throw new FetchPageError(
      "blocked_host",
      `Blocked non-public host: ${hostname}`,
    );
  }
  return records.map((record) => record.address);
}

/** Parsed response returned by one pinned HTTP request. */
export interface RawResponse {
  status: number;
  location: string | null;
  html: string;
  retryAfterMs: number | null;
}

/** Injectable boundaries used to test variant retry without external traffic. */
export interface FetchWithVariantsRuntime {
  fetchAttempt: (
    raw: string,
    signal: AbortSignal | undefined,
    addressAttempt: number,
  ) => Promise<FetchedPage>;
  delay: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

/** Injectable secure-fetch boundaries used by deterministic network tests. */
export interface FetchPageRuntime {
  resolveAddresses: (
    hostname: string,
    signal?: AbortSignal,
  ) => Promise<string[]>;
  request: (
    url: URL,
    pinnedIp: string,
    signal: AbortSignal,
  ) => Promise<RawResponse>;
  timeoutMs: number;
}

/**
 * Parse a Retry-After header into a bounded delay.
 * @param raw header value in seconds or HTTP-date form
 * @returns bounded delay in milliseconds, or null when unusable
 * @internal exported for deterministic transport-boundary tests
 */
export function parseRetryAfter(raw: string | undefined): number | null {
  if (!raw) return null;
  const seconds = Number.parseFloat(raw);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(raw) - Date.now();
  if (!Number.isFinite(delay) || delay <= 0) return null;
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/**
 * Convert a low-level Node transport failure into a stable category.
 * @param caught original request error
 * @returns classified fetch failure
 * @internal exported for deterministic transport-boundary tests
 */
export function classifyTransportError(caught: unknown): FetchPageError {
  if (caught instanceof FetchPageError) return caught;
  const code =
    typeof caught === "object" && caught !== null && "code" in caught
      ? String((caught as { code: unknown }).code)
      : "";
  if (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH"
  ) {
    return new FetchPageError("connection_reset", "Connection failed", {
      cause: caught,
      retryable: true,
    });
  }
  if (
    code.startsWith("CERT_") ||
    code.includes("TLS") ||
    code.includes("CERTIFICATE") ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  ) {
    return new FetchPageError("certificate", "Certificate validation failed", {
      cause: caught,
    });
  }
  return new FetchPageError("unavailable", "Website request failed", {
    cause: caught,
    retryable: true,
  });
}

/**
 * Consume one HTTP response while enforcing content-type and byte limits.
 * @param res response stream returned by the pinned request
 * @returns bounded response metadata and body
 * @internal exported for deterministic transport-boundary tests
 */
export function readPinnedResponse(res: IncomingMessage): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let hasSettled = false;
    const status = res.statusCode ?? 0;
    const contentType = res.headers["content-type"]?.toLowerCase();
    const rejectOnce = (caught: unknown): void => {
      if (hasSettled) return;
      hasSettled = true;
      reject(caught);
    };
    res.on("error", rejectOnce);
    const contentTypeAllowed =
      !contentType ||
      ACCEPTED_CONTENT_TYPES.some((allowed) => contentType.includes(allowed));
    if (!REDIRECT_STATUSES.has(status) && !contentTypeAllowed) {
      const failure = new FetchPageError(
        "unsupported_content_type",
        `Unsupported content type: ${contentType}`,
      );
      res.destroy(failure);
      rejectOnce(failure);
      return;
    }
    res.on("data", (chunk: Buffer | string) => {
      if (hasSettled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > MAX_HTML_BYTES) {
        const failure = new FetchPageError(
          "response_too_large",
          `Response exceeded ${MAX_HTML_BYTES} bytes`,
        );
        res.destroy(failure);
        rejectOnce(failure);
        return;
      }
      chunks.push(buffer);
    });
    res.on("end", () => {
      if (hasSettled) return;
      hasSettled = true;
      resolve({
        status,
        location: res.headers.location ?? null,
        html: Buffer.concat(chunks).toString("utf-8"),
        retryAfterMs: parseRetryAfter(res.headers["retry-after"]),
      });
    });
  });
}

/**
 * Perform one GET request against a pre-validated URL, connecting directly
 * to a pinned, already-validated IP so no second DNS lookup can happen
 * between validation and connection.
 * @param url the request URL (already protocol/host validated)
 * @param pinnedIp the validated address to connect to
 * @param signal abort signal for the shared request timeout
 * @returns status, any Location header, and the (possibly truncated) body
 * @internal exported for deterministic transport-boundary tests
 */
export function requestPinned(
  url: URL,
  pinnedIp: string,
  signal: AbortSignal,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
    let hasSettled = false;
    const resolveOnce = (response: RawResponse): void => {
      if (hasSettled) return;
      hasSettled = true;
      resolve(response);
    };
    const rejectOnce = (caught: unknown): void => {
      if (hasSettled) return;
      hasSettled = true;
      reject(classifyTransportError(caught));
    };
    const onResponse = (res: IncomingMessage): void => {
      void readPinnedResponse(res).then(resolveOnce, rejectOnce);
    };
    const req = isHttps
      ? httpsRequest(
          {
            hostname: pinnedIp,
            port,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers: { host: url.host, "user-agent": USER_AGENT, accept: "text/html,*/*" },
            servername: url.hostname,
            signal,
          },
          onResponse,
        )
      : httpRequest(
          {
            hostname: pinnedIp,
            port,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers: { host: url.host, "user-agent": USER_AGENT, accept: "text/html,*/*" },
            signal,
          },
          onResponse,
        );
    req.on("error", rejectOnce);
    req.end();
  });
}

const DEFAULT_FETCH_PAGE_RUNTIME: FetchPageRuntime = {
  resolveAddresses: resolvePublicAddresses,
  request: requestPinned,
  timeoutMs: FETCH_TIMEOUT_MS,
};

/**
 * Compute bounded exponential backoff with small jitter.
 * @param attempt one-based failed attempt number
 * @param retryAfterMs optional server-requested delay
 * @returns delay in milliseconds
 */
function retryDelayMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const exponential = INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * INITIAL_RETRY_DELAY_MS);
  return Math.min(exponential + jitter, MAX_RETRY_DELAY_MS);
}

/**
 * Fetch a page after SSRF checks, following redirects. Each hop - the
 * original URL and every redirect target - is independently resolved and
 * validated before it is connected to.
 * @param raw target URL
 * @param signal optional caller cancellation signal
 * @param addressAttempt zero-based network attempt used to rotate addresses
 * @param runtime injectable secure-fetch boundaries used by focused tests
 * @returns status, final URL, and HTML body
 * @throws Error when blocked, unreachable, oversized, or redirect-looping
 */
export async function fetchPage(
  raw: string,
  signal?: AbortSignal,
  addressAttempt: number = 0,
  runtime: FetchPageRuntime = DEFAULT_FETCH_PAGE_RUNTIME,
): Promise<FetchedPage> {
  let url = normalizeUrl(raw);
  const controller = new AbortController();
  let hasTimedOut = false;
  const timer = setTimeout(() => {
    hasTimedOut = true;
    controller.abort();
  }, runtime.timeoutMs);
  const abortFromCaller = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    for (let redirects = 0; ; redirects++) {
      controller.signal.throwIfAborted();
      const addresses = await runtime.resolveAddresses(
        url.hostname,
        controller.signal,
      );
      if (addresses.length === 0) {
        throw new FetchPageError(
          "permanent_dns",
          `Could not resolve host: ${url.hostname}`,
        );
      }
      const pinnedIp = addresses[addressAttempt % addresses.length];
      if (pinnedIp === undefined) {
        throw new FetchPageError(
          "permanent_dns",
          `Could not resolve host: ${url.hostname}`,
        );
      }
      controller.signal.throwIfAborted();
      let response: RawResponse;
      try {
        response = await runtime.request(url, pinnedIp, controller.signal);
      } catch (caught) {
        if (signal?.aborted) signal.throwIfAborted();
        if (hasTimedOut) {
          throw new FetchPageError("timeout", `Timed out fetching ${raw}`, {
            cause: caught,
            retryable: true,
          });
        }
        throw caught;
      }
      if (!REDIRECT_STATUSES.has(response.status) || !response.location) {
        return {
          url: url.toString(),
          status: response.status,
          html: response.html,
          retryAfterMs: response.retryAfterMs,
        };
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new FetchPageError(
          "redirect_limit",
          `Too many redirects for ${raw}`,
        );
      }
      url = resolveRedirectTarget(url, response.location);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

const DEFAULT_FETCH_WITH_VARIANTS_RUNTIME: FetchWithVariantsRuntime = {
  fetchAttempt: fetchPage,
  delay: delayWithSignal,
};

/**
 * Try a sequence of URL variants (https/www permutations) until one loads.
 * @param raw the user-supplied URL
 * @param signal optional caller cancellation signal
 * @param runtime injectable retry boundaries used by focused tests
 * @returns the first successful fetch
 * @throws the last error when every variant fails
 */
export async function fetchWithVariants(
  raw: string,
  signal?: AbortSignal,
  runtime: FetchWithVariantsRuntime = DEFAULT_FETCH_WITH_VARIANTS_RUNTIME,
): Promise<FetchedPage> {
  const base = normalizeUrl(raw);
  const variants = [
    base.toString(),
    new URL(base.toString().replace("://www.", "://")).toString(),
    new URL(base.toString().replace("https://", "http://")).toString(),
  ];
  const unique = [...new Set(variants)];
  let lastError: unknown = null;
  let attempt = 0;
  let variantIndex = 0;
  while (attempt < MAX_NETWORK_ATTEMPTS && variantIndex < unique.length) {
    const variant = unique[variantIndex];
    attempt += 1;
    signal?.throwIfAborted();
    try {
      const page = await runtime.fetchAttempt(variant, signal, attempt - 1);
      if (page.status < 400) return page;
      const retryable = RETRYABLE_HTTP_STATUSES.has(page.status);
      lastError = new FetchPageError(
        "http_status",
        `HTTP ${page.status} for ${variant}`,
        {
          retryable,
          status: page.status,
          retryAfterMs: page.retryAfterMs,
        },
      );
    } catch (caught) {
      signal?.throwIfAborted();
      lastError = caught;
    }
    if (isRetryableFetchError(lastError) && attempt < MAX_NETWORK_ATTEMPTS) {
      const retryAfterMs =
        lastError instanceof FetchPageError ? lastError.retryAfterMs : null;
      if (attempt > 1 && variantIndex + 1 < unique.length) {
        variantIndex += 1;
      }
      await runtime.delay(retryDelayMs(attempt, retryAfterMs), signal);
      continue;
    }
    throw lastError;
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not reach ${raw}`);
}
