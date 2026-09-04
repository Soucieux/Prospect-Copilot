import { describe, expect, it } from "vitest";
import {
  analyzeProspect,
  detectTechStack,
  parseEmployeeCount,
} from "./analyze-prospect";

const PAGE_URL = "https://acme-analytics.example.com";

const HOMEPAGE_HTML = `<!doctype html>
<html>
<head>
  <title>Acme Analytics - Product analytics for B2B SaaS</title>
  <meta name="description" content="Acme Analytics turns product data into revenue insight.">
  <script type="application/ld+json">
    {"@type":"Organization","name":"Acme Analytics","foundingDate":"2019-04-01",
     "numberOfEmployees":85,"address":"1 Market St, San Francisco"}
  </script>
  <script src="https://cdn.segment.com/analytics.js/v1/xyz/analytics.min.js"></script>
  <script src="https://js.stripe.com/v3/"></script>
</head>
<body>
  <a href="/pricing">Pricing</a>
  <a href="https://www.linkedin.com/company/acme-analytics">LinkedIn</a>
  <a href="https://github.com/acme">GitHub</a>
  <a href="/about">About</a>
  <a href="mailto:hello@acme-analytics.example.com">hello@acme-analytics.example.com</a>
</body>
</html>`;

describe("analyzeProspect email bounds", () => {
  it("caps extracted emails so one page cannot flood the briefing", () => {
    const many = Array.from(
      { length: 40 },
      (_value, index) => `<a href="mailto:p${index}@acme.example.com">c</a>`,
    ).join("");
    const result = analyzeProspect(`<html><body>${many}</body></html>`, PAGE_URL);
    expect(result.emails).toHaveLength(20);
  });
});

describe("analyzeProspect", () => {
  const result = analyzeProspect(HOMEPAGE_HTML, PAGE_URL);

  it("extracts company identity from JSON-LD first", () => {
    expect(result.companyName).toBe("Acme Analytics");
    expect(result.title).toContain("Acme Analytics");
    expect(result.description).toContain("revenue insight");
    expect(result.jsonLdOrg?.numberOfEmployees).toBe(85);
  });

  it("detects the tech stack from script fingerprints", () => {
    expect(result.techStack).toContain("Segment");
    expect(result.techStack).toContain("Stripe");
    expect(detectTechStack("plain text")).toEqual([]);
  });

  it("finds social profiles and emails", () => {
    expect(result.socialProfiles.some((s) => s.includes("linkedin.com"))).toBe(true);
    expect(result.emails).toContain("hello@acme-analytics.example.com");
  });

  it("normalizes scheme-relative social links", () => {
    const extracted = analyzeProspect(
      '<a href="//linkedin.com/company/acme">LinkedIn</a>',
      PAGE_URL,
    );
    expect(extracted.socialProfiles).toEqual([
      "https://linkedin.com/company/acme",
    ]);
  });

  it("detects the pricing page and internal links", () => {
    expect(result.hasPricingPage).toBe(true);
    expect(result.pricingPageUrl).toBe(`${PAGE_URL}/pricing`);
    expect(result.internalLinks).toContain(`${PAGE_URL}/about`);
  });

  it("returns nulls for an empty page without fabricating", () => {
    const empty = analyzeProspect("<html><body></body></html>", PAGE_URL);
    expect(empty.companyName).toBeNull();
    expect(empty.jsonLdOrg).toBeNull();
    expect(empty.hasPricingPage).toBe(false);
  });
});

describe("parseEmployeeCount", () => {
  it("uses the lower bound of a range instead of joining its digits", () => {
    expect(parseEmployeeCount("51-200")).toBe(51);
  });

  it("supports grouped counts and rejects missing or invalid values", () => {
    expect(parseEmployeeCount("about 1,200 employees")).toBe(1200);
    expect(parseEmployeeCount(85)).toBe(85);
    expect(parseEmployeeCount("unknown")).toBeUndefined();
    expect(parseEmployeeCount(0)).toBeUndefined();
  });
});
