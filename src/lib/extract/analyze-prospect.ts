/**
 * Structured extraction from a company homepage - TS port of
 * scripts/analyze_prospect.py. Detects tech stack, social profiles,
 * contact patterns, pricing signals, and JSON-LD organization data.
 */

import * as cheerio from "cheerio";

export interface ProspectExtraction {
  companyName: string | null;
  title: string | null;
  description: string | null;
  techStack: string[];
  socialProfiles: string[];
  emails: string[];
  phones: string[];
  hasPricingPage: boolean;
  pricingPageUrl: string | null;
  enterpriseTierListed: boolean;
  jsonLdOrg: {
    name?: string;
    foundingDate?: string;
    numberOfEmployees?: number | string;
    address?: string;
  } | null;
  internalLinks: string[];
}

/** Regex fingerprints for common technologies (port of TECH_SIGNATURES). */
const TECH_SIGNATURES: { tech: string; pattern: RegExp }[] = [
  { tech: "WordPress", pattern: /wp-content|wp-includes/i },
  { tech: "Shopify", pattern: /cdn\.shopify\.com|shopify\.theme/i },
  { tech: "HubSpot", pattern: /hs-scripts\.com|js\.hsforms\.net/i },
  { tech: "Segment", pattern: /cdn\.segment\.com/i },
  { tech: "Stripe", pattern: /js\.stripe\.com/i },
  { tech: "Intercom", pattern: /intercom\.(io|com)\/(messenger|snippet)/i },
  { tech: "Zendesk", pattern: /zendesk|zdassets/i },
  { tech: "Salesforce", pattern: /salesforce|pardot/i },
  { tech: "Marketo", pattern: /munchkin\.marketo\.net/i },
  { tech: "Google Analytics", pattern: /gtag\/js|google-analytics\.com|googletagmanager/i },
  { tech: "Next.js", pattern: /__NEXT_DATA__/i },
  { tech: "React", pattern: /react(-dom)?[.@]|data-reactroot/i },
  { tech: "Vue", pattern: /vue(\.runtime)?\.js|data-v-app/i },
  { tech: "Wix", pattern: /static\.wixstatic|wix\.com/i },
  { tech: "Squarespace", pattern: /squarespace|static1\.sqspcdn/i },
  { tech: "Webflow", pattern: /webflow\.(js|cdn)/i },
];

