/**
 * Prospect pipeline orchestrator - TS port of skills/sales-prospect/SKILL.md.
 * Phase 1 discovery (sequential fetch + extraction), Phase 2 five parallel
 * subagent LLM calls, Phase 3 deterministic scoring + LLM synthesis.
 */

import { WORKFLOW_PHASE } from "@/lib/workflow/constants";
import {
  structuredChatCompletion,
  type LlmConfig,
  type LlmMessage,
} from "@/lib/llm";
import {
  SUBAGENT_RESULT_SCHEMA,
  SYNTHESIS_SCHEMA,
  type EmitCallback,
  type SubagentResult,
  type SynthesisResult,
} from "@/lib/agent/schemas";
import {
  SUBAGENTS,
  subagentUserMessage,
  subagentOutcomes,
} from "@/lib/skills/subagents";
import {
  computeProspectScore,
  scoreBant,
  scoreMeddic,
  type CategoryScores,
  type MeddicResult,
  type ProspectComposite,
} from "@/lib/scoring/lead-scorer";
import { analyzeProspect } from "@/lib/extract/analyze-prospect";
import { findContacts, type ContactCandidate } from "@/lib/extract/contact-finder";
import { fetchPage, fetchWithVariants } from "@/lib/extract/fetch-page";
import { htmlToText } from "@/lib/extract/html-to-text";
import {
  RESPOND_IN_USER_LANGUAGE,
  UNTRUSTED_WEB_CONTENT_RULES,
} from "@/lib/constants";
import {
  RUNTIME_LABEL_DEFAULTS,
  formatRuntimeLabel,
  localizedAgentName,
  localizedCategoryName,
  localizedConfidence,
  mergeLabelSet,
  responseLanguageContext,
  type RuntimeLabels,
} from "@/lib/localization";
import {
  STRUCTURED_LLM_RETRY_OPTIONS,
  retryOperation,
} from "@/lib/retry";
import { runGraphWorkerPool } from "@/lib/graph-worker-pool";
import { emitAgentProgress } from "@/lib/agent/progress";
import {
  PROSPECT_REPORT_LABELS,
  assembleLocalizedFallbackReport,
  assembleReport,
} from "@/lib/agent/prospect-report";
import { buildProspectSignals } from "@/lib/scoring/prospect-signals";

