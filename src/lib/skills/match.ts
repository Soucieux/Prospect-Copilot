/**
 * The `match` skill: find and rank companies for either side of a product
 * transaction - buyers in sell mode or sellers in buy mode.
 */

import { z } from "zod";
import { fetchWithVariants, normalizeUrl } from "@/lib/extract/fetch-page";
import { analyzeProspect } from "@/lib/extract/analyze-prospect";
import { htmlToText } from "@/lib/extract/html-to-text";
import { structuredChatCompletion, type LlmConfig } from "@/lib/llm";
import type { EmitCallback, MatchDirection } from "@/lib/agent/schemas";
import { NEVER_FABRICATE_RULES } from "@/lib/skills/subagents";
import { isLikelyCompanyUrl, resolveCompanyUrl } from "@/lib/agent/router";
import {
  NOT_PUBLICLY_AVAILABLE,
  UNTRUSTED_WEB_CONTENT_RULES,
} from "@/lib/constants";
import {
  RUNTIME_LABEL_DEFAULTS,
  formatRuntimeLabel,
  mergeLabelSet,
  responseLanguageContext,
  type LabelSet,
  type RuntimeLabels,
} from "@/lib/localization";
import { runGraphWorkerPool } from "@/lib/graph-worker-pool";
import {
  STRUCTURED_LLM_RETRY_OPTIONS,
  retryOperation,
} from "@/lib/retry";

/** English defaults for every static label in the match report and cards. */
export const MATCH_REPORT_LABELS: LabelSet = {
  titleTemplate: "Prospect matches for: {product}",
  titleFallback: "Prospect matches",
  titleWithLocationTemplate: "Prospect matches for: {product} in {location}",
  locationTitleTemplate: "Prospect matches in {location}",
  noneScored:
    "No candidate companies could be scored. Try naming a few companies directly.",
  rankedTemplateSingular: "Ranked {ranked} of {total} candidate considered:",
  rankedTemplatePlural: "Ranked {ranked} of {total} candidates considered:",
  locationLabel: "Location",
  foundedLabel: "Founded",
  fitLabel: "Fit",
  omittedTemplateSingular:
    "{count} lower-scoring candidate omitted from this list.",
  omittedTemplatePlural:
    "{count} lower-scoring candidates omitted from this list.",
  auditPrompt: "Ask about any one of these by name for a full prospect audit.",
  auditHint: "Click for a full prospect audit →",
  auditRequestTemplate: "Analyze {url} as a prospect",
  nudge:
    'Tell me what you sell (e.g. "we sell payroll software for mid-market companies") and I can find and rank the best-fit companies for it.',
};

/** English report/card copy for buy-direction matches; keys mirror sell mode. */
export const BUY_MATCH_REPORT_LABELS: LabelSet = {
  titleTemplate: "Places to buy: {product}",
  titleFallback: "Places to buy",
  titleWithLocationTemplate: "Places to buy: {product} in {location}",
  locationTitleTemplate: "Places to buy in {location}",
  noneScored:
    "No sellers or retailers could be scored. Try naming a few places directly.",
  rankedTemplateSingular: "Ranked {ranked} of {total} place considered:",
  rankedTemplatePlural: "Ranked {ranked} of {total} places considered:",
  locationLabel: "Location",
  foundedLabel: "Founded",
  fitLabel: "Purchase fit",
  omittedTemplateSingular:
    "{count} lower-scoring place omitted from this list.",
  omittedTemplatePlural:
    "{count} lower-scoring places omitted from this list.",
  auditPrompt: "Open a listed website or ask about any seller by name.",
  auditHint: "Click for a full seller review →",
  auditRequestTemplate: "Analyze {url} as a supplier",
  nudge:
    'Tell me what you want to buy (e.g. "where can I buy wool blankets?") and I can find and rank the best places for it.',
};

/**
 * Select the English report/card copy for one match direction.
 * @param direction whether candidates should buy from or sell to the user
 * @returns the buy-mode label set for "buy", otherwise the sell-mode set
 */
