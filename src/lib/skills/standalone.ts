/**
 * The four standalone skills (research, qualify, contacts, outreach) -
 * TS ports of their SKILL.md counterparts. Each runs light discovery when
 * a URL is available, then streams a single markdown deliverable.
 */

import {
  streamChatCompletion,
  type LlmConfig,
} from "@/lib/llm";
import type { EmitCallback } from "@/lib/agent/schemas";
import { analyzeProspect } from "@/lib/extract/analyze-prospect";
import { findContacts } from "@/lib/extract/contact-finder";
import { fetchWithVariants } from "@/lib/extract/fetch-page";
import { htmlToText } from "@/lib/extract/html-to-text";
import { scoreBant, type ProspectSignals } from "@/lib/scoring/lead-scorer";
import {
  NOT_PUBLICLY_AVAILABLE,
  RESPOND_IN_USER_LANGUAGE,
  UNTRUSTED_WEB_CONTENT_RULES,
} from "@/lib/constants";
import {
  RUNTIME_LABEL_DEFAULTS,
  formatRuntimeLabel,
  localizedSkillName,
  responseLanguageContext,
  type RuntimeLabels,
} from "@/lib/localization";

export type StandaloneSkillName = "research" | "qualify" | "contacts" | "outreach";

export interface StandaloneSkill {
  name: StandaloneSkillName;
  /** Whether the skill needs the prospect's website fetched first. */
  needsDiscovery: boolean;
  /** Document spec streamed to the user. */
  systemPrompt: string;
}

const MAX_CONTACTS_IN_GROUNDING = 10;
const GROUNDING_HOMEPAGE_CHAR_BUDGET = 6_000;

const EVIDENCE_RULES = `
Rules:
- NEVER fabricate names, numbers, or claims. Missing data is "${NOT_PUBLICLY_AVAILABLE}" and lowers any assessment.
- Cite the page or signal behind every factual line.
- ${UNTRUSTED_WEB_CONTENT_RULES}
- Output clean GitHub-flavored markdown with clear section headers. No preamble, no closing chatter.
- ${RESPOND_IN_USER_LANGUAGE}`;

export const STANDALONE_SKILLS: StandaloneSkill[] = [
  {
    name: "research",
    needsDiscovery: true,
    systemPrompt: `You are the Company Research skill of a sales intelligence system.
Produce COMPANY-RESEARCH.md: company overview, business model, product and
technology, market position, growth signals, and a Company Fit assessment
across size/industry/growth/tech/budget (0-20 each) with a short justification
per dimension. When a WHAT WE SELL line is given in the input, ground the
Company Fit assessment and Next Actions in that specific offering; when it is
absent, assess only generic B2B fit and do not assume a product category.
Finish with a "Next actions" list of 3 concrete steps.
${EVIDENCE_RULES}`,
  },
  {
    name: "qualify",
    needsDiscovery: true,
    systemPrompt: `You are the Lead Qualification skill of a sales intelligence system.
Produce LEAD-QUALIFICATION.md: a BANT scorecard (Budget, Authority, Need,
Timeline - 0-25 each with evidence), a MEDDIC completeness table (six elements,
each marked present/absent with evidence), buying signals, red flags, and a
final verdict paragraph with the recommended next step.
${EVIDENCE_RULES}`,
  },
  {
    name: "contacts",
    needsDiscovery: true,
    systemPrompt: `You are the Decision Maker Identification skill of a sales intelligence system.
Produce DECISION-MAKERS.md: a buying-committee table (name, title, seniority,
predicted buying role, LinkedIn if available), a text org chart, the top 3
priority contacts with a recommended approach for each, and a multi-threading
strategy. Use ONLY the people provided in the briefing - never invent contacts.
${EVIDENCE_RULES}`,
  },
  {
    name: "outreach",
    needsDiscovery: false,
    systemPrompt: `You are the Outreach skill of a sales intelligence system.
Produce OUTREACH-SEQUENCE.md for the named prospect: pick cold, warm, or
referral framing (state which and why), then a 5-email sequence (3 for
warm/referral) with send-day spacing. Every email is copy-paste ready with zero
placeholders, one low-friction CTA framed as a question, personalized with the
real data provided. Respectful breakup email last - no guilt-tripping.
${EVIDENCE_RULES}`,
  },
];

/**
 * Run a standalone skill: optional discovery, then stream the deliverable.
 * @param config LLM credentials
 * @param skillName which standalone skill to run
 * @param url prospect URL when available, else null
 * @param entity company or person name for outreach
 * @param emit progress callback
 * @param sellingContext optional description of the seller's product/ICP
 * @param requesterMessage the requester's own chat message, included only so
 *   the language instruction has real text to detect language from - the
 *   discovery briefing itself is scraped from the target's own homepage
 * @param responseLanguage language recognized from the latest user message
 * @param runtimeLabels translated progress and fallback labels
 * @param signal cancels discovery and generation
 * @returns the full markdown deliverable and its title
 */
