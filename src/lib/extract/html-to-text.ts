/**
 * HTML-to-text conversion for LLM consumption.
 * Strips scripts, styles, and boilerplate; collapses whitespace;
 * truncates to a bounded length so one page cannot blow the context.
 */

import * as cheerio from "cheerio";

const MAX_TEXT_CHARS = 12_000;

/**
 * Convert an HTML document to clean, whitespace-collapsed text.
 * @param html raw page HTML
 * @returns visible text content, truncated to a maximum length
 */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe, nav, footer").remove();
  const text = $("body").text();
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, MAX_TEXT_CHARS);
}
