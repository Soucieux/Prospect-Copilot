/**
 * Prospect pipeline orchestrator - TS port of skills/sales-prospect/SKILL.md.
 * Phase 1 discovery (sequential fetch + extraction), Phase 2 five parallel
 * subagent LLM calls, Phase 3 deterministic scoring + LLM synthesis.
 */

import {
  chatCompletion,
  extractJsonObject,
  type LlmConfig,
  type LlmMessage,
} from "@/lib/llm";
import {
  SYNTHESIS_SCHEMA,
  type EmitCallback,
  type SubagentResult,
  type SynthesisResult,
} from "@/lib/agent/schemas";
import {
  SUBAGENTS,
  parseSubagentResult,
  subagentUserMessage,
} from "@/lib/skills/subagents";
import {
  computeProspectScore,
  scoreBant,
  type CategoryScores,
  type ProspectComposite,
  type ProspectSignals,
} from "@/lib/scoring/lead-scorer";
import { analyzeProspect } from "@/lib/extract/analyze-prospect";
import { findContacts, type ContactCandidate } from "@/lib/extract/contact-finder";
import { fetchPage, fetchWithVariants } from "@/lib/extract/fetch-page";
import { htmlToText } from "@/lib/extract/html-to-text";
import {
  NOT_PUBLICLY_AVAILABLE,
  RESPOND_IN_USER_LANGUAGE,
} from "@/lib/constants";

const SUBPAGE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "about", pattern: /\/(about|company|about-us)(\/|$)/i },
  { name: "team", pattern: /\/(team|leadership|people)(\/|$)/i },
  { name: "pricing", pattern: /\/(pricing|plans|packages)(\/|$)/i },
  { name: "careers", pattern: /\/(careers|jobs|join-us|hiring)(\/|$)/i },
  { name: "contact", pattern: /\/(contact|get-in-touch|demo)(\/|$)/i },
  { name: "blog", pattern: /\/(blog|resources|insights|news)(\/|$)/i },
];

const MAX_SUBPAGES = 6;
const PAGE_TEXT_BUDGET = 3_000;
const SYNTHESIS_PAGE_LIMIT = 4;
const SYNTHESIS_BRIEFING_CHAR_BUDGET = 8_000;
const MAX_CONTACTS_IN_REPORT = 10;

interface BriefingPage {
  name: string;
  url: string;
  text: string;
}

interface DiscoveryBriefing {
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

/**
 * Run the full prospect pipeline, streaming progress via emit.
 * @param config LLM credentials
 * @param rawUrl the prospect URL from the router
 * @param emit progress callback (phase/agent events)
 * @param sellingContext optional description of the seller's product/ICP,
 *   used to ground company-fit and competitive scoring
 * @returns final report markdown plus the structured score fields
 * @throws Error when the URL is entirely unreachable
 */
export async function runProspectPipeline(
  config: LlmConfig,
  rawUrl: string,
  emit: EmitCallback,
  sellingContext: string | null = null,
): Promise<{
  markdown: string;
  composite: ProspectComposite;
  companyName: string;
  url: string;
}> {
  emit({ type: "phase", phase: "discovery", detail: `Fetching ${rawUrl}` });
  const homepage = await fetchWithVariants(rawUrl);
  const extraction = analyzeProspect(homepage.html, homepage.url);

  emit({
    type: "phase",
    phase: "discovery",
    detail: "Fetching key subpages (about, team, pricing, careers, contact)",
  });
  const subpages = await fetchSubpages(extraction.internalLinks, homepage.url);

  const contacts = extractContacts(subpages, homepage.html);
  emit({
    type: "phase",
    phase: "discovery",
    detail: `Discovery complete - ${subpages.length + 1} pages, ${contacts.length} contacts found`,
  });

  const briefing: DiscoveryBriefing = {
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

  emit({ type: "phase", phase: "analysis", detail: "Launching 5 parallel analysis agents" });
  const results = await runSubagents(config, briefing, emit, sellingContext);

  const scores: CategoryScores = {};
  for (const [index, settled] of results.entries()) {
    const definition = SUBAGENTS[index];
    if (settled.status === "fulfilled") {
      scores[definition.category] = settled.value.score;
    }
  }
  const composite = computeProspectScore(scores);

  emit({
    type: "phase",
    phase: "synthesis",
    detail: `Synthesizing report - Prospect Score ${composite.score}/100 (${composite.grade})`,
  });
  let synthesis: SynthesisResult;
  try {
    synthesis = await runSynthesis(config, briefing, results, composite, sellingContext);
  } catch {
    emit({
      type: "phase",
      phase: "synthesis",
      detail: "Synthesis narrative unavailable - falling back to a deterministic summary",
    });
    synthesis = buildFallbackSynthesis(briefing, composite);
  }

  const markdown = assembleReport(
    briefing,
    results,
    composite,
    synthesis,
    scoreBant(buildSignals(briefing, contacts)),
    sellingContext,
  );

  return {
    markdown,
    composite,
    companyName: briefing.companyName ?? homepage.url,
    url: homepage.url,
  };
}

/**
 * Fetch up to MAX_SUBPAGES known-interesting subpages in parallel.
 * @param internalLinks same-origin links from the homepage
 * @param homepageUrl kept for signature symmetry; links are absolute
 * @returns fetched pages as bounded text plus raw HTML
 */
async function fetchSubpages(
  internalLinks: string[],
  _homepageUrl: string,
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
      const page = await fetchPage(url);
      return {
        name,
        url: page.url,
        text: htmlToText(page.html).slice(0, PAGE_TEXT_BUDGET),
        html: page.html,
      };
    }),
  );
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
 * @returns deduplicated contact candidates
 */
