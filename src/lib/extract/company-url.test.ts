import { describe, expect, it } from "vitest";
import {
  dedupeByHost,
  isLikelyCompanyUrl,
  looksLikeWebAddress,
} from "./company-url";

describe("isLikelyCompanyUrl", () => {
  it("accepts a normal company domain", () => {
    expect(isLikelyCompanyUrl("https://acme.example.com/about")).toBe(true);
  });

  it("rejects a single-label host that cannot be a public site", () => {
    expect(isLikelyCompanyUrl("https://intranet/")).toBe(false);
  });

  it.each([
    "https://www.linkedin.com/company/acme",
    "https://en.wikipedia.org/wiki/Acme",
    "https://www.facebook.com/acme",
    "https://twitter.com/acme",
    "https://x.com/acme",
    "https://www.x.com/acme",
  ])("rejects the non-company host %s", (url) => {
    expect(isLikelyCompanyUrl(url)).toBe(false);
  });

  it.each([
    "https://www.xerox.com.br/",
    "https://www.fedex.com.au/",
    "https://mylinkedin.example.com/",
  ])("accepts %s, whose name only resembles a platform's", (url) => {
    expect(isLikelyCompanyUrl(url)).toBe(true);
  });

  it("rejects a string that is not a URL at all", () => {
    expect(isLikelyCompanyUrl("not a url")).toBe(false);
  });
});

describe("looksLikeWebAddress", () => {
  it.each([
    "https://acme.example.com",
    "HTTP://ACME.EXAMPLE.COM/about",
    "acme.example.com",
    " acme.example.com/pricing?x=1 ",
    "宜家.中国",
  ])("recognizes %s as a web address", (value) => {
    expect(looksLikeWebAddress(value)).toBe(true);
  });

  it.each(["Acme Corp", "羊毛毯", "", "   ", "acme", ".com", "acme."])(
    "treats %j as a bare name rather than an address",
    (value) => {
      expect(looksLikeWebAddress(value)).toBe(false);
    },
  );

  it("ignores dots after the first path separator", () => {
    expect(looksLikeWebAddress("acme/index.html")).toBe(false);
  });
});

describe("dedupeByHost", () => {
  it("keeps the first entry for each host and drops later duplicates", () => {
    const deduped = dedupeByHost([
      { url: "https://acme.example.com/", label: "first" },
      { url: "https://acme.example.com/about", label: "duplicate" },
      { url: "https://globex.example.com/", label: "other" },
    ]);
    expect(deduped.map((entry) => entry.label)).toEqual(["first", "other"]);
  });

  it("drops entries whose URL cannot be parsed", () => {
    const deduped = dedupeByHost([
      { url: "not a url" },
      { url: "https://acme.example.com/" },
    ]);
    expect(deduped).toEqual([{ url: "https://acme.example.com/" }]);
  });

  it("returns an empty list for empty input", () => {
    expect(dedupeByHost([])).toEqual([]);
  });
});
