/**
 * Reading JSON-LD nodes out of a page.
 *
 * Pages carry structured data as one or more `application/ld+json` scripts,
 * each holding either a single node or an array of them, and any one of them
 * may be malformed. Both the organization and the people extractors need that
 * same scan, so it lives here rather than being written twice.
 */

import type * as cheerio from "cheerio";

/**
 * Yield every well-formed JSON-LD node on the page, in document order.
 * A script whose JSON does not parse is skipped rather than failing the page.
 * @param $ loaded Cheerio document
 * @returns the parsed nodes, each still of unknown shape
 */
export function jsonLdNodes($: cheerio.CheerioAPI): unknown[] {
  const nodes: unknown[] = [];
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data: unknown = JSON.parse($(script).text() || "{}");
      nodes.push(...(Array.isArray(data) ? data : [data]));
    } catch {
      // Malformed JSON-LD blocks are skipped.
    }
  }
  return nodes;
}
