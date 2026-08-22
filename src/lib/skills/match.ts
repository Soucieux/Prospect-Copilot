/**
 * The `match` skill: given what the user sells, find and rank candidate
 * companies as prospects - either from a user-supplied list or by asking
 * the LLM to suggest candidates when the user named none.
 */

import { z } from "zod";
import { fetchWithVariants, normalizeUrl } from "@/lib/extract/fetch-page";
import { analyzeProspect } from "@/lib/extract/analyze-prospect";
import { htmlToText } from "@/lib/extract/html-to-text";
import { chatCompletion, extractJsonObject, type LlmConfig } from "@/lib/llm";
import { SUBAGENT_RESULT_SCHEMA, type EmitCallback } from "@/lib/agent/schemas";
import { NEVER_FABRICATE_RULES, OUTPUT_CONTRACT } from "@/lib/skills/subagents";
import { isLikelyCompanyUrl, resolveCompanyUrl } from "@/lib/agent/router";
import { NOT_PUBLICLY_AVAILABLE } from "@/lib/constants";

export interface CandidateScore {
  url: string;
  companyName: string;
  score: number;
  summary: string;
}

const MAX_CANDIDATES_TO_SCORE = 8;
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

const CANDIDATE_SUGGESTION_SYSTEM_PROMPT = `You help discover real companies that would be good prospects for a
described product or ICP. Suggest up to ${MAX_CANDIDATES_TO_SCORE} real,
specific companies that plausibly fit as customers - never invent a company
that does not exist. For each, give your best-known official website URL, or
null when you are not confident of the exact URL. A wrong or missing URL just
means that suggestion gets skipped later, so only include url when you are
reasonably sure of it.
Respond with ONLY a JSON object of this exact shape:
{"candidates": [{"name": "...", "url": "https://..."|null}, ...]}`;

const CANDIDATE_SUGGESTIONS_SCHEMA = z.object({
  candidates: z
    .array(z.object({ name: z.string().min(1), url: z.string().nullable() }))
    .max(MAX_CANDIDATES_TO_SCORE),
});

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
): { markdown: string; title: string; matches: CandidateScore[] } {
  const title = sellingContext
    ? `Prospect matches for: ${sellingContext}`
    : "Prospect matches";

  if (ranked.length === 0) {
    return {
      title,
      markdown: `# ${title}\n\nNo candidate companies could be scored. Try naming a few companies directly.`,
      matches: [],
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
  return { title, markdown: lines.join("\n"), matches: ranked };
}

/**
 * Ask the LLM to suggest candidate companies for a described product when
 * the user named none directly. Each suggestion is a name or a guessed URL -
 * resolved and verified the same way as a user-supplied candidate.
 * @param config LLM credentials
 * @param sellingContext what the user sells, as extracted by the router
 * @returns suggested identifiers (names or URLs), or [] on any failure
 */
async function suggestCandidates(
  config: LlmConfig,
  sellingContext: string,
): Promise<string[]> {
  try {
    const raw = await chatCompletion(
      config,
      [
        { role: "system", content: CANDIDATE_SUGGESTION_SYSTEM_PROMPT },
        { role: "user", content: sellingContext },
      ],
      { temperature: 0.4, jsonMode: true },
    );
    const jsonText = extractJsonObject(raw);
    if (!jsonText) return [];
    const parsed = CANDIDATE_SUGGESTIONS_SCHEMA.parse(JSON.parse(jsonText));
    return parsed.candidates.map((candidate) => candidate.url ?? candidate.name);
  } catch {
    return [];
  }
}

/**
 * Resolve the pool of candidate URLs to score: the user-supplied list when
 * given, otherwise LLM-suggested candidates grounded in what they sell.
 * @param config LLM credentials
 * @param candidates company names/URLs named directly in the message
 * @param sellingContext what the user sells, used to request suggestions
 * @returns deduped candidate URLs, capped at MAX_CANDIDATES_TO_SCORE
 */
export async function resolveCandidates(
  config: LlmConfig,
  candidates: string[] | null,
  sellingContext: string | null,
): Promise<string[]> {
  const identifiers =
    candidates && candidates.length > 0
      ? candidates
      : sellingContext
        ? await suggestCandidates(config, sellingContext)
        : [];
  if (identifiers.length === 0) return [];
  const resolved = await Promise.all(
    identifiers.map((candidate) => resolveOneCandidate(config, candidate)),
  );
  return dedupeByHost(resolved.filter((url): url is string => url !== null)).slice(
    0,
    MAX_CANDIDATES_TO_SCORE,
  );
}

/**
 * Resolve one candidate identifier to a URL: used as-is when it already
 * looks like a company site, otherwise resolved by name via the LLM.
 * @param config LLM credentials
 * @param candidate a name or URL, from the user or a suggestion
 * @returns the resolved URL, or null when it can't be resolved
 */
async function resolveOneCandidate(
  config: LlmConfig,
  candidate: string,
): Promise<string | null> {
  try {
    const url = normalizeUrl(candidate).toString();
    return isLikelyCompanyUrl(url) ? url : null;
  } catch {
    // Not a URL - fall through to name resolution.
  }
  return resolveCompanyUrl(config, candidate);
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
 *   null to have the LLM suggest candidates
 * @param emit progress callback (phase/agent events)
 * @returns the report markdown and title
 */
export async function runMatchSkill(
  config: LlmConfig,
  sellingContext: string | null,
  candidates: string[] | null,
  emit: EmitCallback,
): Promise<{ markdown: string; title: string; matches: CandidateScore[] }> {
  emit({
    type: "phase",
    phase: "discovery",
    detail: candidates?.length
      ? `Resolving ${candidates.length} named candidate${candidates.length === 1 ? "" : "s"}`
      : "Asking for candidate company suggestions",
  });
  const candidateUrls = await resolveCandidates(config, candidates, sellingContext);
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
