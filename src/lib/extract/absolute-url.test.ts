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
});
