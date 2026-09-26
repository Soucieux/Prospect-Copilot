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
  hasPricingPage: boolean;
  pricingPageUrl: string | null;
  enterpriseTierListed: boolean;
  jsonLdOrg: {
    name?: string;
    foundingDate?: string;
    numberOfEmployees?: number | string;
    address?: string;
  } | null;
  /** The JSON-LD headcount as one conservative number, when it states one. */
  employeeCount: number | undefined;
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
  // Anchored to a label boundary: a bare "x.com/" also ends dropbox.com/,
  // wix.com/ and every other domain whose name finishes in x.
  { platform: "twitter", pattern: /(^|[/.])(twitter|x)\.com\//i },
  { platform: "facebook", pattern: /facebook\.com\//i },
  { platform: "github", pattern: /github\.com\//i },
  { platform: "youtube", pattern: /youtube\.com\//i },
];

/**
 * Path words that identify each subpage worth fetching after the homepage.
 * The pricing words also decide whether the homepage links to pricing at all,
 * so the flag and the fetch can never disagree about what pricing looks like.
 */
const SUBPAGE_KEYWORDS = {
  about: ["about", "company", "about-us"],
  team: ["team", "leadership", "people"],
  pricing: ["pricing", "plans", "packages"],
  careers: ["careers", "jobs", "join-us", "hiring"],
  contact: ["contact", "get-in-touch", "demo"],
  blog: ["blog", "resources", "insights", "news"],
};

// The terminator accepts ? and # as well as / and end-of-string: marketing
// sites routinely hang tracking parameters off their own nav links, and
// requiring a bare path silently dropped those pages from discovery.
export const SUBPAGE_PATTERNS: { name: string; pattern: RegExp }[] =
  Object.entries(SUBPAGE_KEYWORDS).map(([name, words]) => ({
    name,
    pattern: new RegExp(`\\/(${words.join("|")})(\\/|\\?|#|$)`, "i"),
  }));

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PRICING_HREF_PATTERN = new RegExp(SUBPAGE_KEYWORDS.pricing.join("|"), "i");
const ENTERPRISE_PATTERN = /enterprise|custom pricing|contact (us|sales) for/i;

const MAX_SOCIAL_PROFILES = 8;
const MAX_EMAILS = 20;
// These links are only ever scanned for the six subpage patterns, never sent
// to a model, so the budget is generous: a large navigation can otherwise use
// the whole allowance before a footer "about" or "careers" link is reached.
const MAX_INTERNAL_LINKS = 250;

/**
 * Parse a page once for every extractor that reads it. Pass the result to
 * `analyzeProspect`, then `findContacts`, then `htmlToText`, in that order:
 * the later two remove markup they do not read, so an earlier reader must
 * already have seen the whole document.
 * @param html raw page HTML
 * @returns the loaded document
 */
export function loadPage(html: string): cheerio.CheerioAPI {
  return cheerio.load(html);
}

/**
 * Run all extractions over a fetched homepage.
 * @param html raw homepage HTML
 * @param pageUrl final URL after redirects (for resolving links)
 * @param $ the page already loaded with `loadPage`, when a caller shares it
 * @returns the structured extraction result
 */
export function analyzeProspect(
  html: string,
  pageUrl: string,
  $: cheerio.CheerioAPI = loadPage(html),
): ProspectExtraction {
  // Collected once: the three collectors below each used to walk every anchor
  // on the page independently.
  const anchors = $("a[href]")
    .toArray()
    .map((anchor) => $(anchor).attr("href") ?? "");
  const jsonLdOrg = extractJsonLdOrg($);
  const pricingPageUrl = findPricingLink(anchors, pageUrl);
  return {
    // Blank values fall through: an empty name would otherwise title the
    // report, and the URL is the honest fallback when no name is published.
    companyName:
      jsonLdOrg?.name?.trim() ||
      $('meta[property="og:site_name"]').attr("content")?.trim() ||
      null,
    title: $("title").text().trim() || null,
    description:
      $('meta[name="description"]').attr("content")?.trim() ?? null,
    techStack: detectTechStack(html),
    socialProfiles: extractSocials(anchors),
    emails: uniqueMatches(html, EMAIL_PATTERN)
      .filter((email) => !/\.(png|jpe?g|gif|svg|webp)$/i.test(email))
      .slice(0, MAX_EMAILS),
    hasPricingPage: pricingPageUrl !== null,
    pricingPageUrl,
    enterpriseTierListed: ENTERPRISE_PATTERN.test(html),
    jsonLdOrg,
    employeeCount: parseEmployeeCount(jsonLdOrg?.numberOfEmployees),
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
    // The first links in document order are kept, so once the budget is full
    // no later anchor can change the result.
    if (found.size >= MAX_INTERNAL_LINKS) break;
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      continue;
    }
    try {
      const resolved = new URL(href, pageUrl);
      if (resolved.origin === origin) {
        resolved.hash = "";
        found.add(resolved.toString());
      }
    } catch {
      // Unparseable hrefs are skipped.
    }
  }
  return [...found];
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