function reportLabelsFor(direction: MatchDirection): LabelSet {
  return direction === "buy" ? BUY_MATCH_REPORT_LABELS : MATCH_REPORT_LABELS;
}

export interface CandidateScore {
  url: string;
  companyName: string;
  score: number;
  /** Factual summary of what the company does, for someone unfamiliar with it. */
  description: string;
  /** Judgment of how well the company fits the requested match direction. */
  fitReason: string;
  /** From the page's own structured data, when present. */
  location: string | null;
  /** From the page's own structured data, when present. */
  founded: string | null;
}

interface CandidateIdentifier {
  identifier: string;
  nameHint: string | null;
}

export interface ResolvedCandidate {
  url: string;
  nameHint: string | null;
}

/** Candidate discovery output retained between match graph stages. */
export interface CandidatePool {
  candidates: ResolvedCandidate[];
  urls: string[];
  labels: LabelSet;
}

/** Candidate score output retained after the scoring worker fan-in. */
export interface CandidateScoreBatch {
  scored: CandidateScore[];
  labels: LabelSet;
}

/** Final match business result consumed by the workflow report node. */
export interface MatchSkillResult {
  markdown: string;
  title: string;
  matches: CandidateScore[];
  cardLabels: {
    founded: string;
    fit: string;
    auditHint: string;
    auditRequestTemplate: string;
  };
}

const MAX_CANDIDATES_TO_SCORE = 12;
const MAX_CANDIDATE_CONCURRENCY = 4;
const HOMEPAGE_CHAR_BUDGET = 4_000;
const MATCH_RESULT_LIMIT = 8;

const QUICK_SCORE_SCHEMA = z.object({
  companyName: z.string().trim().min(1),
  score: z.number().min(0).max(100),
  description: z.string().min(1),
  fitReason: z.string().min(1),
  labels: z.record(z.string(), z.string()).optional(),
});

const QUICK_SCORE_SYSTEM_PROMPT = `You are a quick-fit scout for a sales intelligence tool.
Given a homepage briefing for ONE candidate company, write a short factual
description of what the company does - for someone who has never heard of
it - then judge its fit for the requested match direction. This is a single fast pass across
possibly many candidates - be decisive, but never invent facts not in the
briefing.
${UNTRUSTED_WEB_CONTENT_RULES}
Return the company's complete official company or brand name in companyName.
Never use a hostname, URL, webpage section name, or generic page title as the
companyName. Prefer the CANDIDATE NAME HINT when it agrees with the homepage;
otherwise use the strongest organization-name evidence in the briefing.
Follow MATCH DIRECTION exactly:
- sell: judge whether the candidate is likely to buy WHAT WE SELL.
- buy: judge whether the candidate is a credible place to buy WHAT WE WANT TO
  BUY, based only on evidence that it sells, distributes, supplies, or lists
  that product.
When a REQUESTED LOCATION is provided, treat geographic fit as a required part
of the score and explain it in fitReason:
- sell: look for evidence that the candidate operates, purchases, or has a
  relevant business presence in that location.
- buy: look for evidence that the candidate has stores there or explicitly
  sells, ships, delivers, or serves that location.
Do not claim geographic availability without evidence in the briefing. When
location fit is not publicly verifiable, say so and lower the score.
When the product context is absent, judge only generic company relevance and
readiness signals - do not assume any particular product category.
${NEVER_FABRICATE_RULES}
When a LABELS object is given in the user message, also translate each of
its values into the same language as your description/fitReason above (echo
unchanged if that's already English) and return it under "labels" with the
exact same keys - never add, remove, or rename keys, and never translate
product or brand names.
Respond with ONLY a JSON object of this exact shape:
{"companyName": "<complete official company or brand name>", "score": <number 0-100>, "description": "<1-2 sentence factual description of what the company does>", "fitReason": "<1-2 sentence judgment of fit>", "labels": {...same keys as given, translated}}
Omit "labels" entirely when no LABELS object was given in the user message.`;

