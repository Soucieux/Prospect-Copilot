import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { FetchPageError } from "./fetch-errors";
import {
  fetchPage,
  fetchWithVariants,
  isPublicIp,
  normalizeUrl,
  readPinnedResponse,
  type FetchPageRuntime,
  type FetchWithVariantsRuntime,
} from "./fetch-page";

/**
 * Build a controllable IncomingMessage-compatible response stream.
 * @param status HTTP status exposed by the stream
 * @param contentType response content type
 * @returns response facade and writable test stream
 */
function responseStream(
  status: number,
  contentType: string,
): { response: IncomingMessage; stream: PassThrough } {
  const stream = new PassThrough();
  const response = stream as unknown as IncomingMessage;
  response.statusCode = status;
  response.headers = { "content-type": contentType };
  return { response, stream };
}

describe("normalizeUrl", () => {
  it("adds https when no scheme is given", () => {
    expect(normalizeUrl("acme.com").toString()).toBe("https://acme.com/");
  });

  it("keeps an explicit http scheme", () => {
    expect(normalizeUrl("http://acme.com").protocol).toBe("http:");
  });

  it("rejects non-http protocols", () => {
    expect(() => normalizeUrl("file:///etc/passwd")).toThrow();
  });

  it("rejects blocked hostnames", () => {
    expect(() => normalizeUrl("http://localhost:3000")).toThrow(/Blocked/);
  });

  it("rejects a non-web port on an otherwise allowed public host", () => {
    expect(() => normalizeUrl("https://acme.com:22")).toThrow(/Blocked port/);
    expect(() => normalizeUrl("https://acme.com:6379")).toThrow(/Blocked port/);
  });

  it("keeps a web port that is not the scheme default", () => {
    expect(normalizeUrl("http://acme.com:443").port).toBe("443");
  });
});

