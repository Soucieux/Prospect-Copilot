/**
 * The `match` skill: given what the user sells, find and rank candidate
 * companies as prospects - either from a user-supplied list or by
 * discovering candidates via web search.
 */

import { fetchWithVariants, normalizeUrl } from "@/lib/extract/fetch-page";
import { analyzeProspect } from "@/lib/extract/analyze-prospect";
import { htmlToText } from "@/lib/extract/html-to-text";
import { chatCompletion, extractJsonObject, type LlmConfig } from "@/lib/llm";
import { SUBAGENT_RESULT_SCHEMA, type EmitCallback } from "@/lib/agent/schemas";
import { NEVER_FABRICATE_RULES, OUTPUT_CONTRACT } from "@/lib/skills/subagents";
import { isLikelyCompanyUrl, resolveCompanyUrl } from "@/lib/agent/router";
import { searchWeb, type SearchConfig } from "@/lib/search/volc-search";
import { NOT_PUBLICLY_AVAILABLE } from "@/lib/constants";

export interface CandidateScore {
  url: string;
  companyName: string;
  score: number;
  summary: string;
}

const MAX_CANDIDATES_TO_SCORE = 8;
const DISCOVERY_SEARCH_COUNT = 10;
const HOMEPAGE_CHAR_BUDGET = 4_000;
const MATCH_RESULT_LIMIT = 5;

const QUICK_SCORE_SYSTEM_PROMPT = `You are a quick-fit scout for a sales intelligence tool.
Given a homepage briefing for ONE candidate company, judge how good a prospect
it is. This is a single fast pass across possibly many candidates - be
decisive, but never invent facts not in the briefing.
When a WHAT WE SELL line is given, judge fit specifically against that
offering. When it is absent, judge only generic B2B health and readiness
signals - do not assume any particular product category.
${NEVER_FABRICATE_RULES}
${OUTPUT_CONTRACT}`;

/**
 * Build the web-search query used to discover candidate companies for a
 * described product when the user named none directly.
 * @param sellingContext what the user sells, as extracted by the router
 * @returns a search-engine query string
 */
export function buildDiscoveryQuery(sellingContext: string): string {
  return `companies that would want to buy: ${sellingContext}`;
}

/**
 * Sort scored candidates by fit and keep only the top N.
 * @param candidates every candidate that was successfully scored
 * @param limit maximum number of candidates to keep
 * @returns candidates sorted descending by score, truncated to `limit`
 */
export function rankCandidates(
  candidates: CandidateScore[],
  limit: number,
): CandidateScore[] {
  return [...candidates].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Render the final match report: a ranked list of candidates with a link
 * to run a full audit on any of them.
 * @param sellingContext what the user sells, or null when unset
 * @param ranked the top candidates, already sorted descending by score
 * @param totalConsidered how many candidates were scored before truncation
 * @returns the report markdown and a short title for the report card
 */
export function renderMatchReport(
  sellingContext: string | null,
  ranked: CandidateScore[],
  totalConsidered: number,
): { markdown: string; title: string } {
  const title = sellingContext
    ? `Prospect matches for: ${sellingContext}`
    : "Prospect matches";

  if (ranked.length === 0) {
    return {
      title,
      markdown: `# ${title}\n\nNo candidate companies could be scored. Try naming a few companies directly, or check that a web-search API key is configured in Settings.`,
    };
  }

  const lines = [
    `# ${title}`,
    "",
    `Ranked ${ranked.length} of ${totalConsidered} candidate${totalConsidered === 1 ? "" : "s"} considered:`,
    "",
  ];
  ranked.forEach((candidate, index) => {
    lines.push(
      `${index + 1}. **${candidate.companyName}** - ${candidate.score}/100`,
      `   ${candidate.summary}`,
      `   ${candidate.url}`,
      "",
    );
  });
  if (totalConsidered > ranked.length) {
    lines.push(
      `_${totalConsidered - ranked.length} lower-scoring candidate${
        totalConsidered - ranked.length === 1 ? "" : "s"
      } omitted from this list._`,
      "",
    );
  }
  lines.push(
    "> Ask about any one of these by name for a full prospect audit.",
  );
  return { title, markdown: lines.join("\n") };
}

/**
 * Resolve the pool of candidate URLs to score: the user-supplied list when
 * given, otherwise a web-search discovery pass grounded in what they sell.
 * @param searchConfig web-search credentials, or null when unconfigured
 * @param candidates company names/URLs named directly in the message
 * @param sellingContext what the user sells, used to build the discovery query
 * @returns deduped candidate URLs, capped at MAX_CANDIDATES_TO_SCORE
 */
export async function resolveCandidates(
  searchConfig: SearchConfig | null,
  candidates: string[] | null,
  sellingContext: string | null,
): Promise<string[]> {
  if (candidates && candidates.length > 0) {
    const resolved = await Promise.all(
      candidates.map((candidate) => resolveOneCandidate(searchConfig, candidate)),
    );
    return dedupeByHost(resolved.filter((url): url is string => url !== null)).slice(
      0,
      MAX_CANDIDATES_TO_SCORE,
    );
  }
  if (!searchConfig || !sellingContext) return [];
  const results = await searchWeb(
    searchConfig,
    buildDiscoveryQuery(sellingContext),
    DISCOVERY_SEARCH_COUNT,
  );
  const urls = results.map((result) => result.url).filter(isLikelyCompanyUrl);
  return dedupeByHost(urls).slice(0, MAX_CANDIDATES_TO_SCORE);
}

/**
 * Resolve one supplied candidate to a URL: used as-is when it already looks
 * like a company site, otherwise resolved by name via web search.
 * @param searchConfig web-search credentials, or null when unconfigured
 * @param candidate a name or URL named directly in the message
 * @returns the resolved URL, or null when it can't be resolved
 */
async function resolveOneCandidate(
  searchConfig: SearchConfig | null,
  candidate: string,
): Promise<string | null> {
  try {
    const url = normalizeUrl(candidate).toString();
    return isLikelyCompanyUrl(url) ? url : null;
  } catch {
    // Not a URL - fall through to name resolution.
  }
  if (!searchConfig) return null;
  return resolveCompanyUrl(searchConfig, candidate);
}

/**
 * Drop duplicate candidates that share a hostname.
 * @param urls candidate URLs, possibly containing duplicates
 * @returns URLs with later duplicates removed, unparseable entries dropped
 */
function dedupeByHost(urls: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const url of urls) {
    try {
      const host = new URL(url).hostname;
      if (seen.has(host)) continue;
      seen.add(host);
      deduped.push(url);
    } catch {
      // Skip unparseable URLs.
    }
  }
  return deduped;
}