const CANDIDATE_SUGGESTION_SYSTEM_PROMPT = `You discover real companies or places for a product match. Follow MATCH
DIRECTION exactly: for sell, suggest plausible customers/buyers; for buy,
suggest plausible sellers, retailers, distributors, suppliers, or marketplaces
where the product can be purchased. Suggest up to ${MAX_CANDIDATES_TO_SCORE}
real, specific organizations - never invent one. For each, give your best-known official website URL, or
null when you are not confident of the exact URL. A wrong or missing URL just
means that suggestion gets skipped later, so only include url when you are
reasonably sure of it. The name field must contain an actual organization's
name, never the product, a generic category, or a market description.
When the user message contains a REQUESTED LOCATION, it is a hard discovery
constraint that overrides language-based market inference:
- sell: suggest buyers that operate, purchase, or have a relevant business
  presence in the requested location.
- buy: suggest sellers with stores there or known sales, shipping, delivery,
  or service coverage there.
Prefer candidates whose location fit you know rather than globally famous but
geographically uncertain candidates. Never invent a local branch or coverage.
The user message contains a DETECTED RESPONSE LANGUAGE. Use that dynamically
as a market signal for any language, without relying on a fixed
language list: suggest companies that meaningfully operate, sell, or publish
for markets where that language is used only when REQUESTED LOCATION is absent.
Do not replace or translate company names, brands, URLs, or requested locations.
The user message also contains a LABELS object. Translate every label value
into the detected language, preserving every key and every {placeholder}.
Respond with ONLY a JSON object of this exact shape:
{"candidates": [{"name": "...", "url": "https://..."|null}, ...], "labels": {...same keys as LABELS, translated}}`;

