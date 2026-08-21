import { describe, expect, it } from "vitest";
import { isPublicIp, normalizeUrl } from "./fetch-page";

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

  it("accepts the public part of the 172 range", () => {
    expect(isPublicIp("172.32.0.1")).toBe(true);
    expect(isPublicIp("172.15.0.1")).toBe(true);
  });

  it("rejects IPv6 loopback and unique-local", () => {
    expect(isPublicIp("::1")).toBe(false);
    expect(isPublicIp("fd00::1")).toBe(false);
  });
});
