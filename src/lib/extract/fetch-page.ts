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

export interface FetchedPage {
  url: string;
  status: number;
  html: string;
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT =
  "Mozilla/5.0 (compatible; ProspectCopilot/0.1; +https://github.com) ";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "instance-data",
]);

/**
 * Reject disallowed protocols and statically-blocked hostnames. Shared by
 * the initial URL parse and by every redirect hop.
 * @param url the URL to check
 * @throws Error when the protocol or hostname is not allowed
 */
function assertAllowedProtocolAndHost(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  if (BLOCKED_HOSTNAMES.has(url.hostname.toLowerCase())) {
    throw new Error(`Blocked hostname: ${url.hostname}`);
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
    throw new Error(`Unsupported protocol: ${explicitProtocol[1]}:`);
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
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
  if (ip === "::1" || ip === "0.0.0.0") return false;
  if (ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("169.254.") || ip.startsWith("192.168.")) {
    return false;
  }
  if (ip.startsWith("172.")) {
    const second = Number.parseInt(ip.split(".")[1] ?? "0", 10);
    if (second >= 16 && second <= 31) return false;
  }
  if (ip.toLowerCase().startsWith("fe80:") || ip.toLowerCase().startsWith("fc") || ip.toLowerCase().startsWith("fd")) {
    return false;
  }
  return true;
}

/**
 * Resolve a hostname (or accept an IP literal) and return every address it
 * maps to. Every request connects directly to one of these addresses - no
 * second lookup happens later - so there is no window for DNS to change
 * between validation and connection.
 * @param hostname the host to resolve
 * @returns all resolved addresses, guaranteed public
 * @throws Error when resolution fails or any address is non-public
 */
async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  const literal = isIP(hostname);
  if (literal !== 0) {
    if (!isPublicIp(hostname)) {
      throw new Error(`Blocked non-public host: ${hostname}`);
    }
    return [hostname];
  }
  let records: { address: string }[];
  try {
    records = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${hostname}`);
  }
  if (records.length === 0 || !records.every((record) => isPublicIp(record.address))) {
    throw new Error(`Blocked non-public host: ${hostname}`);
  }
  return records.map((record) => record.address);
}

/**
 * Check whether a hostname resolves to a public address.
 * @param hostname the host to check
 * @returns true when the host is (or resolves to) a public IP
 */
export async function isPublicHost(hostname: string): Promise<boolean> {
  try {
    await resolvePublicAddresses(hostname);
    return true;
  } catch {
    return false;
  }
}

interface RawResponse {
  status: number;
  location: string | null;
  html: string;
}

/**
 * Perform one GET request against a pre-validated URL, connecting directly
 * to a pinned, already-validated IP so no second DNS lookup can happen
 * between validation and connection.
 * @param url the request URL (already protocol/host validated)
 * @param pinnedIp the validated address to connect to
 * @param signal abort signal for the shared request timeout
 * @returns status, any Location header, and the (possibly truncated) body
 */
function requestPinned(
  url: URL,
  pinnedIp: string,
  signal: AbortSignal,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
    const onResponse = (res: IncomingMessage): void => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          location: res.headers.location ?? null,
          html: Buffer.concat(chunks).toString("utf-8").slice(0, MAX_HTML_BYTES),
        });
      });
      res.on("error", reject);
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
    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetch a page after SSRF checks, following redirects. Each hop - the
 * original URL and every redirect target - is independently resolved and
 * validated before it is connected to.
 * @param raw target URL
 * @returns status, final URL, and HTML body
 * @throws Error when blocked, unreachable, oversized, or redirect-looping
 */
export async function fetchPage(
  raw: string,
  signal?: AbortSignal,
): Promise<FetchedPage> {
  let url = normalizeUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const abortFromCaller = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    for (let redirects = 0; ; redirects++) {
      controller.signal.throwIfAborted();
      const [pinnedIp] = await resolvePublicAddresses(url.hostname);
      controller.signal.throwIfAborted();
      const response = await requestPinned(url, pinnedIp, controller.signal);
      if (!REDIRECT_STATUSES.has(response.status) || !response.location) {
        return { url: url.toString(), status: response.status, html: response.html };
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`Too many redirects for ${raw}`);
      }
      url = resolveRedirectTarget(url, response.location);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

/**
 * Try a sequence of URL variants (https/www permutations) until one loads.
 * @param raw the user-supplied URL
 * @returns the first successful fetch
 * @throws the last error when every variant fails
 */
export async function fetchWithVariants(
  raw: string,
  signal?: AbortSignal,
): Promise<FetchedPage> {
  const base = normalizeUrl(raw);
  const variants = [
    base.toString(),
    new URL(base.toString().replace("://www.", "://")).toString(),
    new URL(base.toString().replace("https://", "http://")).toString(),
  ];
  const unique = [...new Set(variants)];
  let lastError: unknown = null;
  for (const variant of unique) {
    signal?.throwIfAborted();
    try {
      const page = await fetchPage(variant, signal);
      if (page.status < 400) return page;
      lastError = new Error(`HTTP ${page.status} for ${variant}`);
    } catch (caught) {
      signal?.throwIfAborted();
      lastError = caught;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not reach ${raw}`);
}
