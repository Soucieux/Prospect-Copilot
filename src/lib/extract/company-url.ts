/**
 * Deterministic rules for what counts as a company's own website. The intent
 * router applies them to a URL the model guessed for a name, and the match
 * pipeline applies them to candidates the user or the model named, so the
 * rules live here rather than in either caller.
 */

/**
 * Hostnames that are never a company's own site (social/reference platforms).
 * Each name is anchored to the start of a domain label, and x.com to the whole
 * registrable domain: unanchored, "x.com." never matched x.com itself yet did
 * match any company whose name ends in x under a two-part suffix (.com.br).
 */
const NON_COMPANY_HOST_PATTERN =
  /(^|\.)(linkedin|facebook|twitter|wikipedia|crunchbase)\.|(^|\.)x\.com$/i;

/**
 * Whether a URL looks like a company's own site rather than a social,
 * reference, or aggregator platform.
 * @param url the candidate URL
 * @returns false for unparseable URLs, single-label hosts, or known
 *   non-company hosts
 */
export function isLikelyCompanyUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname.includes(".") && !NON_COMPANY_HOST_PATTERN.test(hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Distinguish an actual URL/domain from a bare company or product name.
 * URL() accepts any no-space Unicode word as an internationalized hostname
 * and converts it to Punycode, so parsing alone is not a sufficient test.
 * @param raw candidate identifier from the user or discovery model
 * @returns true only for an explicit http(s) URL or a dotted domain
 */
export function looksLikeWebAddress(raw: string): boolean {
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) return true;
  if (!value || /\s/.test(value)) return false;
  const [authority = ""] = value.split(/[/?#]/, 1);
  return /[^.。．｡][.。．｡][^.。．｡]/u.test(authority);
}

/**
 * Drop later entries that share a hostname with an earlier one.
 * @param candidates entries carrying a URL, possibly with duplicate hosts
 * @returns the entries with duplicate hosts and unparseable URLs removed
 */
export function dedupeByHost<Candidate extends { url: string }>(
  candidates: Candidate[],
): Candidate[] {
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const candidate of candidates) {
    try {
      const host = new URL(candidate.url).hostname;
      if (seen.has(host)) continue;
      seen.add(host);
      deduped.push(candidate);
    } catch {
      // Skip unparseable URLs.
    }
  }
  return deduped;
}