function extractContacts(
  subpages: (BriefingPage & { html: string })[],
  homepageHtml: string,
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
    for (const person of findContacts(source)) {
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
 * @returns settled results in SUBAGENTS order
 */
async function runSubagents(
  config: LlmConfig,
  briefing: DiscoveryBriefing,
  emit: EmitCallback,
  sellingContext: string | null,
): Promise<PromiseSettledResult<SubagentResult>[]> {
  const briefingJson = JSON.stringify(briefing);
  const userMessage = subagentUserMessage(briefingJson, sellingContext);
  const jobs = SUBAGENTS.map((definition) => {
    emit({ type: "agent", agent: definition.name, status: "running" });
    return chatCompletion(
      config,
      [
        { role: "system", content: definition.systemPrompt },
        { role: "user", content: userMessage },
      ],
      { temperature: 0.2, jsonMode: true },
    ).then((raw) => {
      const result = parseSubagentResult(raw);
      emit({
        type: "agent",
        agent: definition.name,
        status: "done",
        score: result.score,
      });
      return result;
    });
  });
  const guarded = jobs.map(async (job, index) => {
    try {
      return await job;
    } catch (caught) {
      emit({
        type: "agent",
        agent: SUBAGENTS[index]?.name ?? "unknown",
        status: "failed",
      });
      throw caught;
    }
  });
  return Promise.allSettled(guarded);
}

/**
 * Run the synthesis call that writes the narrative report sections.
 * @param config LLM credentials
 * @param briefing discovery briefing
 * @param results settled subagent results
 * @param composite deterministic composite score
 * @param sellingContext optional description of the seller's product/ICP
 * @returns validated synthesis sections
 */
async function runSynthesis(
  config: LlmConfig,
  briefing: DiscoveryBriefing,
  results: PromiseSettledResult<SubagentResult>[],
  composite: ProspectComposite,
  sellingContext: string | null,
): Promise<SynthesisResult> {
  const agentSummaries = SUBAGENTS.map((definition, index) => {
    const settled = results[index];
    const body =
      settled.status === "fulfilled"
        ? `score ${settled.value.score}/100 - ${settled.value.summary} recommendation: ${settled.value.recommendation}`
        : "analysis unavailable - neutral score assigned";
    return `${definition.name}: ${body}`;
  }).join("\n");
  const topContact = briefing.contacts[0];
  const messages: LlmMessage[] = [
    {
      role: "system",
      content: `You are the synthesis writer of a sales intelligence report. You receive a discovery briefing, five subagent verdicts, and a deterministic composite score. Write the narrative sections with absolute fidelity to the evidence: never invent facts, people, numbers, or events. The first email must be copy-paste ready, under 100 words, one low-friction CTA framed as a question, personalized with real data from the briefing. When the top contact is unknown, address it to the most plausible role and mark it clearly as unverified. When a WHAT WE SELL line is given in the user message, tailor the pitch and CTA specifically to that offering; when it is absent, keep the email focused on the prospect's own situation and do not invent or assume a specific product. ${RESPOND_IN_USER_LANGUAGE}

Respond with ONLY JSON of this shape:
{
  "executiveSummary": "3-5 sentence summary leading with the score and the single biggest opportunity and risk",
  "actionPlan": {"immediate": ["..."], "shortTerm": ["..."], "longTerm": ["..."]},
  "firstEmail": {"to": "Name, Title at Company", "subjectA": "...", "subjectB": "...", "body": "...", "cta": "..."}
}`,
    },
    {
      role: "user",
      content: `COMPOSITE SCORE: ${composite.score}/100 (${composite.grade}, confidence ${composite.confidence})
COMPANY: ${briefing.companyName ?? "Unknown"} - ${briefing.url}
${sellingContext ? `WHAT WE SELL: ${sellingContext}\n` : ""}TOP CONTACT: ${topContact ? `${topContact.name}, ${topContact.title ?? "title unknown"}` : "none found"}
SUBAGENT VERDICTS:
${agentSummaries}

DISCOVERY BRIEFING (excerpt):
${JSON.stringify({ ...briefing, pages: briefing.pages.slice(0, SYNTHESIS_PAGE_LIMIT) }).slice(0, SYNTHESIS_BRIEFING_CHAR_BUDGET)}`,
    },
  ];
  const raw = await chatCompletion(config, messages, {
    temperature: 0.3,
    jsonMode: true,
  });
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    throw new Error("Synthesis call returned no JSON object");
  }
  return SYNTHESIS_SCHEMA.parse(JSON.parse(jsonText));
}

/**
 * Build a deterministic stand-in for the synthesis narrative when that LLM
 * call fails or returns a schema-violating response. Keeps the discovery
 * briefing, subagent findings, and composite score from being discarded.
 * @param briefing discovery briefing
 * @param composite deterministic composite score
 * @returns a minimal but schema-valid synthesis result
 */
function buildFallbackSynthesis(
  briefing: DiscoveryBriefing,
  composite: ProspectComposite,
): SynthesisResult {
  const topContact = briefing.contacts[0];
  const contactLine = topContact
    ? `${topContact.name}, ${topContact.title ?? "title unknown"}`
    : NOT_PUBLICLY_AVAILABLE;
  const company = briefing.companyName ?? "this company";
  return {
    executiveSummary: `Prospect Score ${composite.score}/100 (Grade ${composite.grade}, ${composite.confidence} confidence). The synthesis writer could not produce a narrative for this run - see the per-agent findings below for the full evidence behind the score.`,
    actionPlan: {
      immediate: [
        "Review the per-agent findings below and confirm the top contact before reaching out.",
      ],
      shortTerm: [
        "Re-run the prospect audit once synthesis is available for a tailored action plan.",
      ],
      longTerm: ["Track this account for re-scoring as new signals appear."],
    },
    firstEmail: {
      to: contactLine,
      subjectA: `Quick question for ${company}`,
      subjectB: `${company} + us`,
      body: "Automated email drafting was unavailable for this run. Use the findings above to write a personalized first-touch email.",
      cta: "Open to a quick call this week?",
    },
  };
}

/**
 * Derive deterministic BANT signals from the briefing.
 * @param briefing discovery briefing
 * @param contacts extracted people
 * @returns the signal blob for scoreBant
 */
function buildSignals(
  briefing: DiscoveryBriefing,
  contacts: ContactCandidate[],
): ProspectSignals {
  const employees = briefing.jsonLdOrg?.numberOfEmployees;
  const employeeCount =
    typeof employees === "number"
      ? employees
      : typeof employees === "string"
        ? Number.parseInt(employees.replace(/\D/g, ""), 10) || undefined
        : undefined;
  return {
    employeeCount,
    hasPricingPage: briefing.hasPricingPage,
    enterpriseTierListed: briefing.enterpriseTierListed,
    decisionMakersFound: contacts.length,
    cSuiteIdentified: contacts.some((c) => c.seniority === "C-Suite"),
  };
}

/**
 * Assemble the final markdown report: deterministic tables first,
 * then the LLM narrative, then every subagent's detailed findings.
 * @param briefing discovery briefing
 * @param results settled subagent results
 * @param composite deterministic composite
 * @param synthesis LLM narrative sections
 * @param bant deterministic BANT result
 * @param sellingContext seller's product/ICP, when known
 * @returns the full report markdown
 */
function assembleReport(
  briefing: DiscoveryBriefing,
  results: PromiseSettledResult<SubagentResult>[],
  composite: ProspectComposite,
  synthesis: SynthesisResult,
  bant: ReturnType<typeof scoreBant>,
  sellingContext: string | null,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `# Prospect Analysis: ${briefing.companyName ?? briefing.url}`,
    "",
    `**URL:** ${briefing.url}  `,
    `**Date:** ${today}  `,
    `**Prospect Score:** ${composite.score}/100 (Grade ${composite.grade})  `,
    `**Confidence:** ${composite.confidence}`,
    "",
    "## Score Breakdown",
    "",
    "| Category | Score | Weight |",
    "|----------|-------|--------|",
  ];
  for (const row of composite.weighted) {
    lines.push(`| ${row.category} | ${row.score}/100 | ${Math.round(row.weight * 100)}% |`);
  }
  lines.push(
    `| **Total** | **${composite.score}/100** | **100%** |`,
    "",
    "## BANT Signals",
    "",
    "| Dimension | Score | Evidence |",
    "|-----------|-------|----------|",
  );
  for (const dimension of bant.dimensions) {
    lines.push(`| ${dimension.name} | ${dimension.score}/25 | ${dimension.evidence} |`);
  }
  lines.push(
    "",
    "## Executive Summary",
    "",
    synthesis.executiveSummary,
    "",
    "## Prioritized Action Plan",
    "",
    "### Immediate (Next 24-48 Hours)",
  );
  for (const action of synthesis.actionPlan.immediate) lines.push(`- ${action}`);
  lines.push("", "### Short-Term (Next 1-2 Weeks)");
  for (const action of synthesis.actionPlan.shortTerm) lines.push(`- ${action}`);
  lines.push("", "### Long-Term (Next 1-3 Months)");
  for (const action of synthesis.actionPlan.longTerm) lines.push(`- ${action}`);
  lines.push(
    "",
    "## Ready-to-Send First Email",
    "",
    `**To:** ${synthesis.firstEmail.to}  `,
    `**Subject A:** ${synthesis.firstEmail.subjectA}  `,
    `**Subject B:** ${synthesis.firstEmail.subjectB}`,
    "",
    synthesis.firstEmail.body,
    "",
    `**CTA:** ${synthesis.firstEmail.cta}`,
    "",
    "---",
    "",
  );
  if (briefing.contacts.length > 0) {
    lines.push(
      "## Decision Maker Map",
      "",
      "| Name | Title | Seniority | Buying Role | LinkedIn |",
      "|------|-------|-----------|-------------|----------|",
    );
    for (const contact of briefing.contacts.slice(0, MAX_CONTACTS_IN_REPORT)) {
      lines.push(
        `| ${contact.name} | ${contact.title ?? NOT_PUBLICLY_AVAILABLE} | ${contact.seniority} | ${contact.buyingRole} | ${contact.linkedin ?? "-"} |`,
      );
    }
    lines.push("", "---", "");
  }
  SUBAGENTS.forEach((definition, index) => {
    const settled = results[index];
    lines.push(`## ${definition.name} (${Math.round(definition.weight * 100)}%)`, "");
    if (settled.status === "fulfilled") {
      lines.push(
        settled.value.summary,
        "",
        "| Claim | Evidence | Confidence |",
        "|-------|----------|-------------|",
      );
      for (const finding of settled.value.findings) {
        lines.push(`| ${finding.claim} | ${finding.evidence} | ${finding.confidence} |`);
      }
      lines.push("", `**Recommendation:** ${settled.value.recommendation}`, "");
    } else {
      lines.push(
        `Analysis unavailable - neutral score assigned. Reason: ${String(settled.reason).slice(0, 200)}`,
        "",
      );
    }
  });
  if (composite.degradedCategories.length > 0) {
    lines.push(
      "---",
      "",
      `> Note: ${composite.degradedCategories.join(", ")} analysis was degraded; confidence reduced accordingly.`,
      "",
    );
  }
  if (!sellingContext) {
    lines.push(
      "---",
      "",
      "> Tell me what you sell (e.g. \"we sell payroll software for mid-market companies\") and I'll sharpen the Company Fit and Competitive Position scoring on your next request.",
      "",
    );
  }
  lines.push("*Generated by Prospect Copilot*");
  return lines.join("\n");
}
