/**
 * Team/leadership page parsing - TS port of scripts/contact_finder.py.
 * Extracts people from JSON-LD Person nodes and HTML card/list patterns,
 * then tags seniority and predicted buying role.
 */

import * as cheerio from "cheerio";
import { absoluteUrl } from "@/lib/extract/absolute-url";
import { jsonLdNodes } from "@/lib/extract/json-ld";

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
  /\b(CEO|CTO|CFO|COO|CIO|CRO|CMO|CPO|CISO|CHRO|Chief\s+\w+|VP\b|Vice President|Director|Head of|Manager|Founder|Co-?founder|President|Chairman)\b/i;

const LINKEDIN_PERSON_PATTERN = /linkedin\.com\/in\//i;

/** Longest a neighbouring text run can be and still read as a job title. */
const MAX_TITLE_LENGTH = 80;

/** How far above a name the search for its LinkedIn profile may walk. */
const LINKEDIN_LOOKUP_DEPTH = 3;

/** Elements whose text is markup or data rather than page copy. */
const NON_COPY_SELECTOR = "script, style, noscript, template, svg";

/**
 * Roles that already name a whole company, so an "of X" or "at X" after one
 * names an employer rather than a scope. "Head of" and "Director of" take a
 * scope instead, which is why they are deliberately absent here.
 */
const STANDALONE_ROLE_PATTERN =
  /\b(CEO|CTO|CFO|COO|CIO|CRO|CMO|CPO|Founder|Co-?founder|President|Partner|Chairman|Owner)\b/i;

/** An employer named after "of"/"at", as in "Founder of AngelList". */
const LINKED_EMPLOYER_PATTERN = /\b(?:of|at)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)?)/;

/** An employer trailing a comma, as in "CEO, Figma". */
const TRAILING_EMPLOYER_PATTERN = /,\s*([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)?)\s*$/;

/** Legal suffixes and punctuation ignored when comparing two company names. */
const COMPANY_NOISE_PATTERN = /\b(inc|llc|ltd|limited|corp|corporation|co|plc|gmbh|sa|ab|oy)\b|[^a-z0-9 ]/g;

/** Splits "Jane Doe, Chief Executive Officer" into its two halves. */
const INLINE_TITLE_PATTERN = /^(.+?)\s*(?:,|\||\u00b7|\u2014|\u2013|\s-\s)\s*(.+)$/;

const C_SUITE_PATTERN = /\b(CEO|CTO|CFO|COO|CIO|CRO|CMO|CPO|CISO|CHRO|Chief|Founder|Co-?founder|President|Chairman|Owner)\b/i;
const VP_PATTERN = /\b(VP\b|Vice President|Head of)\b/i;
const DIRECTOR_PATTERN = /\bDirector\b/i;
const MANAGER_PATTERN = /\bManager\b/i;

/** Titles that hold the budget and can approve a purchase outright. */
const ECONOMIC_BUYER_PATTERN =
  /\b(CEO|CFO|COO|President|Owner|Founder|Chief\s+(Executive|Financial|Operating)\s+Officer)\b/i;

/** Titles that judge whether a solution is technically workable. */
const TECHNICAL_EVALUATOR_PATTERN =
  /\b(CTO|CIO|VP\s+(of\s+)?(Engineering|Technology)|Architect|Chief\s+(Technology|Information)\s+Officer)\b/i;

/** Revenue-side titles that will carry a deal internally. */
const CHAMPION_PATTERN =
  /\b(CRO|CMO|VP\s+(of\s+)?(Sales|Marketing|Revenue)|Chief\s+(Revenue|Marketing)\s+Officer|Head of (Sales|Marketing|Growth))\b/i;

/**
 * Extract contact candidates from a team/leadership page. A person is kept
 * even when no title could be parsed nearby - the report renders that as
 * "Not publicly available" rather than discarding a confirmed real name.
 * About pages routinely list investors and advisors beside staff, so anyone
 * whose title names a different employer is dropped: they are not contacts
 * at this prospect.
 * @param html raw page HTML
 * @param companyName the prospect's own name, when discovery resolved one
 * @returns deduplicated people, JSON-LD sources first
 */
