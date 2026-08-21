/**
 * Team/leadership page parsing - TS port of scripts/contact_finder.py.
 * Extracts people from JSON-LD Person nodes and HTML card/list patterns,
 * then tags seniority and predicted buying role.
 */

import * as cheerio from "cheerio";

export type Seniority = "C-Suite" | "VP" | "Director" | "Manager" | "IC";
export type BuyingRole =
  | "Economic Buyer"
  | "Champion"
  | "Technical Evaluator"
  | "End User"
  | "Unknown";

export interface ContactCandidate {
  name: string;
  title: string | null;
  seniority: Seniority;
  buyingRole: BuyingRole;
  linkedin: string | null;
  source: "json-ld" | "html";
}

const TITLE_PATTERN =
  /\b(CEO|CTO|CFO|COO|CIO|CRO|CMO|Chief\s+\w+|VP\b|Vice President|Director|Head of|Manager|Founder|Co-?founder|President|Chairman)\b/i;

const LINKEDIN_PERSON_PATTERN = /linkedin\.com\/in\//i;

const C_SUITE_PATTERN = /\b(CEO|CTO|CFO|COO|CIO|CRO|CMO|Chief|Founder|Co-?founder|President|Chairman|Owner)\b/i;
const VP_PATTERN = /\b(VP\b|Vice President|Head of)\b/i;
const DIRECTOR_PATTERN = /\bDirector\b/i;
const MANAGER_PATTERN = /\bManager\b/i;

/**
 * Extract contact candidates from a team/leadership page. A person is kept
 * even when no title could be parsed nearby - the report renders that as
 * "Not publicly available" rather than discarding a confirmed real name.
 * @param html raw page HTML
 * @returns deduplicated people, JSON-LD sources first
 */
export function findContacts(html: string): ContactCandidate[] {
  const $ = cheerio.load(html);
  const byName = new Map<string, ContactCandidate>();
  for (const person of extractJsonLdPeople($)) {
    byName.set(normalizeName(person.name), person);
  }
  for (const person of extractHtmlPeople($)) {
    const key = normalizeName(person.name);
    if (!byName.has(key)) byName.set(key, person);
  }
  return [...byName.values()];
}

/**
 * Parse JSON-LD Person nodes into candidates.
 * @param $ loaded Cheerio document
 * @returns people found in structured data
 */
function extractJsonLdPeople(
  $: cheerio.CheerioAPI,
): ContactCandidate[] {
  const people: ContactCandidate[] = [];
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data: unknown = JSON.parse($(script).text() || "{}");
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        const typed = node as { "@type"?: unknown; name?: unknown; jobTitle?: unknown; sameAs?: unknown };
        if (typed?.["@type"] !== "Person" || typeof typed.name !== "string") {
          continue;
        }
        const title = typeof typed.jobTitle === "string" ? typed.jobTitle : null;
        const sameAs = Array.isArray(typed.sameAs)
          ? typed.sameAs.find(
              (link): link is string =>
                typeof link === "string" && LINKEDIN_PERSON_PATTERN.test(link),
            )
          : undefined;
        people.push({
          name: typed.name.trim(),
          title,
          seniority: classifySeniority(title),
          buyingRole: classifyBuyingRole(title),
          linkedin: sameAs ?? null,
          source: "json-ld",
        });
      }
    } catch {
      // Malformed JSON-LD blocks are skipped.
    }
  }
  return people;
}

/**
 * Heuristic HTML extraction: anchors containing a person name followed
 * by a title-looking string nearby.
 * @param $ loaded Cheerio document
 * @returns people found in markup
 */
function extractHtmlPeople($: cheerio.CheerioAPI): ContactCandidate[] {
  const people: ContactCandidate[] = [];
  const seen = new Set<string>();
  for (const anchor of $("a[href]").toArray()) {
    const href = $(anchor).attr("href") ?? "";
    if (!LINKEDIN_PERSON_PATTERN.test(href)) continue;
    const container = $(anchor).closest("div, li, article").first();
    const scope = container.length > 0 ? container : $(anchor).parent();
    const text = scope.text().replace(/\s+/g, " ").trim();
    const nameAnchorText = $(anchor).text().replace(/\s+/g, " ").trim();
    const titleMatch = text.match(TITLE_PATTERN);
    const name = looksLikeName(nameAnchorText) ? nameAnchorText : "";
    if (!name || seen.has(normalizeName(name))) continue;
    const title = titleMatch ? titleMatch[0] : null;
    seen.add(normalizeName(name));
    people.push({
      name,
      title,
      seniority: classifySeniority(title),
      buyingRole: classifyBuyingRole(title),
      linkedin: href.startsWith("http") ? href : `https://${href}`,
      source: "html",
    });
  }
  return people;
}

/**
 * Check whether a string is plausibly a person's name.
 * @param value candidate text
 * @returns true when it looks like "First Last" (2-4 capitalized words)
 */
function looksLikeName(value: string): boolean {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((word) => /^[A-Z][a-zA-Z'’.-]+$/.test(word));
}

/**
 * Derive seniority from a job title.
 * @param title job title or null
 * @returns seniority band
 */
export function classifySeniority(title: string | null): Seniority {
  if (title === null) return "IC";
  if (C_SUITE_PATTERN.test(title)) return "C-Suite";
  if (VP_PATTERN.test(title)) return "VP";
  if (DIRECTOR_PATTERN.test(title)) return "Director";
  if (MANAGER_PATTERN.test(title)) return "Manager";
  return "IC";
}

/**
 * Predict the buying role from a job title.
 * @param title job title or null
 * @returns predicted buying role
 */
export function classifyBuyingRole(title: string | null): BuyingRole {
  if (title === null) return "Unknown";
  if (
    /\b(CEO|CFO|COO|President|Owner|Founder|Chief\s+(Executive|Financial|Operating)\s+Officer)\b/i.test(
      title,
    )
  ) {
    return "Economic Buyer";
  }
  if (
    /\b(CTO|CIO|VP Engineering|VP Technology|Architect|Chief\s+(Technology|Information)\s+Officer)\b/i.test(
      title,
    )
  ) {
    return "Technical Evaluator";
  }
  if (/\b(CRO|VP Sales|VP Marketing|CMO|Chief\s+(Revenue|Marketing)\s+Officer|Head of (Sales|Marketing|Growth))\b/i.test(title)) {
    return "Champion";
  }
  return "End User";
}

/**
 * Lowercase a name for deduplication.
 * @param name the display name
 * @returns normalized key
 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}
