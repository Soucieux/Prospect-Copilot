import { describe, expect, it } from "vitest";
import {
  SUBPAGE_PATTERNS,
  analyzeProspect,
  detectTechStack,
  loadPage,
  parseEmployeeCount,
} from "./analyze-prospect";
import { findContacts } from "./contact-finder";
import { htmlToText } from "./html-to-text";

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

describe("SUBPAGE_PATTERNS", () => {
  /**
   * Find the subpage name a candidate link would be discovered as.
   * @param url absolute same-origin candidate link
   * @returns the matching subpage name, or null when none matches
   */
  const matchName = (url: string): string | null =>
    SUBPAGE_PATTERNS.find((entry) => entry.pattern.test(url))?.name ?? null;

  it("matches bare paths and trailing slashes", () => {
    expect(matchName("https://acme.example.com/pricing")).toBe("pricing");
    expect(matchName("https://acme.example.com/about/")).toBe("about");
  });

  it("still matches when a tracking query string follows the path", () => {
    // buffer.com hangs ?cta=... off its own nav links; requiring a bare path
    // dropped its pricing and about pages from discovery entirely.
    expect(
      matchName("https://buffer.com/pricing?cta=bufferSite-globalNav-pricing"),
    ).toBe("pricing");
    expect(matchName("https://acme.example.com/careers?utm_source=nav")).toBe(
      "careers",
    );
  });

  it("still matches when a fragment follows the path", () => {
    expect(matchName("https://acme.example.com/contact#form")).toBe("contact");
  });

  it("does not match an unrelated path that merely contains the word", () => {
    expect(matchName("https://acme.example.com/pricing-guide-for-teams")).toBeNull();
  });

  it("flags a pricing link with the same words that pick the pricing page", () => {
    const html =
      '<html><body><a href="/plans?ref=nav">Plans</a></body></html>';
    const extraction = analyzeProspect(html, "https://acme.example.com");
    expect(extraction.hasPricingPage).toBe(true);
    expect(matchName(extraction.internalLinks[0] ?? "")).toBe("pricing");
  });
});

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

  it("does not mistake a domain ending in x for an X profile", () => {
    const extracted = analyzeProspect(
      '<a href="https://www.dropbox.com/acme">Files</a>' +
        '<a href="https://www.wix.com/">Built with Wix</a>' +
        '<a href="https://x.com/acme">X</a>' +
        '<a href="//twitter.com/acme">Twitter</a>',
      PAGE_URL,
    );
    expect(extracted.socialProfiles).toEqual([
      "https://x.com/acme",
      "https://twitter.com/acme",
    ]);
  });

  it("treats a blank site name as no name rather than an empty one", () => {
    const extracted = analyzeProspect(
      '<html><head><meta property="og:site_name" content="  "></head></html>',
      PAGE_URL,
    );
    expect(extracted.companyName).toBeNull();
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

describe("loadPage", () => {
  const html = `<html><head>
<script type="application/ld+json">{"@type":"Organization","name":"Acme Corp","numberOfEmployees":"51-200"}</script>
<script type="application/ld+json">{"@type":"Person","name":"Jane Doe","jobTitle":"Chief Executive Officer"}</script>
</head><body><nav>Home</nav><a href="/pricing">Pricing</a><p>Payroll for teams.</p></body></html>`;

  it("gives every extractor the same answers as a fresh parse, in the documented order", () => {
    const $ = loadPage(html);
    const extraction = analyzeProspect(html, PAGE_URL, $);
    const contacts = findContacts(html, extraction.companyName, $);
    const text = htmlToText(html, $);

    expect(extraction).toEqual(analyzeProspect(html, PAGE_URL));
    expect(contacts).toEqual(findContacts(html, "Acme Corp"));
    expect(text).toBe(htmlToText(html));
    expect(extraction.employeeCount).toBe(51);
    expect(contacts.map((person) => person.name)).toEqual(["Jane Doe"]);
    expect(text).toBe("PricingPayroll for teams.");
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
