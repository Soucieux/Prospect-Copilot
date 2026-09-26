import { describe, expect, it } from "vitest";
import { absoluteUrl } from "@/lib/extract/absolute-url";

describe("absoluteUrl", () => {
  it("keeps an already absolute URL", () => {
    expect(absoluteUrl("https://acme.example.com/a")).toBe(
      "https://acme.example.com/a",
    );
    expect(absoluteUrl("http://acme.example.com")).toBe(
      "http://acme.example.com",
    );
  });

  it("gives a protocol-relative href a scheme without doubling its slashes", () => {
    expect(absoluteUrl("//www.linkedin.com/in/jane")).toBe(
      "https://www.linkedin.com/in/jane",
    );
  });

  it("prefixes a bare host", () => {
    expect(absoluteUrl("acme.example.com/team")).toBe(
      "https://acme.example.com/team",
    );
  });

  it("keeps a scheme written in capitals instead of prefixing a second one", () => {
    expect(absoluteUrl("HTTPS://www.linkedin.com/in/jane")).toBe(
      "HTTPS://www.linkedin.com/in/jane",
    );
    expect(absoluteUrl("Http://acme.example.com")).toBe(
      "Http://acme.example.com",
    );
  });

  it("treats a host that merely starts with http as bare", () => {
    expect(absoluteUrl("httpbin.example.com/status")).toBe(
      "https://httpbin.example.com/status",
    );
  });
});
