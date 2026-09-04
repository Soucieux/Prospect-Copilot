import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchPageError } from "./fetch-errors";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

const {
  classifyTransportError,
  parseRetryAfter,
  requestPinned,
  resolvePublicAddresses,
} = await import("./fetch-page");

/**
 * Start a throwaway HTTP server on the loopback interface.
 * @param handler responder invoked for every request
 * @returns the running server and the port it listens on
 */
async function startServer(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

const openServers: Server[] = [];

afterEach(async () => {
  lookupMock.mockReset();
  await Promise.all(
    openServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

/**
 * Start a server that is closed automatically after the test.
 * @param handler responder invoked for every request
 * @returns the port the server listens on
 */
async function serve(
  handler: Parameters<typeof createServer>[1],
): Promise<number> {
  const { server, port } = await startServer(handler);
  openServers.push(server);
  return port;
}

describe("parseRetryAfter", () => {
  it("reads a delay given in seconds", () => {
    expect(parseRetryAfter("1")).toBe(1_000);
  });

  it("reads a delay given as an HTTP date", () => {
    const soon = new Date(Date.now() + 1_500).toUTCString();
    const parsed = parseRetryAfter(soon);
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(2_000);
  });

  it("returns null when the header is absent", () => {
    expect(parseRetryAfter(undefined)).toBeNull();
  });

  it("returns null for an unparseable value", () => {
    expect(parseRetryAfter("later")).toBeNull();
  });

  it("returns null for a delay that has already passed", () => {
    expect(parseRetryAfter("-5")).toBeNull();
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBeNull();
  });

  it("clamps a very long delay to the retry ceiling", () => {
    expect(parseRetryAfter("600")).toBe(2_000);
  });
});

describe("classifyTransportError", () => {
  it("passes an existing fetch error through unchanged", () => {
    const original = new FetchPageError("blocked_host", "blocked");
    expect(classifyTransportError(original)).toBe(original);
  });

  it.each(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"])(
    "classifies %s as a retryable connection failure",
    (code) => {
      const failure = classifyTransportError(Object.assign(new Error("x"), { code }));
      expect(failure.code).toBe("connection_reset");
      expect(failure.retryable).toBe(true);
    },
  );

  it.each(["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"])(
    "classifies %s as a certificate failure that is not retried",
    (code) => {
      const failure = classifyTransportError(Object.assign(new Error("x"), { code }));
      expect(failure.code).toBe("certificate");
      expect(failure.retryable).toBe(false);
    },
  );

  it("falls back to a retryable unavailable error for an unknown code", () => {
    const failure = classifyTransportError(Object.assign(new Error("x"), { code: "EWAT" }));
    expect(failure.code).toBe("unavailable");
    expect(failure.retryable).toBe(true);
  });

  it("handles a thrown value that is not an object", () => {
    const failure = classifyTransportError("plain string");
    expect(failure.code).toBe("unavailable");
  });
});

describe("resolvePublicAddresses", () => {
  it("accepts a public IP literal without consulting DNS", async () => {
    await expect(resolvePublicAddresses("93.184.216.34")).resolves.toEqual([
      "93.184.216.34",
    ]);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("unwraps a bracketed IPv6 literal", async () => {
    await expect(resolvePublicAddresses("[2606:2800:220:1::]")).resolves.toEqual([
      "2606:2800:220:1::",
    ]);
  });

  it.each(["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "[::1]"])(
    "blocks the non-public literal %s",
    async (host) => {
      await expect(resolvePublicAddresses(host)).rejects.toMatchObject({
        code: "blocked_host",
      });
    },
  );

  it("returns every public address a hostname resolves to", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34" },
      { address: "93.184.216.35" },
    ]);
    await expect(resolvePublicAddresses("acme.com")).resolves.toEqual([
      "93.184.216.34",
      "93.184.216.35",
    ]);
  });

  it("blocks a hostname that resolves to any private address", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34" },
      { address: "127.0.0.1" },
    ]);
    await expect(resolvePublicAddresses("rebind.example")).rejects.toMatchObject({
      code: "blocked_host",
    });
  });

  it("blocks a hostname that resolves to nothing", async () => {
    lookupMock.mockResolvedValue([]);
    await expect(resolvePublicAddresses("empty.example")).rejects.toMatchObject({
      code: "blocked_host",
    });
  });

  it("treats EAI_AGAIN as a temporary, retryable DNS failure", async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error("dns"), { code: "EAI_AGAIN" }));
    await expect(resolvePublicAddresses("flaky.example")).rejects.toMatchObject({
      code: "temporary_dns",
      retryable: true,
    });
  });

  it("treats any other DNS failure as permanent", async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error("dns"), { code: "ENOTFOUND" }));
    await expect(resolvePublicAddresses("missing.example")).rejects.toMatchObject({
      code: "permanent_dns",
      retryable: false,
    });
  });

  it("classifies a DNS failure carrying no code as permanent", async () => {
    lookupMock.mockRejectedValue(new Error("dns"));
    await expect(resolvePublicAddresses("bare.example")).rejects.toMatchObject({
      code: "permanent_dns",
    });
  });

  it("surfaces the caller's abort reason instead of a DNS error", async () => {
    const controller = new AbortController();
    lookupMock.mockImplementation(() => new Promise(() => {}));
    const pending = resolvePublicAddresses("slow.example", controller.signal);
    controller.abort(new Error("caller went away"));
    await expect(pending).rejects.toThrow("caller went away");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    lookupMock.mockImplementation(() => new Promise(() => {}));
    await expect(
      resolvePublicAddresses("slow.example", controller.signal),
    ).rejects.toThrow("already gone");
  });
});

