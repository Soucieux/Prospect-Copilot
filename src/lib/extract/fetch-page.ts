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
import {
  backoffDelayMs,
  createAbortContext,
  delayWithSignal,
} from "@/lib/retry";

/** A successfully fetched document; an error status is thrown, never returned. */
export interface FetchedPage {
  url: string;
  status: number;
  html: string;
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;
const MAX_NETWORK_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 300;
const MAX_RETRY_DELAY_MS = 2_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Deliberately separate from the LLM retry policy in llm.ts: page fetching
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
  "Mozilla/5.0 (compatible; ProspectCopilot/0.1; +https://github.com)";

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
  // The capture excludes the colon, so the scheme is compared without one.
  const explicitProtocol = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)?.[1];
  if (explicitProtocol && !/^https?$/i.test(explicitProtocol)) {
    throw new FetchPageError(
      "invalid_url",
      `Unsupported protocol: ${explicitProtocol}:`,
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
 * Strip the brackets an IPv6 literal carries inside a URL host.
 * @param host a hostname or IP literal, possibly bracketed
 * @returns the host without surrounding brackets
 */
function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Read the `code` a Node error carries, when it carries one.
 * @param caught unknown thrown value
 * @returns the code as a string, or an empty string when absent
 */
function errorCode(caught: unknown): string {
  return typeof caught === "object" && caught !== null && "code" in caught
    ? String((caught as { code: unknown }).code)
    : "";
}

/**
 * Check whether an IP address is public (not loopback/private/link-local).
 * @param ip the address to check
 * @returns true when public
 */
export function isPublicIp(ip: string): boolean {
  try {
    return ipaddr.process(unbracket(ip)).range() === "unicast";
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
    /** Reject with the caller's abort reason. */
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
  const normalizedHostname = unbracket(hostname);
  if (isIP(normalizedHostname) !== 0) {
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
    const temporary = errorCode(caught) === "EAI_AGAIN";
    throw new FetchPageError(
      temporary ? "temporary_dns" : "permanent_dns",
      `Could not resolve host: ${hostname}`,
      { cause: caught, retryable: temporary },
    );
  }
  const allPublic = records.every((record) => isPublicIp(record.address));
  if (records.length === 0 || !allPublic) {
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
  const code = errorCode(caught);
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
    /** Reject the first failure and ignore any later one. */
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
    /** Resolve on the first response and ignore any later settle. */
    const resolveOnce = (response: RawResponse): void => {
      if (hasSettled) return;
      hasSettled = true;
      resolve(response);
    };
    /** Reject the first failure, classified, and ignore any later one. */
    const rejectOnce = (caught: unknown): void => {
      if (hasSettled) return;
      hasSettled = true;
      reject(classifyTransportError(caught));
    };
    /** Read the pinned response and settle exactly once. */
    const onResponse = (res: IncomingMessage): void => {
      void readPinnedResponse(res).then(resolveOnce, rejectOnce);
    };
    const options = {
      hostname: pinnedIp,
      port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        host: url.host,
        "user-agent": USER_AGENT,
        accept: "text/html,*/*",
      },
      signal,
    };
    // TLS needs the real hostname for SNI and certificate matching, since the
    // connection itself goes to the pinned address rather than to the name.
    const req = isHttps
      ? httpsRequest({ ...options, servername: url.hostname }, onResponse)
      : httpRequest(options, onResponse);
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
 * Fetch a page after SSRF checks, following redirects. Each hop - the
 * original URL and every redirect target - is independently resolved and
 * validated before it is connected to. An error status is a failure, not a
 * page: an error document must never be read as company evidence.
 * @param raw target URL
 * @param signal optional caller cancellation signal
 * @param addressAttempt zero-based network attempt used to rotate addresses
 * @param runtime injectable secure-fetch boundaries used by focused tests
 * @returns status, final URL, and HTML body
 * @throws FetchPageError when blocked, unreachable, oversized, redirect-looping,
 *   or answered with an error status
 */
export async function fetchPage(
  raw: string,
  signal?: AbortSignal,
  addressAttempt: number = 0,
  runtime: FetchPageRuntime = DEFAULT_FETCH_PAGE_RUNTIME,
): Promise<FetchedPage> {
  let url = normalizeUrl(raw);
  const abort = createAbortContext(runtime.timeoutMs, signal);
  try {
    for (let redirects = 0; ; redirects++) {
      abort.signal.throwIfAborted();
      const addresses = await runtime.resolveAddresses(
        url.hostname,
        abort.signal,
      );
      const pinnedIp = addresses[addressAttempt % addresses.length];
      if (pinnedIp === undefined) {
        throw new FetchPageError(
          "permanent_dns",
          `Could not resolve host: ${url.hostname}`,
        );
      }
      abort.signal.throwIfAborted();
      let response: RawResponse;
      try {
        response = await runtime.request(url, pinnedIp, abort.signal);
      } catch (caught) {
        if (signal?.aborted) signal.throwIfAborted();
        if (abort.timedOut()) {
          throw new FetchPageError("timeout", `Timed out fetching ${raw}`, {
            cause: caught,
            retryable: true,
          });
        }
        throw caught;
      }
      if (REDIRECT_STATUSES.has(response.status) && response.location) {
        if (redirects >= MAX_REDIRECTS) {
          throw new FetchPageError(
            "redirect_limit",
            `Too many redirects for ${raw}`,
          );
        }
        url = resolveRedirectTarget(url, response.location);
        continue;
      }
      if (response.status >= 400) {
        throw new FetchPageError(
          "http_status",
          `HTTP ${response.status} for ${url}`,
          {
            retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
            status: response.status,
            retryAfterMs: response.retryAfterMs,
          },
        );
      }
      return {
        url: url.toString(),
        status: response.status,
        html: response.html,
      };
    }
  } finally {
    abort.cleanup();
  }
}

const DEFAULT_FETCH_WITH_VARIANTS_RUNTIME: FetchWithVariantsRuntime = {
  fetchAttempt: fetchPage,
  delay: delayWithSignal,
};

/**
 * Fetch a URL within one bounded attempt budget shared by its variants (the
 * URL as given, without `www.`, then over plain http). Only a temporary
 * failure is retried: the first retry repeats the same variant and later ones
 * advance to the next. A permanent failure - a blocked host, a client error,
 * a certificate or permanent DNS failure - is thrown at once and no other
 * variant is tried.
 * @param raw the user-supplied URL
 * @param signal optional caller cancellation signal
 * @param runtime injectable retry boundaries used by focused tests
 * @returns the first successful fetch
 * @throws the first permanent error, or the last temporary one once the
 *   attempt budget is spent
 */
export async function fetchWithVariants(
  raw: string,
  signal?: AbortSignal,
  runtime: FetchWithVariantsRuntime = DEFAULT_FETCH_WITH_VARIANTS_RUNTIME,
): Promise<FetchedPage> {
  const primary = normalizeUrl(raw).toString();
  const variants = [
    ...new Set([
      primary,
      new URL(primary.replace("://www.", "://")).toString(),
      new URL(primary.replace("https://", "http://")).toString(),
    ]),
  ];
  let variantIndex = 0;
  for (let attempt = 1; ; attempt++) {
    // The index never leaves the array; the fallback only narrows the type.
    const variant = variants[variantIndex] ?? primary;
    signal?.throwIfAborted();
    let failure: unknown;
    try {
      return await runtime.fetchAttempt(variant, signal, attempt - 1);
    } catch (caught) {
      signal?.throwIfAborted();
      failure = caught;
    }
    if (!isRetryableFetchError(failure) || attempt >= MAX_NETWORK_ATTEMPTS) {
      throw failure;
    }
    if (attempt > 1 && variantIndex + 1 < variants.length) variantIndex += 1;
    const retryAfterMs =
      failure instanceof FetchPageError ? failure.retryAfterMs : null;
    await runtime.delay(
      retryAfterMs ??
        backoffDelayMs(attempt, INITIAL_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS),
      signal,
    );
  }
}
