/**
 * HTML-to-text conversion for LLM consumption.
 * Strips scripts, styles, and boilerplate; collapses whitespace;
 * truncates to a bounded length so one page cannot blow the context.
 */

import * as cheerio from "cheerio";

const MAX_TEXT_CHARS = 12_000;

/**
 * Convert an HTML document to clean, whitespace-collapsed text. When a caller
 * shares an already-loaded document, this removes the boilerplate elements
 * from it, so it must be the last reader of that document.
 * @param html raw page HTML
 * @param $ the page already loaded with `loadPage`, when a caller shares it
 * @returns visible text content, truncated to a maximum length
 */
export function htmlToText(
  html: string,
  $: cheerio.CheerioAPI = cheerio.load(html),
): string {
  $("script, style, noscript, svg, iframe, nav, footer").remove();
  const text = $("body").text();
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, MAX_TEXT_CHARS);
}