const SOCIAL_PATTERNS: { platform: string; pattern: RegExp }[] = [
  { platform: "linkedin", pattern: /linkedin\.com\/(company|in)\//i },
  { platform: "twitter", pattern: /(twitter|x)\.com\//i },
  { platform: "facebook", pattern: /facebook\.com\//i },
  { platform: "github", pattern: /github\.com\//i },
  { platform: "youtube", pattern: /youtube\.com\//i },
];

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_PATTERN = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const PRICING_HREF_PATTERN = /pricing|plans|packages/i;
const ENTERPRISE_PATTERN = /enterprise|custom pricing|contact (us|sales) for/i;

/**
 * Run all extractions over a fetched homepage.
 * @param html raw homepage HTML
 * @param pageUrl final URL after redirects (for resolving links)
 * @returns the structured extraction result
 */
export function analyzeProspect(
  html: string,
  pageUrl: string,
): ProspectExtraction {
  const $ = cheerio.load(html);
  const jsonLdOrg = extractJsonLdOrg($);
  return {
    companyName:
      jsonLdOrg?.name ??
      $('meta[property="og:site_name"]').attr("content") ??
        null,
    title: $("title").text().trim() || null,
    description:
      $('meta[name="description"]').attr("content")?.trim() ?? null,
    techStack: detectTechStack(html),
    socialProfiles: extractSocials($),
    emails: uniqueMatches(html, EMAIL_PATTERN).filter(
      (email) => !/\.(png|jpe?g|gif|svg|webp)$/i.test(email),
    ),
    phones: uniqueMatches(html, PHONE_PATTERN).slice(0, 5),
    hasPricingPage: findPricingLink($, pageUrl) !== null,
    pricingPageUrl: findPricingLink($, pageUrl),
    enterpriseTierListed: ENTERPRISE_PATTERN.test(html),
    jsonLdOrg,
    internalLinks: extractInternalLinks($, pageUrl),
  };
}

/**
 * Detect which known technologies appear in the page source.
 * @param html raw HTML
 * @returns detected technology names
 */
export function detectTechStack(html: string): string[] {
  return TECH_SIGNATURES.filter(({ pattern }) => pattern.test(html)).map(
    ({ tech }) => tech,
  );
}

/**
 * Extract the first JSON-LD Organization node.
 * @param $ loaded Cheerio document
 * @returns organization fields found, or null
 */
function extractJsonLdOrg(
  $: cheerio.CheerioAPI,
): ProspectExtraction["jsonLdOrg"] {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const script of scripts) {
    try {
      const data: unknown = JSON.parse($(script).text() || "{}");
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        const typed = node as { "@type"?: unknown };
        const type = typed?.["@type"];
        const types = Array.isArray(type) ? type : [type];
        if (
          types.some((t) => t === "Organization" || t === "Corporation")
        ) {
          const org = node as {
            name?: unknown;
            foundingDate?: unknown;
            numberOfEmployees?: unknown;
            address?: unknown;
          };
          return {
            name: typeof org.name === "string" ? org.name : undefined,
            foundingDate:
              typeof org.foundingDate === "string"
                ? org.foundingDate
                : undefined,
            numberOfEmployees:
              typeof org.numberOfEmployees === "number" ||
              typeof org.numberOfEmployees === "string"
                ? org.numberOfEmployees
                : undefined,
            address:
              typeof org.address === "string" ? org.address : undefined,
          };
        }
      }
    } catch {
      // Malformed JSON-LD blocks are skipped.
    }
  }
  return null;
}

/**
 * Collect absolute social profile URLs from anchor hrefs.
 * @param $ loaded Cheerio document
 * @returns unique social URLs (max 8)
 */
function extractSocials($: cheerio.CheerioAPI): string[] {
  const found = new Set<string>();
  for (const anchor of $("a[href]").toArray()) {
    const href = $(anchor).attr("href") ?? "";
    if (SOCIAL_PATTERNS.some(({ pattern }) => pattern.test(href))) {
      found.add(href.startsWith("http") ? href : `https://${href}`);
    }
  }
  return [...found].slice(0, 8);
}

/**
 * Find a pricing-style link among anchors.
 * @param $ loaded Cheerio document
 * @param pageUrl base URL for resolution
 * @returns absolute pricing URL, or null
 */
function findPricingLink(
  $: cheerio.CheerioAPI,
  pageUrl: string,
): string | null {
  for (const anchor of $("a[href]").toArray()) {
    const href = $(anchor).attr("href") ?? "";
    if (PRICING_HREF_PATTERN.test(href)) {
      try {
        return new URL(href, pageUrl).toString();
      } catch {
        return href;
      }
    }
  }
  return null;
}

/**
 * Collect same-origin links for discovery of subpages.
 * @param $ loaded Cheerio document
 * @param pageUrl base URL
 * @returns unique absolute internal links (max 40)
 */
function extractInternalLinks(
  $: cheerio.CheerioAPI,
  pageUrl: string,
): string[] {
  const origin = new URL(pageUrl).origin;
  const found = new Set<string>();
  for (const anchor of $("a[href]").toArray()) {
    const href = $(anchor).attr("href") ?? "";
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      continue;
    }
    try {
      const resolved = new URL(href, pageUrl);
      if (resolved.origin === origin) {
        found.add(resolved.toString().split("#")[0]);
      }
    } catch {
      // Unparseable hrefs are skipped.
    }
  }
  return [...found].slice(0, 40);
}

/**
 * Run a global regex over a string and deduplicate matches.
 * @param haystack the text to search
 * @param pattern global regex
 * @returns unique matches
 */
function uniqueMatches(haystack: string, pattern: RegExp): string[] {
  const matches = haystack.match(pattern) ?? [];
  return [...new Set(matches)];
}