export async function runStandaloneSkill(
  config: LlmConfig,
  skillName: StandaloneSkillName,
  url: string | null,
  entity: string | null,
  emit: EmitCallback,
  sellingContext: string | null = null,
  requesterMessage: string = "",
  responseLanguage: string = "English",
  runtimeLabels: RuntimeLabels = RUNTIME_LABEL_DEFAULTS,
  signal?: AbortSignal,
): Promise<{ markdown: string; title: string }> {
  const skill = STANDALONE_SKILLS.find((candidate) => candidate.name === skillName);
  if (!skill) throw new Error(`Unknown standalone skill: ${skillName}`);

  let grounding = `Target: ${entity ?? "unknown"}
No website was provided, so no discovery could run. Mark anything you cannot
verify as "${NOT_PUBLICLY_AVAILABLE}" rather than guessing.`;
  let title = entity ?? "prospect";

  if (skill.needsDiscovery && url) {
    emit({
      type: "phase",
      phase: "discovery",
      detail: formatRuntimeLabel(runtimeLabels.fetchingTemplate, { target: url }),
    });
    const page = await fetchWithVariants(url, signal);
    const extraction = analyzeProspect(page.html, page.url);
    const contacts = findContacts(page.html);
    const signals = buildSignals(extraction, contacts);
    const bant = skill.name === "qualify" ? scoreBant(signals) : null;
    grounding = `Discovery briefing for ${page.url}:
- Company: ${extraction.companyName ?? NOT_PUBLICLY_AVAILABLE}
- Title/description: ${extraction.title ?? "-"} / ${extraction.description ?? "-"}
- Tech stack: ${extraction.techStack.join(", ") || "none detected"}
- Emails: ${extraction.emails.join(", ") || "none found"}
- Pricing page: ${extraction.pricingPageUrl ?? "none found"}
- Employees (JSON-LD): ${extraction.jsonLdOrg?.numberOfEmployees ?? NOT_PUBLICLY_AVAILABLE}
- Contacts found: ${contacts.length}
${contacts
  .slice(0, MAX_CONTACTS_IN_GROUNDING)
  .map(
    (contact) =>
      `  - ${contact.name}, ${contact.title ?? "title unknown"} (${contact.seniority}, ${contact.buyingRole})${contact.linkedin ? ` - ${contact.linkedin}` : ""}`,
  )
  .join("\n")}
- Homepage text: ${htmlToText(page.html).slice(0, GROUNDING_HOMEPAGE_CHAR_BUDGET)}
${
  bant
    ? `\nDeterministic BANT pre-score (use as a floor, adjust only with cited evidence):\n${bant.dimensions
        .map((dimension) => `- ${dimension.name}: ${dimension.score}/25 (${dimension.evidence})`)
        .join("\n")}`
    : ""
}`;
    title = extraction.companyName ?? page.url;
  }

  emit({
    type: "phase",
    phase: "analysis",
    detail: formatRuntimeLabel(runtimeLabels.runningSkillTemplate, {
      skill: localizedSkillName(runtimeLabels, skill.name),
    }),
  });

  const languageHint = `${responseLanguageContext(responseLanguage, requesterMessage)}\n\n`;
  const sellLine = sellingContext ? `WHAT WE SELL: ${sellingContext}\n\n` : "";
  const userContent = `${languageHint}${sellLine}${grounding}`;

  let markdown = "";
  for await (const delta of streamChatCompletion(
    config,
    [
      { role: "system", content: skill.systemPrompt },
      { role: "user", content: userContent },
    ],
    { temperature: 0.3, signal },
  )) {
    markdown += delta;
    emit({ type: "token", text: delta });
  }

  if (skill.name === "research" && !sellingContext) {
    const nudge = `\n\n---\n\n> ${runtimeLabels.researchNudge}\n`;
    markdown += nudge;
    emit({ type: "token", text: nudge });
  }

  emit({
    type: "phase",
    phase: "done",
    detail: formatRuntimeLabel(runtimeLabels.skillCompleteTemplate, {
      skill: localizedSkillName(runtimeLabels, skill.name),
    }),
  });
  return { markdown, title };
}

/**
 * Build deterministic signals from an extraction and contacts.
 * @param extraction homepage extraction
 * @param contacts people found on the page
 * @returns the signal blob for scoreBant
 */
function buildSignals(
  extraction: ReturnType<typeof analyzeProspect>,
  contacts: ReturnType<typeof findContacts>,
): ProspectSignals {
  const employees = extraction.jsonLdOrg?.numberOfEmployees;
  const employeeCount =
    typeof employees === "number"
      ? employees
      : typeof employees === "string"
        ? Number.parseInt(employees.replace(/\D/g, ""), 10) || undefined
        : undefined;
  return {
    employeeCount,
    hasPricingPage: extraction.hasPricingPage,
    enterpriseTierListed: extraction.enterpriseTierListed,
    decisionMakersFound: contacts.length,
    cSuiteIdentified: contacts.some((c) => c.seniority === "C-Suite"),
  };
}
