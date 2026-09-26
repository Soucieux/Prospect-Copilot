/**
 * One rule for turning a scraped href into an absolute URL.
 *
 * Scraped markup uses three forms, and the protocol-relative one is the trap:
 * prefixing `https://` to `//host/path` yields `https:////host/path`. Both the
 * social-profile and contact extractors need this, so it lives in one place.
 */

/** An explicit web scheme, in any letter case, as hrefs in the wild spell it. */
const WEB_SCHEME_PATTERN = /^https?:\/\//i;

/**
 * Make a scraped href absolute. These links are rendered and stored, never
 * fetched, so nothing downstream re-checks them: a bare host is given https,
 * and an explicit scheme is kept whatever its case.
 * @param href the raw href attribute
 * @returns an absolute http(s) URL
 */
export function absoluteUrl(href: string): string {
  if (href.startsWith("//")) return `https:${href}`;
  return WEB_SCHEME_PATTERN.test(href) ? href : `https://${href}`;
}