// The terminator accepts ? and # as well as / and end-of-string: marketing
// sites routinely hang tracking parameters off their own nav links, and
// requiring a bare path silently dropped those pages from discovery.
export const SUBPAGE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "about", pattern: /\/(about|company|about-us)(\/|\?|#|$)/i },
  { name: "team", pattern: /\/(team|leadership|people)(\/|\?|#|$)/i },
  { name: "pricing", pattern: /\/(pricing|plans|packages)(\/|\?|#|$)/i },
  { name: "careers", pattern: /\/(careers|jobs|join-us|hiring)(\/|\?|#|$)/i },
  { name: "contact", pattern: /\/(contact|get-in-touch|demo)(\/|\?|#|$)/i },
  { name: "blog", pattern: /\/(blog|resources|insights|news)(\/|\?|#|$)/i },
];

const MAX_SUBPAGES = 6;
const PAGE_TEXT_BUDGET = 3_000;
const SYNTHESIS_PAGE_LIMIT = 4;
const SYNTHESIS_BRIEFING_CHAR_BUDGET = 8_000;
// The same briefing is sent to all five workers at once, so it is bounded
// here as well; without this one contact-heavy page inflates five prompts.
const SUBAGENT_BRIEFING_CHAR_BUDGET = 12_000;

interface BriefingPage {
  name: string;
  url: string;
  text: string;
}

export interface DiscoveryBriefing {
  url: string;
  companyName: string | null;
  title: string | null;
  description: string | null;
  techStack: string[];
  socialProfiles: string[];
  emails: string[];
  hasPricingPage: boolean;
  enterpriseTierListed: boolean;
  jsonLdOrg: {
    name?: string;
    foundingDate?: string;
    numberOfEmployees?: number | string;
    address?: string;
  } | null;
  pages: BriefingPage[];
  contacts: ContactCandidate[];
}

/** Settled output from the five fixed prospect-analysis workers. */
export type ProspectAnalysisResults = PromiseSettledResult<SubagentResult>[];

/** Deterministic scores calculated after prospect analysis completes. */
export interface ProspectScoreState {
  composite: ProspectComposite;
  bant: ReturnType<typeof scoreBant>;
  meddic: MeddicResult;
}

/** Final business result consumed by the workflow report node. */
export interface ProspectPipelineOutcome {
  markdown: string;
  composite: ProspectComposite;
  companyName: string;
  url: string;
  categoryLabels: string[];
  confidenceLabel: string;
}

/**
 * Discover and bound the public company evidence used by later graph stages.
 * @param rawUrl prospect URL selected by the router
 * @param emit progress callback
 * @param runtimeLabels localized progress labels
 * @param signal cancels page discovery
 * @returns serializable prospect briefing
 */
export async function discoverProspect(
  rawUrl: string,
  emit: EmitCallback,
  runtimeLabels: RuntimeLabels = RUNTIME_LABEL_DEFAULTS,
  signal?: AbortSignal,
): Promise<DiscoveryBriefing> {
  emit({
    type: "phase",
    phase: WORKFLOW_PHASE.discovery,
    detail: formatRuntimeLabel(runtimeLabels.fetchingTemplate, { target: rawUrl }),
  });
  const homepage = await fetchWithVariants(rawUrl, signal);
  const extraction = analyzeProspect(homepage.html, homepage.url);

  emit({
    type: "phase",
    phase: WORKFLOW_PHASE.discovery,
    detail: runtimeLabels.fetchingSubpages,
  });
  const subpages = await fetchSubpages(extraction.internalLinks, signal);
  const contacts = extractContacts(
    subpages,
    homepage.html,
    extraction.companyName,
  );
  emit({
    type: "phase",
    phase: WORKFLOW_PHASE.discovery,
    detail: formatRuntimeLabel(runtimeLabels.discoveryCompleteTemplate, {
      pages: subpages.length + 1,
      contacts: contacts.length,
    }),
  });
  return {
    url: homepage.url,
    companyName: extraction.companyName,
    title: extraction.title,
    description: extraction.description,
    techStack: extraction.techStack,
    socialProfiles: extraction.socialProfiles,
    emails: extraction.emails,
    hasPricingPage: extraction.hasPricingPage,
    enterpriseTierListed: extraction.enterpriseTierListed,
    jsonLdOrg: extraction.jsonLdOrg,
    pages: [
      {
        name: "homepage",
        url: homepage.url,
        text: htmlToText(homepage.html).slice(0, PAGE_TEXT_BUDGET),
      },
      ...subpages.map((page) => ({
        name: page.name,
        url: page.url,
        text: page.text,
      })),
    ],
    contacts,
  };
}

/**
 * Run the five fixed analysis workers for one discovered prospect.
 * @param config LLM credentials
 * @param briefing bounded public company evidence
 * @param emit progress callback
 * @param sellingContext optional seller product or ICP
 * @param requesterMessage latest user message
 * @param responseLanguage detected response language
 * @param runtimeLabels localized progress labels
 * @param signal cancels analysis workers
 * @returns settled worker outcomes in fixed category order
 */
export async function analyzeProspectBriefing(
  config: LlmConfig,
  briefing: DiscoveryBriefing,
  emit: EmitCallback,
  sellingContext: string | null,
  requesterMessage: string,
  responseLanguage: string,
  runtimeLabels: RuntimeLabels,
  signal?: AbortSignal,
): Promise<ProspectAnalysisResults> {
  emit({
    type: "phase",
    phase: WORKFLOW_PHASE.analysis,
    detail: runtimeLabels.launchingAgents,
  });
  return runSubagents(
    config,
    briefing,
    emit,
    sellingContext,
    requesterMessage,
    responseLanguage,
    runtimeLabels,
    signal,
  );
}

/**
 * Calculate deterministic composite and BANT scores from completed analysis.
 * @param briefing bounded discovery evidence
 * @param results settled analysis results
 * @returns deterministic score state
 */
export function scoreProspectBriefing(
  briefing: DiscoveryBriefing,
  results: ProspectAnalysisResults,
): ProspectScoreState {
  const scores: CategoryScores = {};
  let discoverySignals: SubagentResult["discoverySignals"];
  for (const { definition, settled } of subagentOutcomes(results)) {
    if (settled.status === "fulfilled") {
      scores[definition.category] = settled.value.score;
      if (settled.value.discoverySignals) {
        discoverySignals = {
          ...discoverySignals,
          ...settled.value.discoverySignals,
        };
      }
    }
  }
  const signals = buildProspectSignals(
    briefing,
    briefing.contacts,
    discoverySignals,
  );
  return {
    composite: computeProspectScore(scores),
    bant: scoreBant(signals),
    meddic: scoreMeddic(signals),
  };
}

/**
 * Produce the optional localized narrative synthesis for one scored prospect.
 * @param config LLM credentials
 * @param briefing bounded discovery evidence
 * @param results settled analysis results
 * @param scoreState deterministic prospect scores
 * @param emit progress callback
 * @param sellingContext optional seller product or ICP
 * @param requesterMessage latest user message
 * @param responseLanguage detected response language
 * @param runtimeLabels localized progress labels
 * @param signal cancels synthesis and backoff
 * @returns validated synthesis, or null after the bounded fallback policy
 */
export async function synthesizeProspectBriefing(
  config: LlmConfig,
  briefing: DiscoveryBriefing,
  results: ProspectAnalysisResults,
  scoreState: ProspectScoreState,
  emit: EmitCallback,
  sellingContext: string | null,
  requesterMessage: string,
  responseLanguage: string,
  runtimeLabels: RuntimeLabels,
  signal?: AbortSignal,
): Promise<SynthesisResult | null> {
  emit({
    type: "phase",
    phase: WORKFLOW_PHASE.synthesis,
    detail: formatRuntimeLabel(runtimeLabels.synthesizingTemplate, {
      score: scoreState.composite.score,
      grade: scoreState.composite.grade,
    }),
  });
  try {
    return await retryOperation(
      () =>
        runSynthesis(
          config,
          briefing,
          results,
          scoreState.composite,
          scoreState.bant,
          sellingContext,
          requesterMessage,
          responseLanguage,
          signal,
        ),
      { ...STRUCTURED_LLM_RETRY_OPTIONS, signal },
    );
  } catch {
    signal?.throwIfAborted();
    emit({
      type: "phase",
      phase: WORKFLOW_PHASE.synthesis,
      detail: runtimeLabels.synthesisUnavailable,
    });
    return null;
  }
}

/**
 * Format the final prospect result from completed graph-stage state.
 * @param briefing bounded discovery evidence
 * @param results settled analysis results
 * @param scoreState deterministic prospect scores
 * @param synthesis optional localized synthesis
 * @param sellingContext optional seller product or ICP
 * @param runtimeLabels localized report labels
 * @returns final business result used to construct ReportState
 */
export function formatProspectOutcome(
  briefing: DiscoveryBriefing,
  results: ProspectAnalysisResults,
  scoreState: ProspectScoreState,
  synthesis: SynthesisResult | null,
  sellingContext: string | null,
  runtimeLabels: RuntimeLabels,
): ProspectPipelineOutcome {
  const markdown = synthesis
    ? assembleReport(
        briefing,
        results,
        scoreState.composite,
        synthesis,
        scoreState.bant,
        sellingContext,
        runtimeLabels,
        scoreState.meddic,
      )
    : assembleLocalizedFallbackReport(
        briefing,
        results,
        scoreState.composite,
        runtimeLabels,
      );
  return {
    markdown,
    composite: scoreState.composite,
    companyName: briefing.companyName ?? briefing.url,
    url: briefing.url,
    categoryLabels: scoreState.composite.weighted.map((row) =>
      localizedCategoryName(runtimeLabels, row.category),
    ),
    confidenceLabel: localizedConfidence(
      runtimeLabels,
      scoreState.composite.confidence,
    ),
  };
}

/**
 * Fetch up to MAX_SUBPAGES known-interesting subpages in parallel.
 * @param internalLinks same-origin links from the homepage
 * @param signal cancels outstanding page requests
 * @returns fetched pages as bounded text plus raw HTML
 */
async function fetchSubpages(
  internalLinks: string[],
  signal?: AbortSignal,
): Promise<(BriefingPage & { html: string })[]> {
  const picked = new Map<string, string>();
  for (const { name, pattern } of SUBPAGE_PATTERNS) {
    const link = internalLinks.find((candidate) => pattern.test(candidate));
    if (link && !picked.has(name)) {
      picked.set(name, link);
    }
  }
  const settled = await Promise.allSettled(
    [...picked.entries()].slice(0, MAX_SUBPAGES).map(async ([name, url]) => {
      const page = await fetchPage(url, signal);
      return {
        name,
        url: page.url,
        text: htmlToText(page.html).slice(0, PAGE_TEXT_BUDGET),
        html: page.html,
      };
    }),
  );
  signal?.throwIfAborted();
  return settled
    .filter(
      (result): result is PromiseFulfilledResult<BriefingPage & { html: string }> =>
        result.status === "fulfilled",
    )
    .map((result) => result.value);
}

/**
 * Extract people from team pages, falling back to the homepage.
 * @param subpages fetched subpages with raw HTML
 * @param homepageHtml raw homepage HTML
 * @param companyName the prospect's own name, used to drop outside people
 * @returns deduplicated contact candidates
 */
function extractContacts(
  subpages: (BriefingPage & { html: string })[],
  homepageHtml: string,
  companyName: string | null,
): ContactCandidate[] {
  const teamPages = subpages.filter(
    (page) => page.name === "team" || page.name === "about",
  );
  const sources =
    teamPages.length > 0
      ? teamPages.map((page) => page.html)
      : [homepageHtml];
  const byName = new Map<string, ContactCandidate>();
  for (const source of sources) {
    for (const person of findContacts(source, companyName)) {
      const key = person.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, person);
    }
  }
  return [...byName.values()];
}

/**
 * Run all five subagents in parallel, emitting per-agent progress.
 * @param config LLM credentials
 * @param briefing the discovery briefing
 * @param emit progress callback
 * @param sellingContext optional description of the seller's product/ICP
 * @param requesterMessage the requester's own chat message, for language detection only
 * @param responseLanguage language recognized from the latest user message
 * @param runtimeLabels translated agent progress labels
 * @param signal cancels all subagent requests
 * @returns settled results in SUBAGENTS order
 */
async function runSubagents(
  config: LlmConfig,
  briefing: DiscoveryBriefing,
  emit: EmitCallback,
  sellingContext: string | null,
  requesterMessage: string,
  responseLanguage: string,
  runtimeLabels: RuntimeLabels,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<SubagentResult>[]> {
  const briefingJson = JSON.stringify(briefing).slice(
    0,
    SUBAGENT_BRIEFING_CHAR_BUDGET,
  );
  const promptContent = subagentUserMessage(
    briefingJson,
    sellingContext,
    requesterMessage,
    responseLanguage,
  );
  const results = await runGraphWorkerPool(
    SUBAGENTS,
    SUBAGENTS.length,
    async (definition): Promise<PromiseSettledResult<SubagentResult>> => {
      const displayName = localizedAgentName(runtimeLabels, definition.name);
      emitAgentProgress(emit, runtimeLabels, displayName, "running");
      try {
        const result = await retryOperation(
          () =>
            structuredChatCompletion(
              config,
              [
                { role: "system", content: definition.systemPrompt },
                { role: "user", content: promptContent },
              ],
              SUBAGENT_RESULT_SCHEMA,
              {
                temperature: 0.2,
                schemaName: "prospect_subagent_result",
                signal,
              },
            ),
          { ...STRUCTURED_LLM_RETRY_OPTIONS, signal },
        );
        emitAgentProgress(
          emit,
          runtimeLabels,
          displayName,
          "done",
          result.score,
        );
        return { status: "fulfilled", value: result };
      } catch {
        signal?.throwIfAborted();
        emitAgentProgress(emit, runtimeLabels, displayName, "failed");
        return { status: "rejected", reason: "analysis_unavailable" };
      }
    },
    signal,
  );
  signal?.throwIfAborted();
  return results;
}

/**
 * Run the synthesis call that writes the narrative report sections.
 * @param config LLM credentials
 * @param briefing discovery briefing
 * @param results settled subagent results
 * @param composite deterministic composite score
 * @param bant deterministic BANT rows whose display text must be localized
 * @param sellingContext optional description of the seller's product/ICP
 * @param requesterMessage the requester's own chat message, for language detection only
 * @param responseLanguage language recognized from the latest user message
 * @param signal cancels synthesis
 * @returns validated synthesis sections
 */
async function runSynthesis(
  config: LlmConfig,
  briefing: DiscoveryBriefing,
  results: PromiseSettledResult<SubagentResult>[],
  composite: ProspectComposite,
  bant: ReturnType<typeof scoreBant>,
  sellingContext: string | null,
  requesterMessage: string,
  responseLanguage: string,
  signal?: AbortSignal,
): Promise<SynthesisResult> {
  const agentSummaries = subagentOutcomes(results)
    .map(({ definition, settled }) => {
      const body =
        settled.status === "fulfilled"
          ? `score ${settled.value.score}/100 - ${settled.value.summary} recommendation: ${settled.value.recommendation}`
          : "analysis unavailable - neutral score assigned";
      return `${definition.name}: ${body}`;
    })
    .join("\n");
  const topContact = briefing.contacts[0];
  const messages: LlmMessage[] = [
    {
      role: "system",
      content: `You are the synthesis writer of a sales intelligence report. You receive a discovery briefing, five subagent verdicts, and a deterministic composite score. Write the narrative sections with absolute fidelity to the evidence: never invent facts, people, numbers, or events. ${UNTRUSTED_WEB_CONTENT_RULES} The first email must be copy-paste ready, under 100 words, one low-friction CTA framed as a question, personalized with real data from the briefing. When the top contact is unknown, address it to the most plausible role and mark it clearly as unverified. When a WHAT WE SELL line is given in the user message, tailor the pitch and CTA specifically to that offering; when it is absent, keep the email focused on the prospect's own situation and do not invent or assume a specific product. ${RESPOND_IN_USER_LANGUAGE}
The user message also includes a LABELS object: a fixed set of short report section labels. Translate each of its values into the same language as everything above (echo unchanged if that's already English) and return it under "labels" with the exact same keys - never add, remove, or rename keys, and never translate product or brand names.
It also includes four BANT rows. Translate only each row's name and evidence without changing their order, scores, meaning, or factual content, and return those translations under "bantTranslations".

Respond with ONLY JSON of this shape:
{
  "executiveSummary": "3-5 sentence summary leading with the score and the single biggest opportunity and risk",
  "actionPlan": {"immediate": ["..."], "shortTerm": ["..."], "longTerm": ["..."]},
  "firstEmail": {"to": "Name, Title at Company", "subjectA": "...", "subjectB": "...", "body": "...", "cta": "..."},
  "bantTranslations": [{"name": "...", "evidence": "..."}, {"name": "...", "evidence": "..."}, {"name": "...", "evidence": "..."}, {"name": "...", "evidence": "..."}],
  "labels": {...same keys as the given LABELS object, translated}
}`,
    },
    {
      role: "user",
      content: `${responseLanguageContext(responseLanguage, requesterMessage)}\n\nCOMPOSITE SCORE: ${composite.score}/100 (${composite.grade}, confidence ${composite.confidence})
COMPANY: ${briefing.companyName ?? "Unknown"} - ${briefing.url}
${sellingContext ? `WHAT WE SELL: ${sellingContext}\n` : ""}TOP CONTACT: ${topContact ? `${topContact.name}, ${topContact.title ?? "title unknown"}` : "none found"}
SUBAGENT VERDICTS:
${agentSummaries}

LABELS: ${JSON.stringify(PROSPECT_REPORT_LABELS)}
BANT ROWS: ${JSON.stringify(bant.dimensions.map((dimension) => ({ name: dimension.name, evidence: dimension.evidence })))}

DISCOVERY BRIEFING (excerpt):
${JSON.stringify({ ...briefing, pages: briefing.pages.slice(0, SYNTHESIS_PAGE_LIMIT) }).slice(0, SYNTHESIS_BRIEFING_CHAR_BUDGET)}`,
    },
  ];
  const parsed = await structuredChatCompletion(
    config,
    messages,
    SYNTHESIS_SCHEMA,
    { temperature: 0.3, schemaName: "prospect_synthesis", signal },
  );
  return {
    ...parsed,
    labels: mergeLabelSet(PROSPECT_REPORT_LABELS, parsed.labels),
  };
}
