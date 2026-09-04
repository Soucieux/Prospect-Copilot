/**
 * One rule for turning a scraped href into an absolute URL.
 *
 * Scraped markup uses three forms, and the protocol-relative one is the trap:
 * prefixing `https://` to `//host/path` yields `https:////host/path`. Both the
 * social-profile and contact extractors need this, so it lives in one place.
 */

/**
 * Make a scraped href absolute.
 * @param href the raw href attribute
 * @returns an absolute https URL
 */
export function absoluteUrl(href: string): string {
  if (href.startsWith("//")) return `https:${href}`;
  return href.startsWith("http") ? href : `https://${href}`;
}