describe("isPublicIp", () => {
  it("accepts public addresses", () => {
    expect(isPublicIp("93.184.216.34")).toBe(true);
    expect(isPublicIp("8.8.8.8")).toBe(true);
  });

  it("rejects loopback and private ranges", () => {
    expect(isPublicIp("127.0.0.1")).toBe(false);
    expect(isPublicIp("10.1.2.3")).toBe(false);
    expect(isPublicIp("192.168.1.1")).toBe(false);
    expect(isPublicIp("172.16.0.1")).toBe(false);
    expect(isPublicIp("172.31.255.255")).toBe(false);
    expect(isPublicIp("169.254.1.1")).toBe(false);
  });

  it("rejects mapped, shared, link-local, multicast, and reserved ranges", () => {
    expect(isPublicIp("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIp("100.64.0.1")).toBe(false);
    expect(isPublicIp("198.18.0.1")).toBe(false);
    expect(isPublicIp("224.0.0.1")).toBe(false);
    expect(isPublicIp("fe90::1")).toBe(false);
    expect(isPublicIp("ff02::1")).toBe(false);
    expect(isPublicIp("2001:db8::1")).toBe(false);
  });

  it("accepts globally routable IPv6 addresses", () => {
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
  });

  it("accepts the public part of the 172 range", () => {
    expect(isPublicIp("172.32.0.1")).toBe(true);
    expect(isPublicIp("172.15.0.1")).toBe(true);
  });

  it("rejects IPv6 loopback and unique-local", () => {
    expect(isPublicIp("::1")).toBe(false);
    expect(isPublicIp("fd00::1")).toBe(false);
  });
});

describe("fetchPage", () => {
  it("passes cancellation into DNS resolution and stops promptly", async () => {
    const controller = new AbortController();
    let resolverSignal: AbortSignal | undefined;
    const runtime: FetchPageRuntime = {
      resolveAddresses: (_hostname, signal) => {
        resolverSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
      request: vi.fn(),
      timeoutMs: 5_000,
    };

    const pending = fetchPage("https://example.com", controller.signal, 0, runtime);
    controller.abort(new DOMException("Stopped", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(resolverSignal?.aborted).toBe(true);
  });

  it("stops before network resolution when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchPage("https://example.com", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects an unsupported response content type before buffering it", async () => {
    const { response } = responseStream(200, "application/pdf");
    await expect(readPinnedResponse(response)).rejects.toMatchObject({
      code: "unsupported_content_type",
    });
  });

  it("stops reading when a response exceeds the byte limit", async () => {
    const { response, stream } = responseStream(200, "text/html");
    const pending = readPinnedResponse(response);
    stream.end(Buffer.alloc(3_000_001));
    await expect(pending).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  it("rejects a redirect chain that exceeds the hop limit", async () => {
    const runtime: FetchPageRuntime = {
      resolveAddresses: async () => ["93.184.216.34"],
      request: async () => ({
        status: 302,
        location: "/again",
        html: "",
        retryAfterMs: null,
      }),
      timeoutMs: 1_000,
    };

    await expect(
      fetchPage("https://example.com", undefined, 0, runtime),
    ).rejects.toMatchObject({ code: "redirect_limit" });
  });

  it("rejects a redirect that lands on a non-web port", async () => {
    const runtime: FetchPageRuntime = {
      resolveAddresses: async () => ["93.184.216.34"],
      request: async () => ({
        status: 302,
        location: "https://example.com:22/",
        html: "",
        retryAfterMs: null,
      }),
      timeoutMs: 1_000,
    };

    await expect(
      fetchPage("https://example.com", undefined, 0, runtime),
    ).rejects.toMatchObject({ code: "blocked_host" });
  });

  it("classifies the internal request deadline as a retryable timeout", async () => {
    const runtime: FetchPageRuntime = {
      resolveAddresses: async () => ["93.184.216.34"],
      request: async (_url, _pinnedIp, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      timeoutMs: 1,
    };

    await expect(
      fetchPage("https://example.com", undefined, 0, runtime),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
  });
});

describe("fetchWithVariants", () => {
  /**
   * Build a no-wait retry runtime around one injected fetch attempt.
   * @param fetchAttempt injected page attempt
   * @returns deterministic retry runtime
   */
  function retryRuntime(
    fetchAttempt: FetchWithVariantsRuntime["fetchAttempt"],
  ): FetchWithVariantsRuntime {
    return { fetchAttempt, delay: async () => undefined };
  }

  it("retries a temporary server response and then succeeds", async () => {
    const fetchAttempt = vi
      .fn<FetchWithVariantsRuntime["fetchAttempt"]>()
      .mockResolvedValueOnce({
        url: "https://example.com/",
        status: 503,
        html: "temporary",
      })
      .mockResolvedValueOnce({
        url: "https://example.com/",
        status: 200,
        html: "ready",
      });

    const result = await fetchWithVariants(
      "https://example.com",
      undefined,
      retryRuntime(fetchAttempt),
    );

    expect(result.status).toBe(200);
    expect(fetchAttempt).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent client response", async () => {
    const fetchAttempt = vi.fn<FetchWithVariantsRuntime["fetchAttempt"]>(
      async (raw) => ({ url: raw, status: 403, html: "blocked" }),
    );

    await expect(
      fetchWithVariants(
        "https://example.com",
        undefined,
        retryRuntime(fetchAttempt),
      ),
    ).rejects.toMatchObject({ code: "http_status", status: 403 });
    expect(fetchAttempt).toHaveBeenCalledTimes(1);
  });

  it("rotates the validated address index between transient attempts", async () => {
    const addressAttempts: number[] = [];
    const fetchAttempt = vi.fn<FetchWithVariantsRuntime["fetchAttempt"]>(
      async (raw, _signal, addressAttempt) => {
        addressAttempts.push(addressAttempt);
        if (addressAttempt === 0) {
          throw new FetchPageError("connection_reset", "unreachable", {
            retryable: true,
          });
        }
        return { url: raw, status: 200, html: "ready" };
      },
    );

    await fetchWithVariants(
      "https://example.com",
      undefined,
      retryRuntime(fetchAttempt),
    );

    expect(addressAttempts).toEqual([0, 1]);
  });

  it("honors a bounded Retry-After delay", async () => {
    const delay = vi.fn(async () => undefined);
    const fetchAttempt = vi
      .fn<FetchWithVariantsRuntime["fetchAttempt"]>()
      .mockResolvedValueOnce({
        url: "https://example.com/",
        status: 429,
        html: "limited",
        retryAfterMs: 1_500,
      })
      .mockResolvedValueOnce({
        url: "https://example.com/",
        status: 200,
        html: "ready",
      });

    await fetchWithVariants("https://example.com", undefined, {
      fetchAttempt,
      delay,
    });

    expect(delay).toHaveBeenCalledWith(1_500, undefined);
  });

  it("stops retry backoff when the caller cancels", async () => {
    const controller = new AbortController();
    const fetchAttempt = vi.fn<FetchWithVariantsRuntime["fetchAttempt"]>(
      async () => {
        throw new FetchPageError("timeout", "temporary", {
          retryable: true,
        });
      },
    );
    const runtime: FetchWithVariantsRuntime = {
      fetchAttempt,
      delay: async (_delayMs, signal) => {
        controller.abort();
        signal?.throwIfAborted();
      },
    };

    await expect(
      fetchWithVariants("https://example.com", controller.signal, runtime),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchAttempt).toHaveBeenCalledTimes(1);
  });
});
