/**
 * Prospect pipeline orchestrator - TS port of skills/sales-prospect/SKILL.md.
 * Phase 1 discovery (sequential fetch + extraction), Phase 2 five parallel
 * subagent LLM calls, Phase 3 deterministic scoring + LLM synthesis.
 */

import {
  CHAT_PHASE,
  SUBAGENT_RESULT_SCHEMA,
  SYNTHESIS_SCHEMA,
  type EmitCallback,
  type SubagentResult,
  type SynthesisResult,
} from "@/lib/agent/schemas";
import {
  STRUCTURED_LLM_RETRY_OPTIONS,
  structuredChatCompletion,
  type LlmConfig,
  type LlmMessage,
} from "@/lib/llm";
import {
  SUBAGENTS,
  subagentUserMessage,
  subagentOutcomes,
} from "@/lib/skills/subagents";
import {
  NEUTRAL_CATEGORY_SCORE,
  computeProspectScore,
  scoreBant,
  scoreMeddic,
  type BantResult,
  type CategoryScores,
  type MeddicResult,
  type ProspectComposite,
} from "@/lib/scoring/lead-scorer";
import {
  SUBPAGE_PATTERNS,
  analyzeProspect,
  loadPage,
  type ProspectExtraction,
} from "@/lib/extract/analyze-prospect";
import {
  findContacts,
  normalizeName,
  type ContactCandidate,
} from "@/lib/extract/contact-finder";
import { fetchPage, fetchWithVariants } from "@/lib/extract/fetch-page";
import { htmlToText } from "@/lib/extract/html-to-text";
import {
  RESPOND_IN_USER_LANGUAGE,
  SELLING_CONTEXT_MARKER,
  UNTRUSTED_WEB_CONTENT_RULES,
} from "@/lib/constants";
import {
  formatRuntimeLabel,
  localizedAgentName,
  localizedCategoryName,
  localizedConfidence,
  responseLanguageContext,
  type RuntimeLabels,
} from "@/lib/localization";
import { retryOperation } from "@/lib/retry";
import { runGraphWorkerPool } from "@/lib/graph-worker-pool";
import { emitAgentProgress } from "@/lib/agent/progress";
import {
  PROSPECT_REPORT_LABELS,
  assembleLocalizedFallbackReport,
  assembleReport,
} from "@/lib/agent/prospect-report";
import {
  buildProspectSignals,
  type DiscoverySignals,
} from "@/lib/scoring/prospect-signals";
import type { ReportState } from "@/lib/chat-types";

const PAGE_TEXT_BUDGET = 3_000;
const SYNTHESIS_PAGE_LIMIT = 4;
const SYNTHESIS_BRIEFING_CHAR_BUDGET = 8_000;
// The same briefing is sent to all five workers at once, so it is bounded
// here as well; without this one contact-heavy page inflates five prompts.
const SUBAGENT_BRIEFING_CHAR_BUDGET = 12_000;

/** Subpages whose markup lists people; the others contribute text only. */
const CONTACT_PAGE_NAMES = new Set(["team", "about"]);

interface BriefingPage {
  name: string;
  url: string;
  text: string;
}

/** A fetched subpage, with contacts read only from the pages that list people. */
interface FetchedSubpage extends BriefingPage {
  contacts: ContactCandidate[] | null;
}

/** The homepage extraction fields the briefing carries forward, plus its pages. */
export interface DiscoveryBriefing
  extends Pick<
    ProspectExtraction,
    | "companyName"
    | "title"
    | "description"
    | "techStack"
    | "socialProfiles"
    | "emails"
    | "hasPricingPage"
    | "enterpriseTierListed"
    | "jsonLdOrg"
    | "employeeCount"
  > {
  url: string;
  pages: BriefingPage[];
  contacts: ContactCandidate[];
}

/** Settled output from the five fixed prospect-analysis workers. */
export type ProspectAnalysisResults = PromiseSettledResult<SubagentResult>[];

/** Deterministic scores calculated after prospect analysis completes. */
export interface ProspectScoreState {
  composite: ProspectComposite;
  bant: BantResult;
  meddic: MeddicResult;
}