describe("requestPinned", () => {
  it("connects to the pinned address and returns the body", async () => {
    const port = await serve((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<p>host:${req.headers.host}</p>`);
    });
    const response = await requestPinned(
      new URL(`http://acme.example:${port}/page?q=1`),
      "127.0.0.1",
      new AbortController().signal,
    );
    expect(response.status).toBe(200);
    expect(response.html).toContain(`host:acme.example:${port}`);
  });

  it("sends the requested path and query to the origin", async () => {
    let seenUrl = "";
    const port = await serve((req, res) => {
      seenUrl = req.url ?? "";
      res.writeHead(200, { "content-type": "text/html" });
      res.end("ok");
    });
    await requestPinned(
      new URL(`http://acme.example:${port}/deep/path?a=b&c=d`),
      "127.0.0.1",
      new AbortController().signal,
    );
    expect(seenUrl).toBe("/deep/path?a=b&c=d");
  });

  it("reports a redirect location without following it", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(302, { location: "https://elsewhere.example/" });
      res.end();
    });
    const response = await requestPinned(
      new URL(`http://acme.example:${port}/`),
      "127.0.0.1",
      new AbortController().signal,
    );
    expect(response.status).toBe(302);
    expect(response.location).toBe("https://elsewhere.example/");
  });

  it("carries a Retry-After header through as a bounded delay", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(429, { "content-type": "text/html", "retry-after": "1" });
      res.end("slow down");
    });
    const response = await requestPinned(
      new URL(`http://acme.example:${port}/`),
      "127.0.0.1",
      new AbortController().signal,
    );
    expect(response.status).toBe(429);
    expect(response.retryAfterMs).toBe(1_000);
  });

  it("rejects a response whose content type is not a document", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end("binary");
    });
    await expect(
      requestPinned(
        new URL(`http://acme.example:${port}/`),
        "127.0.0.1",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "unsupported_content_type" });
  });

  it("classifies a refused connection as a retryable transport failure", async () => {
    const port = await serve((_req, res) => res.end());
    await new Promise<void>((resolve) =>
      openServers.splice(0)[0].close(() => resolve()),
    );
    await expect(
      requestPinned(
        new URL(`http://acme.example:${port}/`),
        "127.0.0.1",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "connection_reset", retryable: true });
  });

  it("stops the request when the caller aborts mid-flight", async () => {
    const controller = new AbortController();
    const port = await serve(() => {
      controller.abort();
    });
    await expect(
      requestPinned(
        new URL(`http://acme.example:${port}/`),
        "127.0.0.1",
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(FetchPageError);
  });
});