/**
 * Fetch one candidate's homepage and run a single lightweight LLM scoring
 * call - not the full subagent pipeline, so this stays cheap across a batch.
 * @param config LLM credentials
 * @param sellingContext what the user sells, or null for a neutral judgment
 * @param url the candidate's homepage URL
 * @returns the candidate's score, or null on any fetch/parse failure
 */
export async function quickScoreCandidate(
  config: LlmConfig,
  sellingContext: string | null,
  url: string,
): Promise<CandidateScore | null> {
  try {
    const page = await fetchWithVariants(url);
    const extraction = analyzeProspect(page.html, page.url);
    const briefing = `Company: ${extraction.companyName ?? NOT_PUBLICLY_AVAILABLE}
Title/description: ${extraction.title ?? "-"} / ${extraction.description ?? "-"}
Tech stack: ${extraction.techStack.join(", ") || "none detected"}
Homepage text: ${htmlToText(page.html).slice(0, HOMEPAGE_CHAR_BUDGET)}`;
    const userContent = sellingContext
      ? `WHAT WE SELL: ${sellingContext}\n\n${briefing}`
      : briefing;
    const raw = await chatCompletion(
      config,
      [
        { role: "system", content: QUICK_SCORE_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      { temperature: 0.2, jsonMode: true },
    );
    const jsonText = extractJsonObject(raw);
    if (!jsonText) return null;
    const parsed = SUBAGENT_RESULT_SCHEMA.parse(JSON.parse(jsonText));
    return {
      url: page.url,
      companyName: extraction.companyName ?? new URL(page.url).hostname,
      score: parsed.score,
      summary: parsed.summary,
    };
  } catch {
    return null;
  }
}

/**
 * Run the match skill end to end: resolve candidates, quick-score each in
 * parallel, rank, and render the final report.
 * @param config LLM credentials
 * @param sellingContext what the user sells, or null for a neutral judgment
 * @param candidates company names/URLs named directly in the message, or
 *   null to discover candidates via web search
 * @param emit progress callback (phase/agent events)
 * @param searchConfig web-search credentials, or null when unconfigured
 * @returns the report markdown and title
 */
export async function runMatchSkill(
  config: LlmConfig,
  sellingContext: string | null,
  candidates: string[] | null,
  emit: EmitCallback,
  searchConfig: SearchConfig | null,
): Promise<{ markdown: string; title: string }> {
  emit({
    type: "phase",
    phase: "discovery",
    detail: candidates?.length
      ? `Resolving ${candidates.length} named candidate${candidates.length === 1 ? "" : "s"}`
      : "Searching for candidate companies",
  });
  const candidateUrls = await resolveCandidates(searchConfig, candidates, sellingContext);
  if (candidateUrls.length === 0) {
    emit({ type: "phase", phase: "done", detail: "No candidates to score" });
    return renderMatchReport(sellingContext, [], 0);
  }

  emit({
    type: "phase",
    phase: "analysis",
    detail: `Scoring ${candidateUrls.length} candidate${candidateUrls.length === 1 ? "" : "s"}`,
  });
  candidateUrls.forEach((url) => emit({ type: "agent", agent: url, status: "running" }));
  const settled = await Promise.allSettled(
    candidateUrls.map((url) => quickScoreCandidate(config, sellingContext, url)),
  );
  const scored: CandidateScore[] = [];
  settled.forEach((result, index) => {
    const url = candidateUrls[index];
    if (result.status === "fulfilled" && result.value) {
      scored.push(result.value);
      emit({ type: "agent", agent: url, status: "done", score: result.value.score });
    } else {
      emit({ type: "agent", agent: url, status: "failed" });
    }
  });

  const ranked = rankCandidates(scored, MATCH_RESULT_LIMIT);
  emit({ type: "phase", phase: "done", detail: "Match complete" });
  return renderMatchReport(sellingContext, ranked, scored.length);
}
