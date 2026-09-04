/**
 * Structured extraction from a company homepage - TS port of
 * scripts/analyze_prospect.py. Detects tech stack, social profiles,
 * contact patterns, pricing signals, and JSON-LD organization data.
 */

import * as cheerio from "cheerio";
import { absoluteUrl } from "@/lib/extract/absolute-url";
import { jsonLdNodes } from "@/lib/extract/json-ld";

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

const MAX_SOCIAL_PROFILES = 8;
const MAX_PHONES = 5;
const MAX_EMAILS = 20;
// These links are only ever scanned for the six subpage patterns, never sent
// to a model, so the budget is generous: a large navigation can otherwise use
// the whole allowance before a footer "about" or "careers" link is reached.
const MAX_INTERNAL_LINKS = 250;

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
  // Collected once: the three collectors below each used to walk every anchor
  // on the page independently.
  const anchors = $("a[href]")
    .toArray()
    .map((anchor) => $(anchor).attr("href") ?? "");
  const jsonLdOrg = extractJsonLdOrg($);
  const pricingPageUrl = findPricingLink(anchors, pageUrl);
  return {
    companyName:
      jsonLdOrg?.name ??
      $('meta[property="og:site_name"]').attr("content") ??
        null,
    title: $("title").text().trim() || null,
    description:
      $('meta[name="description"]').attr("content")?.trim() ?? null,
    techStack: detectTechStack(html),
    socialProfiles: extractSocials(anchors),
    emails: uniqueMatches(html, EMAIL_PATTERN)
      .filter((email) => !/\.(png|jpe?g|gif|svg|webp)$/i.test(email))
      .slice(0, MAX_EMAILS),
    phones: uniqueMatches(html, PHONE_PATTERN).slice(0, MAX_PHONES),
    hasPricingPage: pricingPageUrl !== null,
    pricingPageUrl,
    enterpriseTierListed: ENTERPRISE_PATTERN.test(html),
    jsonLdOrg,
    internalLinks: extractInternalLinks(anchors, pageUrl),
  };
}

/**
 * Convert a JSON-LD employee count or range into one conservative count.
 * Range strings use their lower bound so a value such as "51-200" cannot be
 * inflated into 51,200 by removing punctuation.
 * @param value JSON-LD number or human-readable count/range
 * @returns a positive safe integer, or undefined when no count is present
 */
export function parseEmployeeCount(
  value: number | string | undefined,
): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const firstNumber = value.replaceAll(",", "").match(/\d+/)?.[0];
  if (!firstNumber) return undefined;
  const parsed = Number.parseInt(firstNumber, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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
  for (const node of jsonLdNodes($)) {
    const typed = node as { "@type"?: unknown };
    const type = typed?.["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => t === "Organization" || t === "Corporation")) {
      continue;
    }
    const org = node as {
      name?: unknown;
      foundingDate?: unknown;
      numberOfEmployees?: unknown;
      address?: unknown;
    };
    return {
      name: typeof org.name === "string" ? org.name : undefined,
      foundingDate:
        typeof org.foundingDate === "string" ? org.foundingDate : undefined,
      numberOfEmployees:
        typeof org.numberOfEmployees === "number" ||
        typeof org.numberOfEmployees === "string"
          ? org.numberOfEmployees
          : undefined,
      address: typeof org.address === "string" ? org.address : undefined,
    };
  }
  return null;
}

/**
 * Collect absolute social profile URLs from anchor hrefs.
 * @param hrefs every href on the page, in document order
 * @returns unique social URLs (max 8)
 */
function extractSocials(hrefs: string[]): string[] {
  const found = new Set<string>();
  for (const href of hrefs) {
    if (SOCIAL_PATTERNS.some(({ pattern }) => pattern.test(href))) {
      found.add(absoluteUrl(href));
    }
  }
  return [...found].slice(0, MAX_SOCIAL_PROFILES);
}

/**
 * Find a pricing-style link among anchors.
 * @param hrefs every href on the page, in document order
 * @param pageUrl base URL for resolution
 * @returns absolute pricing URL, or null
 */
function findPricingLink(hrefs: string[], pageUrl: string): string | null {
  for (const href of hrefs) {
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
 * @param hrefs every href on the page, in document order
 * @param pageUrl base URL
 * @returns unique absolute internal links, bounded by MAX_INTERNAL_LINKS
 */
function extractInternalLinks(hrefs: string[], pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin;
  const found = new Set<string>();
  for (const href of hrefs) {
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
  return [...found].slice(0, MAX_INTERNAL_LINKS);
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