/** Final business result consumed by the workflow report node. */
export interface ProspectPipelineOutcome {
  markdown: string;
  composite: ProspectComposite;
  companyName: string;
  url: string;
  /** The weighted rows with their category names localized for display. */
  categories: NonNullable<ReportState["categories"]>;
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
  runtimeLabels: RuntimeLabels,
  signal?: AbortSignal,
): Promise<DiscoveryBriefing> {
  emit({
    type: "phase",
    phase: CHAT_PHASE.discovery,
    detail: formatRuntimeLabel(runtimeLabels.fetchingTemplate, { target: rawUrl }),
  });
  const homepage = await fetchWithVariants(rawUrl, signal);
  const $ = loadPage(homepage.html);
  const extraction = analyzeProspect(homepage.html, homepage.url, $);

  emit({
    type: "phase",
    phase: CHAT_PHASE.discovery,
    detail: runtimeLabels.fetchingSubpages,
  });
  const subpages = await fetchSubpages(
    extraction.internalLinks,
    extraction.companyName,
    signal,
  );
  const contacts = mergeContacts(
    subpages.some((page) => page.contacts !== null)
      ? subpages.flatMap((page) => page.contacts ?? [])
      : findContacts(homepage.html, extraction.companyName, $),
  );
  emit({
    type: "phase",
    phase: CHAT_PHASE.discovery,
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
    employeeCount: extraction.employeeCount,
    pages: [
      {
        name: "homepage",
        url: homepage.url,
        text: htmlToText(homepage.html, $).slice(0, PAGE_TEXT_BUDGET),
      },
      ...subpages.map(({ name, url, text }) => ({ name, url, text })),
    ],
    contacts,
  };
}

/**
 * Run the five fixed analysis workers in parallel for one discovered
 * prospect, emitting per-agent progress.
 * @param config LLM credentials
 * @param briefing bounded public company evidence
 * @param emit progress callback
 * @param sellingContext optional seller product or ICP
 * @param requesterMessage the requester's own chat message, for language detection only
 * @param responseLanguage language recognized from the latest user message
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
    phase: CHAT_PHASE.analysis,
    detail: runtimeLabels.launchingAgents,
  });
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
      const displayName = localizedAgentName(runtimeLabels, definition.category);
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
 * Calculate deterministic composite and BANT scores from completed analysis.
 * Competitive position is only meaningful against a known product, so
 * without one it scores neutral here rather than trusting the worker to.
 * @param briefing bounded discovery evidence
 * @param results settled analysis results
 * @param sellingContext the seller's product or ICP, when the user gave one
 * @returns deterministic score state
 */
export function scoreProspectBriefing(
  briefing: DiscoveryBriefing,
  results: ProspectAnalysisResults,
  sellingContext: string | null = null,
): ProspectScoreState {
  const scores: CategoryScores = {};
  let discoverySignals: DiscoverySignals | undefined;
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
  if (!sellingContext && scores.competitivePosition !== undefined) {
    scores.competitivePosition = NEUTRAL_CATEGORY_SCORE;
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
    phase: CHAT_PHASE.synthesis,
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
      phase: CHAT_PHASE.synthesis,
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
    categories: scoreState.composite.weighted.map((row) => ({
      ...row,
      category: localizedCategoryName(runtimeLabels, row.category),
    })),
    confidenceLabel: localizedConfidence(
      runtimeLabels,
      scoreState.composite.confidence,
    ),
  };
}

/**
 * Fetch the first link matching each subpage pattern, in parallel. A page
 * that fails or answers with an error status is simply absent from the
 * briefing; its text is never read as evidence.
 * @param internalLinks same-origin links from the homepage
 * @param companyName the prospect's own name, used to drop outside people
 * @param signal cancels outstanding page requests
 * @returns fetched pages as bounded text, with contacts from the people pages
 */
async function fetchSubpages(
  internalLinks: string[],
  companyName: string | null,
  signal?: AbortSignal,
): Promise<FetchedSubpage[]> {
  const picked = SUBPAGE_PATTERNS.flatMap(({ name, pattern }) => {
    const url = internalLinks.find((candidate) => pattern.test(candidate));
    return url ? [{ name, url }] : [];
  });
  const settled = await Promise.allSettled(
    picked.map(async ({ name, url }): Promise<FetchedSubpage> => {
      const page = await fetchPage(url, signal);
      const $ = loadPage(page.html);
      const contacts = CONTACT_PAGE_NAMES.has(name)
        ? findContacts(page.html, companyName, $)
        : null;
      return {
        name,
        url: page.url,
        text: htmlToText(page.html, $).slice(0, PAGE_TEXT_BUDGET),
        contacts,
      };
    }),
  );
  signal?.throwIfAborted();
  return settled
    .filter(
      (result): result is PromiseFulfilledResult<FetchedSubpage> =>
        result.status === "fulfilled",
    )
    .map((result) => result.value);
}

/**
 * Collapse the same person found on several pages into one contact.
 * @param contacts people found across the fetched pages, in page order
 * @returns the first occurrence of each person
 */
function mergeContacts(contacts: ContactCandidate[]): ContactCandidate[] {
  const byName = new Map<string, ContactCandidate>();
  for (const person of contacts) {
    const key = normalizeName(person.name);
    if (!byName.has(key)) byName.set(key, person);
  }
  return [...byName.values()];
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
  bant: BantResult,
  sellingContext: string | null,
  requesterMessage: string,
  responseLanguage: string,
  signal?: AbortSignal,
): Promise<SynthesisResult> {
  const agentSummaries = subagentOutcomes(results)
    .map(({ definition, settled }) => {
      // The effective score, so the synthesis reads the same number the
      // report's breakdown table shows even where scoring overrode a worker.
      const score =
        composite.weighted.find((row) => row.category === definition.category)
          ?.score ?? NEUTRAL_CATEGORY_SCORE;
      const body =
        settled.status === "fulfilled"
          ? `score ${score}/100 - ${settled.value.summary} recommendation: ${settled.value.recommendation}`
          : "analysis unavailable - neutral score assigned";
      return `${definition.name}: ${body}`;
    })
    .join("\n");
  const topContact = briefing.contacts[0];
  const messages: LlmMessage[] = [
    {
      role: "system",
      content: `You are the synthesis writer of a sales intelligence report. You receive a discovery briefing, five subagent verdicts, and a deterministic composite score. Write the narrative sections with absolute fidelity to the evidence: never invent facts, people, numbers, or events. ${UNTRUSTED_WEB_CONTENT_RULES} The first email must be copy-paste ready, under 100 words, one low-friction CTA framed as a question, personalized with real data from the briefing. When the top contact is unknown, address it to the most plausible role and mark it clearly as unverified. When a ${SELLING_CONTEXT_MARKER} line is given in the user message, tailor the pitch and CTA specifically to that offering; when it is absent, keep the email focused on the prospect's own situation and do not invent or assume a specific product. ${RESPOND_IN_USER_LANGUAGE}
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
${sellingContext ? `${SELLING_CONTEXT_MARKER}: ${sellingContext}\n` : ""}TOP CONTACT: ${topContact ? `${topContact.name}, ${topContact.title ?? "title unknown"}` : "none found"}
SUBAGENT VERDICTS:
${agentSummaries}

LABELS: ${JSON.stringify(PROSPECT_REPORT_LABELS)}
BANT ROWS: ${JSON.stringify(bant.dimensions.map((dimension) => ({ name: dimension.name, evidence: dimension.evidence })))}

DISCOVERY BRIEFING (excerpt):
${JSON.stringify({ ...briefing, pages: briefing.pages.slice(0, SYNTHESIS_PAGE_LIMIT) }).slice(0, SYNTHESIS_BRIEFING_CHAR_BUDGET)}`,
    },
  ];
  // The labels are completed where the report reads them, not here.
  return structuredChatCompletion(config, messages, SYNTHESIS_SCHEMA, {
    temperature: 0.3,
    schemaName: "prospect_synthesis",
    signal,
  });
}