const CANDIDATE_SUGGESTIONS_SCHEMA = z.object({
  candidates: z
    .array(z.object({ name: z.string().min(1), url: z.string().nullable() }))
    .max(MAX_CANDIDATES_TO_SCORE),
  labels: z.record(z.string(), z.string()).optional(),
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
 * @param sellingContext product context for the buy or sell match
 * @param ranked the top candidates, already sorted descending by score
 * @param totalConsidered how many candidates were scored before truncation
 * @param labels localized report labels
 * @param matchLocation explicit geographic requirement, when supplied
 * @returns the report markdown and a short title for the report card
 */
export function renderMatchReport(
  sellingContext: string | null,
  ranked: CandidateScore[],
  totalConsidered: number,
  labels: LabelSet = MATCH_REPORT_LABELS,
  matchLocation: string | null = null,
): { markdown: string; title: string; matches: CandidateScore[] } {
  const title = matchLocation
    ? sellingContext
      ? formatRuntimeLabel(labels.titleWithLocationTemplate, {
          product: sellingContext,
          location: matchLocation,
        })
      : formatRuntimeLabel(labels.locationTitleTemplate, {
          location: matchLocation,
        })
    : sellingContext
      ? labels.titleTemplate.replace("{product}", sellingContext)
      : labels.titleFallback;

  if (ranked.length === 0) {
    return {
      title,
      markdown: `# ${title}\n\n${labels.noneScored}`,
      matches: [],
    };
  }

  const rankedTemplate =
    totalConsidered === 1
      ? labels.rankedTemplateSingular
      : labels.rankedTemplatePlural;
  const lines = [
    `# ${title}`,
    "",
    rankedTemplate
      .replace("{ranked}", String(ranked.length))
      .replace("{total}", String(totalConsidered)),
    "",
  ];
  ranked.forEach((candidate, index) => {
    lines.push(`${index + 1}. **${candidate.companyName}** - ${candidate.score}/100`);
    if (candidate.location || candidate.founded) {
      const parts = [
        candidate.location ? `${labels.locationLabel}: ${candidate.location}` : null,
        candidate.founded ? `${labels.foundedLabel}: ${candidate.founded}` : null,
      ].filter((part): part is string => part !== null);
      lines.push(`   ${parts.join(" · ")}`);
    }
    lines.push(
      `   ${candidate.description}`,
      `   ${labels.fitLabel}: ${candidate.fitReason}`,
      `   ${candidate.url}`,
      "",
    );
  });
  if (totalConsidered > ranked.length) {
    const omittedCount = totalConsidered - ranked.length;
    const omittedTemplate =
      omittedCount === 1
        ? labels.omittedTemplateSingular
        : labels.omittedTemplatePlural;
    lines.push(`_${omittedTemplate.replace("{count}", String(omittedCount))}_`, "");
  }
  lines.push(`> ${labels.auditPrompt}`);
  return { title, markdown: lines.join("\n"), matches: ranked };
}

/**
 * Ask the LLM to suggest candidate companies for a described product when
 * the user named none directly. Each suggestion is a name or a guessed URL -
 * resolved and verified the same way as a user-supplied candidate.
 * @param config LLM credentials
 * @param sellingContext product context extracted by the router
 * @param requesterMessage latest user-authored message
 * @param responseLanguage language recognized from the latest message
 * @param matchDirection whether candidates are buyers or sellers
 * @param matchLocation explicit geographic requirement, when supplied
 * @param signal cancels candidate discovery
 * @returns suggested identifiers and localized report labels
 */
async function suggestCandidates(
  config: LlmConfig,
  sellingContext: string,
  requesterMessage: string,
  responseLanguage: string,
  matchDirection: MatchDirection = "sell",
  matchLocation: string | null = null,
  signal?: AbortSignal,
): Promise<{ identifiers: CandidateIdentifier[]; labels: LabelSet }> {
  const defaultLabels = reportLabelsFor(matchDirection);
  try {
    const parsed = await retryOperation(
      () =>
        structuredChatCompletion(
          config,
          [
            { role: "system", content: CANDIDATE_SUGGESTION_SYSTEM_PROMPT },
            {
              role: "user",
              content: `${responseLanguageContext(responseLanguage, requesterMessage)}\n\nMATCH DIRECTION: ${matchDirection}\n\nPRODUCT CONTEXT: ${sellingContext}\n\nREQUESTED LOCATION: ${matchLocation ?? "not specified"}\n\nLABELS: ${JSON.stringify(defaultLabels)}`,
            },
          ],
          CANDIDATE_SUGGESTIONS_SCHEMA,
          { temperature: 0.4, schemaName: "candidate_suggestions", signal },
        ),
      { ...STRUCTURED_LLM_RETRY_OPTIONS, signal },
    );
    return {
      identifiers: parsed.candidates.map((candidate) => ({
        identifier: candidate.url ?? candidate.name,
        nameHint: candidate.name,
      })),
      labels: mergeLabelSet(defaultLabels, parsed.labels),
    };
  } catch {
    signal?.throwIfAborted();
    return { identifiers: [], labels: defaultLabels };
  }
}

/**
 * Resolve the pool of candidate URLs to score: the user-supplied list when
 * given, otherwise LLM-suggested candidates grounded in the product context.
 * @param config LLM credentials
 * @param candidates company names/URLs named directly in the message
 * @param sellingContext product context used to request suggestions
 * @param requesterMessage latest user-authored message
 * @param responseLanguage language recognized from the latest message
 * @param matchDirection whether candidates are buyers or sellers
 * @param matchLocation explicit geographic requirement, when supplied
 * @param signal cancels candidate resolution
 * @returns deduped candidate URLs and any labels localized during discovery
 */
export async function resolveCandidates(
  config: LlmConfig,
  candidates: string[] | null,
  sellingContext: string | null,
  requesterMessage: string = "",
  responseLanguage: string = "English",
  matchDirection: MatchDirection = "sell",
  matchLocation: string | null = null,
  signal?: AbortSignal,
): Promise<CandidatePool> {
  const defaultLabels = reportLabelsFor(matchDirection);
  const suggested =
    candidates && candidates.length > 0
      ? {
          identifiers: candidates.map((candidate) => ({
            identifier: candidate,
            nameHint: looksLikeWebAddress(candidate) ? null : candidate,
          })),
          labels: defaultLabels,
        }
      : sellingContext
        ? await suggestCandidates(
            config,
            sellingContext,
            requesterMessage,
            responseLanguage,
            matchDirection,
            matchLocation,
            signal,
          )
        : { identifiers: [], labels: defaultLabels };
  if (suggested.identifiers.length === 0) {
    return { candidates: [], urls: [], labels: suggested.labels };
  }
  const identifiersToResolve = suggested.identifiers.slice(
    0,
    MAX_CANDIDATES_TO_SCORE,
  );
  const resolved = await runGraphWorkerPool(
    identifiersToResolve,
    MAX_CANDIDATE_CONCURRENCY,
    async ({ identifier, nameHint }) => {
      const url = await resolveOneCandidate(config, identifier, signal);
      return url ? { url, nameHint } : null;
    },
    signal,
  );
  const resolvedCandidates = dedupeByHost(
    resolved.filter(
      (candidate): candidate is ResolvedCandidate => candidate !== null,
    ),
  ).slice(0, MAX_CANDIDATES_TO_SCORE);
  return {
    candidates: resolvedCandidates,
    urls: resolvedCandidates.map((candidate) => candidate.url),
    labels: suggested.labels,
  };
}

/**
 * Resolve the candidate pool while emitting the existing discovery lifecycle.
 * @param config LLM credentials
 * @param sellingContext product context used for candidate suggestions
 * @param candidates user-named candidates, when supplied
 * @param emit progress callback
 * @param requesterMessage latest user message
 * @param responseLanguage detected response language
 * @param runtimeLabels localized progress labels
 * @param matchDirection whether candidates buy or sell the product
 * @param matchLocation explicit geographic constraint
 * @param signal cancels discovery and URL resolution
 * @returns resolved, deduplicated candidate pool
 */
export async function resolveMatchCandidatesStage(
  config: LlmConfig,
  sellingContext: string | null,
  candidates: string[] | null,
  emit: EmitCallback,
  requesterMessage: string,
  responseLanguage: string,
  runtimeLabels: RuntimeLabels,
  matchDirection: MatchDirection,
  matchLocation: string | null,
  signal?: AbortSignal,
): Promise<CandidatePool> {
  emit({
    type: "phase",
    phase: "discovery",
    detail: candidates?.length
      ? candidates.length === 1
        ? runtimeLabels.resolvingCandidatesSingular
        : formatRuntimeLabel(runtimeLabels.resolvingCandidatesPlural, {
            count: candidates.length,
          })
      : matchDirection === "buy"
        ? runtimeLabels.askingBuyCandidateSuggestions
        : runtimeLabels.askingCandidateSuggestions,
  });
  const candidatePool = await resolveCandidates(
    config,
    candidates,
    sellingContext,
    requesterMessage,
    responseLanguage,
    matchDirection,
    matchLocation,
    signal,
  );
  if (candidatePool.candidates.length === 0) {
    emit({
      type: "phase",
      phase: "done",
      detail:
        matchDirection === "buy"
          ? runtimeLabels.noBuyCandidates
          : runtimeLabels.noCandidates,
    });
  }
  return candidatePool;
}

/**
 * Score resolved candidates with bounded graph workers and partial fallback.
 * @param config LLM credentials
 * @param candidatePool resolved candidate stage output
 * @param sellingContext product context for fit scoring
 * @param namedCandidates user-named candidates, when supplied
 * @param emit progress callback
 * @param requesterMessage latest user message
 * @param responseLanguage detected response language
 * @param runtimeLabels localized progress labels
 * @param matchDirection whether candidates buy or sell the product
 * @param matchLocation explicit geographic constraint
 * @param signal cancels scoring workers
 * @returns successfully scored candidates and localized report labels
 */
export async function scoreMatchCandidatesStage(
  config: LlmConfig,
  candidatePool: CandidatePool,
  sellingContext: string | null,
  namedCandidates: string[] | null,
  emit: EmitCallback,
  requesterMessage: string,
  responseLanguage: string,
  runtimeLabels: RuntimeLabels,
  matchDirection: MatchDirection,
  matchLocation: string | null,
  signal?: AbortSignal,
): Promise<CandidateScoreBatch> {
  const resolvedCandidates = candidatePool.candidates;
  if (resolvedCandidates.length === 0) {
    return { scored: [], labels: candidatePool.labels };
  }
  emit({
    type: "phase",
    phase: "analysis",
    detail:
      resolvedCandidates.length === 1
        ? runtimeLabels.scoringCandidateSingular
        : formatRuntimeLabel(runtimeLabels.scoringCandidatePlural, {
            count: resolvedCandidates.length,
          }),
  });
  resolvedCandidates.forEach(({ url }) =>
    emit({
      type: "agent",
      agent: url,
      detail: formatRuntimeLabel(runtimeLabels.agentRunningTemplate, {
        agent: url,
      }),
      status: "running",
    }),
  );
  const defaultLabels = reportLabelsFor(matchDirection);
  const translateEveryScore = Boolean(namedCandidates?.length);
  const scoredResults = await runGraphWorkerPool(
    resolvedCandidates,
    MAX_CANDIDATE_CONCURRENCY,
    async ({ url, nameHint }, index) => {
      try {
        return await quickScoreCandidate(
          config,
          sellingContext,
          url,
          requesterMessage,
          responseLanguage,
          translateEveryScore || index === 0 ? defaultLabels : undefined,
          nameHint,
          matchDirection,
          matchLocation,
          signal,
        );
      } catch {
        signal?.throwIfAborted();
        return null;
      }
    },
    signal,
  );
  signal?.throwIfAborted();
  const scored: CandidateScore[] = [];
  let labels = candidatePool.labels;
  scoredResults.forEach((result, index) => {
    const url = resolvedCandidates[index].url;
    if (result) {
      const { labels: translated, ...score } = result;
      if (translated) labels = translated;
      scored.push(score);
      emit({
        type: "agent",
        agent: url,
        detail: formatRuntimeLabel(runtimeLabels.agentDoneTemplate, {
          agent: url,
        }),
        status: "done",
        score: score.score,
      });
      return;
    }
    emit({
      type: "agent",
      agent: url,
      detail: formatRuntimeLabel(runtimeLabels.agentFailedTemplate, {
        agent: url,
      }),
      status: "failed",
    });
  });
  return { scored, labels };
}

/**
 * Rank and format completed match state without repeating earlier stages.
 * @param candidatePool resolved candidate stage output
 * @param scoreBatch scoring stage output
 * @param sellingContext product context for report titles
 * @param namedCandidates user-named candidates, when supplied
 * @param emit progress callback
 * @param runtimeLabels localized progress and card labels
 * @param matchDirection whether candidates buy or sell the product
 * @param matchLocation explicit geographic constraint
 * @returns final match report and card metadata
 */
export function formatMatchSkillResult(
  candidatePool: CandidatePool,
  scoreBatch: CandidateScoreBatch,
  sellingContext: string | null,
  namedCandidates: string[] | null,
  emit: EmitCallback,
  runtimeLabels: RuntimeLabels,
  matchDirection: MatchDirection,
  matchLocation: string | null,
): MatchSkillResult {
  let labels = scoreBatch.labels;
  const ranked = rankCandidates(scoreBatch.scored, MATCH_RESULT_LIMIT);
  if (
    ranked.length === 0 &&
    namedCandidates?.length
  ) {
    const reportTitle = formatRuntimeLabel(runtimeLabels.reportTemplate, {
      skill: runtimeLabels.skillMatch,
    });
    labels = {
      ...labels,
      titleTemplate: `${reportTitle}: {product}`,
      titleFallback: reportTitle,
      noneScored:
        matchDirection === "buy"
          ? runtimeLabels.noBuyCandidates
          : runtimeLabels.noCandidates,
    };
  }
  if (candidatePool.candidates.length > 0) {
    emit({ type: "phase", phase: "done", detail: runtimeLabels.matchComplete });
  }
  const cardLabels =
    matchDirection === "buy"
      ? {
          founded: labels.foundedLabel,
          fit: labels.fitLabel,
          auditHint: labels.auditHint,
          auditRequestTemplate: labels.auditRequestTemplate,
        }
      : {
          founded: runtimeLabels.foundedLabel,
          fit: runtimeLabels.fitLabel,
          auditHint: runtimeLabels.auditHint,
          auditRequestTemplate: runtimeLabels.auditRequestTemplate,
        };
  return {
    ...renderMatchReport(
      sellingContext,
      ranked,
      scoreBatch.scored.length,
      labels,
      matchLocation,
    ),
    cardLabels,
  };
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
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  if (looksLikeWebAddress(candidate)) {
    try {
      const url = normalizeUrl(candidate).toString();
      return isLikelyCompanyUrl(url) ? url : null;
    } catch {
      return null;
    }
  }
  return resolveCompanyUrl(config, candidate, signal);
}

/**
 * Distinguish an actual URL/domain from a bare company or product name.
 * URL() accepts any no-space Unicode word as an internationalized hostname
 * and converts it to Punycode, so parsing alone is not a sufficient test.
 * @param raw candidate identifier from the user or discovery model
 * @returns true only for an explicit http(s) URL or a dotted domain
 */
function looksLikeWebAddress(raw: string): boolean {
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) return true;
  if (!value || /\s/.test(value)) return false;
  const authority = value.split(/[/?#]/, 1)[0] ?? "";
  return /[^.。．｡][.。．｡][^.。．｡]/u.test(authority);
}

/**
 * Drop duplicate candidates that share a hostname.
 * @param candidates resolved candidates, possibly containing duplicate hosts
 * @returns candidates with later duplicate hosts and invalid URLs removed
 */
function dedupeByHost(candidates: ResolvedCandidate[]): ResolvedCandidate[] {
  const seen = new Set<string>();
  const deduped: ResolvedCandidate[] = [];
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

/**
 * Fetch one candidate's homepage and run a single lightweight LLM scoring
 * call - not the full subagent pipeline, so this stays cheap across a batch.
 * @param config LLM credentials
 * @param sellingContext product context, or null for a neutral judgment
 * @param url the candidate's homepage URL
 * @param requesterMessage the requester's own chat message, included only so
 *   the language instruction has real text to detect language from - the
 *   briefing itself is scraped from the candidate's own homepage
 * @param responseLanguage language recognized from the latest user message
 * @param labelsToTranslate when given, this same call also asks the model to
 *   translate these report/card labels into the same language as its
 *   description/fitReason - used once per match run instead of a dedicated
 *   translation call
 * @param nameHint official candidate name retained from discovery
 * @param matchDirection whether the candidate should buy or sell the product
 * @param matchLocation explicit geographic requirement, when supplied
 * @param signal cancels homepage and provider requests
 * @returns the candidate's score (with translated labels when requested),
 *   or null on any fetch/parse failure
 */
export async function quickScoreCandidate(
  config: LlmConfig,
  sellingContext: string | null,
  url: string,
  requesterMessage: string = "",
  responseLanguage: string = "English",
  labelsToTranslate?: LabelSet,
  nameHint: string | null = null,
  matchDirection: MatchDirection = "sell",
  matchLocation: string | null = null,
  signal?: AbortSignal,
): Promise<(CandidateScore & { labels?: LabelSet }) | null> {
  try {
    const page = await fetchWithVariants(url, signal);
    const extraction = analyzeProspect(page.html, page.url);
    const briefing = `CANDIDATE NAME HINT: ${nameHint ?? NOT_PUBLICLY_AVAILABLE}
Company metadata: ${extraction.companyName ?? NOT_PUBLICLY_AVAILABLE}
Structured location: ${extraction.jsonLdOrg?.address ?? NOT_PUBLICLY_AVAILABLE}
Title/description: ${extraction.title ?? "-"} / ${extraction.description ?? "-"}
Tech stack: ${extraction.techStack.join(", ") || "none detected"}
Homepage text: ${htmlToText(page.html).slice(0, HOMEPAGE_CHAR_BUDGET)}`;
    const languageHint = `${responseLanguageContext(responseLanguage, requesterMessage)}\n\n`;
    const productLine = sellingContext
      ? matchDirection === "buy"
        ? `WHAT WE WANT TO BUY: ${sellingContext}\n\n`
        : `WHAT WE SELL: ${sellingContext}\n\n`
      : "";
    const directionLine = `MATCH DIRECTION: ${matchDirection}\n\n`;
    const locationLine = matchLocation
      ? `REQUESTED LOCATION: ${matchLocation}\n\n`
      : "";
    const labelsLine = labelsToTranslate
      ? `LABELS: ${JSON.stringify(labelsToTranslate)}\n\n`
      : "";
    const userContent = `${languageHint}${directionLine}${productLine}${locationLine}${labelsLine}${briefing}`;
    const parsed = await retryOperation(
      () =>
        structuredChatCompletion(
          config,
          [
            { role: "system", content: QUICK_SCORE_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          QUICK_SCORE_SCHEMA,
          { temperature: 0.2, schemaName: "candidate_score", signal },
        ),
      { ...STRUCTURED_LLM_RETRY_OPTIONS, signal },
    );
    const score: CandidateScore = {
      url: page.url,
      companyName: parsed.companyName,
      score: parsed.score,
      description: parsed.description,
      fitReason: parsed.fitReason,
      location: extraction.jsonLdOrg?.address ?? null,
      founded: extraction.jsonLdOrg?.foundingDate ?? null,
    };
    return labelsToTranslate
      ? { ...score, labels: mergeLabelSet(labelsToTranslate, parsed.labels) }
      : score;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

/**
 * Run the match skill end to end: resolve candidates, quick-score each in
 * parallel, rank, and render the final report.
 * @param config LLM credentials
 * @param sellingContext product context, or null for a neutral judgment
 * @param candidates company names/URLs named directly in the message, or
 *   null to have the LLM suggest candidates
 * @param emit progress callback (phase/agent events)
 * @param requesterMessage the requester's own chat message, for language detection only
 * @param responseLanguage language recognized from the latest user message
 * @param runtimeLabels translated progress and scorecard labels
 * @param matchDirection whether candidates are buyers or sellers
 * @param matchLocation explicit geographic requirement, when supplied
 * @param signal cancels discovery and scoring work
 * @returns the report markdown, title, and localized card labels
 */
export async function runMatchSkill(
  config: LlmConfig,
  sellingContext: string | null,
  candidates: string[] | null,
  emit: EmitCallback,
  requesterMessage: string = "",
  responseLanguage: string = "English",
  runtimeLabels: RuntimeLabels = RUNTIME_LABEL_DEFAULTS,
  matchDirection: MatchDirection = "sell",
  matchLocation: string | null = null,
  signal?: AbortSignal,
): Promise<MatchSkillResult> {
  const candidatePool = await resolveMatchCandidatesStage(
    config,
    sellingContext,
    candidates,
    emit,
    requesterMessage,
    responseLanguage,
    runtimeLabels,
    matchDirection,
    matchLocation,
    signal,
  );
  const scoreBatch = await scoreMatchCandidatesStage(
    config,
    candidatePool,
    sellingContext,
    candidates,
    emit,
    requesterMessage,
    responseLanguage,
    runtimeLabels,
    matchDirection,
    matchLocation,
    signal,
  );
  return formatMatchSkillResult(
    candidatePool,
    scoreBatch,
    sellingContext,
    candidates,
    emit,
    runtimeLabels,
    matchDirection,
    matchLocation,
  );
}