export function findContacts(
  html: string,
  companyName: string | null = null,
): ContactCandidate[] {
  const $ = cheerio.load(html);
  const byName = new Map<string, ContactCandidate>();
  for (const person of extractJsonLdPeople($)) {
    byName.set(normalizeName(person.name), person);
  }
  for (const person of extractHtmlPeople($)) {
    const key = normalizeName(person.name);
    if (!byName.has(key)) byName.set(key, person);
  }
  return [...byName.values()].filter(
    (person) => !worksElsewhere(person.title, companyName),
  );
}

/**
 * Decide whether a title places someone at a company other than the prospect.
 * @param title the parsed job title, when there was one
 * @param companyName the prospect's own name, when discovery resolved one
 * @returns true when the title names a different employer
 */
function worksElsewhere(
  title: string | null,
  companyName: string | null,
): boolean {
  if (title === null) return false;
  const employer = employerNamedIn(title);
  if (employer === null) return false;
  if (companyName === null) return true;
  return !isSameCompany(employer, companyName);
}

/**
 * Read the employer a title names, if it names one at all.
 * @param title the parsed job title
 * @returns the employer name, or null when the title names only a role
 */
function employerNamedIn(title: string): string | null {
  const linked = title.match(LINKED_EMPLOYER_PATTERN);
  if (
    linked?.index !== undefined &&
    STANDALONE_ROLE_PATTERN.test(title.slice(0, linked.index))
  ) {
    return linked[1] ?? null;
  }
  const trailingEmployer = title.match(TRAILING_EMPLOYER_PATTERN)?.[1];
  if (trailingEmployer && !TITLE_PATTERN.test(trailingEmployer)) {
    return trailingEmployer;
  }
  return null;
}

/**
 * Compare two company names ignoring legal suffixes and punctuation.
 * @param employer the employer named in a title
 * @param companyName the prospect's own name
 * @returns true when both plausibly name the same company
 */
function isSameCompany(employer: string, companyName: string): boolean {
  const normalize = (value: string): string =>
    value.toLowerCase().replace(COMPANY_NOISE_PATTERN, " ").replace(/\s+/g, " ").trim();
  const left = normalize(employer);
  const right = normalize(companyName);
  if (left === "" || right === "") return false;
  return left.includes(right) || right.includes(left);
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
  for (const node of jsonLdNodes($)) {
    const typed = node as {
      "@type"?: unknown;
      name?: unknown;
      jobTitle?: unknown;
      sameAs?: unknown;
    };
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
  return people;
}

/** A Cheerio selection wrapping page elements. */
type ElementSelection = ReturnType<
  ReturnType<cheerio.CheerioAPI["root"]>["children"]
>;

/** One element's own text, paired with the element that holds it. */
interface TextBlock {
  text: string;
  element: ElementSelection;
}

/**
 * Collect each element's own text in document order. Text is read per element
 * rather than for the whole subtree so a name is never welded to the title
 * sitting beside it. Non-copy elements are dropped first, so this must run
 * after JSON-LD extraction has already read the script tags.
 * @param $ loaded Cheerio document
 * @returns non-empty text blocks with the element holding each one
 */
function collectTextBlocks($: cheerio.CheerioAPI): TextBlock[] {
  $(NON_COPY_SELECTOR).remove();
  const blocks: TextBlock[] = [];
  for (const node of $("body *").toArray()) {
    const element = $(node);
    const own = element.clone().children().remove().end().text();
    const text = own.replace(/\s+/g, " ").trim();
    if (text) blocks.push({ text, element });
  }
  return blocks;
}

/**
 * Heuristic HTML extraction. A name is kept when the page either shows a job
 * title beside it or links it to a LinkedIn profile; either one is evidence of
 * a real person, whereas a bare pair of capitalized words is usually a link.
 * @param $ loaded Cheerio document
 * @returns people found in markup
 */
function extractHtmlPeople($: cheerio.CheerioAPI): ContactCandidate[] {
  const people: ContactCandidate[] = [];
  const seen = new Set<string>();
  const blocks = collectTextBlocks($);
  for (const [index, block] of blocks.entries()) {
    const inline = splitInlineTitle(block.text);
    const name = inline?.name ?? (looksLikeName(block.text) ? block.text : null);
    if (name === null || seen.has(normalizeName(name))) continue;
    const linkedin = findLinkedin($, block.element);
    const title = inline?.title ?? neighbourTitle(blocks[index + 1]);
    if (title === null && linkedin === null) continue;
    seen.add(normalizeName(name));
    people.push({
      name,
      title,
      seniority: classifySeniority(title),
      buyingRole: classifyBuyingRole(title),
      linkedin,
      source: "html",
    });
  }
  return people;
}

/**
 * Split a single line that carries both a name and a job title.
 * @param text one block of page text
 * @returns the name/title pair, or null when the line is not one
 */
function splitInlineTitle(
  text: string,
): { name: string; title: string } | null {
  const match = text.match(INLINE_TITLE_PATTERN);
  if (match === null) return null;
  const name = match[1]?.trim() ?? "";
  const title = match[2]?.trim() ?? "";
  if (!looksLikeName(name)) return null;
  if (title.length > MAX_TITLE_LENGTH || !TITLE_PATTERN.test(title)) return null;
  return { name, title };
}

/**
 * Read the block following a name as that person's job title. Only the very
 * next block is considered, so one person never inherits another's title.
 * @param block the block after the name, when there is one
 * @returns the title text, or null when that block is not a title
 */
function neighbourTitle(block: TextBlock | undefined): string | null {
  if (block === undefined || block.text.length > MAX_TITLE_LENGTH) return null;
  return TITLE_PATTERN.test(block.text) ? block.text : null;
}

/**
 * Find the LinkedIn profile belonging to a name. Only an unambiguous match
 * counts: a container holding several profiles cannot say which one is whose.
 * @param $ loaded Cheerio document
 * @param element the element holding the name
 * @returns the profile URL, or null when no single profile is certain
 */
function findLinkedin(
  $: cheerio.CheerioAPI,
  element: ElementSelection,
): string | null {
  const own = element.closest("a[href]").attr("href");
  if (own !== undefined && LINKEDIN_PERSON_PATTERN.test(own)) {
    return absoluteUrl(own);
  }
  let scope = element;
  for (let depth = 0; depth < LINKEDIN_LOOKUP_DEPTH; depth++) {
    scope = scope.parent();
    if (scope.length === 0) return null;
    const hrefs = [
      ...new Set(
        scope
          .find("a[href]")
          .toArray()
          .map((anchor) => $(anchor).attr("href") ?? "")
          .filter((href) => LINKEDIN_PERSON_PATTERN.test(href)),
      ),
    ];
    const [onlyHref] = hrefs;
    if (hrefs.length === 1 && onlyHref) return absoluteUrl(onlyHref);
    if (hrefs.length > 1) return null;
  }
  return null;
}

/**
 * Check whether a string is plausibly a person's name rather than a job
 * title. Careers pages list titles in the same headings team pages use for
 * names, so a title-looking string is rejected outright.
 * @param value candidate text
 * @returns true when it looks like "First Last" (2-4 capitalized words)
 */
function looksLikeName(value: string): boolean {
  if (TITLE_PATTERN.test(value)) return false;
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
  if (ECONOMIC_BUYER_PATTERN.test(title)) return "Economic Buyer";
  if (TECHNICAL_EVALUATOR_PATTERN.test(title)) return "Technical Evaluator";
  if (CHAMPION_PATTERN.test(title)) return "Champion";
  return "End User";
}

/**
 * Build the deduplication key for a person's name, so the same person found
 * on two pages collapses to one contact. Exported because the orchestrator
 * dedupes across pages with the same key this file uses within one page.
 * @param name the display name
 * @returns the name lowercased, with runs of whitespace collapsed and trimmed
 */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}
