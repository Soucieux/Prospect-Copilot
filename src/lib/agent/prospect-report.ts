/**
 * Markdown rendering for the prospect audit. Pure formatting: it receives
 * completed pipeline state and returns text, with no I/O and no model calls,
 * so the orchestrator keeps only the pipeline stages themselves.
 */

import { NOT_PUBLICLY_AVAILABLE } from "@/lib/constants";
import type { SubagentResult, SynthesisResult } from "@/lib/agent/schemas";
import type { DiscoveryBriefing } from "@/lib/agent/orchestrator";
import { SUBAGENTS, subagentOutcomes } from "@/lib/skills/subagents";
import {
  CATEGORY_LABELS,
  type MeddicResult,
  type ProspectComposite,
  type scoreBant,
} from "@/lib/scoring/lead-scorer";
import {
  RUNTIME_LABEL_DEFAULTS,
  formatRuntimeLabel,
  localizedAgentName,
  localizedCategoryName,
  localizedConfidence,
  mergeLabelSet,
  type RuntimeLabels,
} from "@/lib/localization";

/** Longest decision-maker table the report will render. */
const MAX_CONTACTS_IN_REPORT = 10;

/**
 * English defaults for the report-specific labels the synthesis call
 * translates. Score categories, subagent names, and confidence values are
 * deliberately absent: the router already translates those into
 * `RuntimeLabels`, and translating them twice let the markdown table and the
 * scorecard disagree about the same term.
 */
/**
 * Every label the prospect report renders, declared by name rather than left
 * as a `Record<string, string>`. Each one is read by key while building the
 * document, so an absent label would reach the page as the literal text
 * "undefined" instead of failing the type check here. The index signature
 * covers only the seniority and buying-role labels, which are looked up by
 * composed key and already fall back to their English value.
 */
export interface ProspectReportLabels {
  [key: string]: string;
  reportTitleTemplate: string;
  urlLabel: string;
  dateLabel: string;
  scoreLabel: string;
  gradeLabel: string;
  confidenceLabel: string;
  scoreBreakdown: string;
  categoryCol: string;
  scoreCol: string;
  weightCol: string;
  totalRow: string;
  bantSignals: string;
  dimensionCol: string;
  evidenceCol: string;
  meddicSignals: string;
  elementCol: string;
  knownCol: string;
  missingCol: string;
  notAssessedCol: string;
  meddicCompleteTemplate: string;
  meddicNotAssessedNote: string;
  meddicMetrics: string;
  meddicEconomicBuyer: string;
  meddicDecisionCriteria: string;
  meddicDecisionProcess: string;
  meddicIdentifyPain: string;
  meddicChampion: string;
  executiveSummary: string;
  actionPlan: string;
  immediate: string;
  shortTerm: string;
  longTerm: string;
  readyEmail: string;
  toLabel: string;
  subjectALabel: string;
  subjectBLabel: string;
  ctaLabel: string;
  decisionMakerMap: string;
  nameCol: string;
  titleCol: string;
  seniorityCol: string;
  buyingRoleCol: string;
  linkedinCol: string;
  notAvailable: string;
  sen_CSuite: string;
  sen_VP: string;
  sen_Director: string;
  sen_Manager: string;
  sen_IC: string;
  role_EconomicBuyer: string;
  role_Champion: string;
  role_TechnicalEvaluator: string;
  role_EndUser: string;
  role_Unknown: string;
  claimCol: string;
  recommendationLabel: string;
  analysisUnavailableTemplate: string;
  degradedNoteTemplate: string;
  sellPrompt: string;
  footer: string;
}

export const PROSPECT_REPORT_LABELS: ProspectReportLabels = {
  reportTitleTemplate: "Prospect Analysis: {company}",
  urlLabel: "URL",
  dateLabel: "Date",
  scoreLabel: "Prospect Score",
  gradeLabel: "Grade",
  confidenceLabel: "Confidence",
  scoreBreakdown: "Score Breakdown",
  categoryCol: "Category",
  scoreCol: "Score",
  weightCol: "Weight",
  totalRow: "Total",
  bantSignals: "BANT Signals",
  dimensionCol: "Dimension",
  evidenceCol: "Evidence",
  meddicSignals: "MEDDIC Completeness",
  elementCol: "Element",
  knownCol: "Evidenced",
  missingCol: "Looked for, absent",
  notAssessedCol: "Ask on the call",
  meddicCompleteTemplate: "{percent}% overall MEDDIC completeness",
  meddicNotAssessedNote:
    "Percentages cover only what public discovery can assess. Anything under \"Ask on the call\" is not scored - it is what to confirm with the prospect.",
  meddicMetrics: "Metrics",
  meddicEconomicBuyer: "Economic Buyer",
  meddicDecisionCriteria: "Decision Criteria",
  meddicDecisionProcess: "Decision Process",
  meddicIdentifyPain: "Identify Pain",
  meddicChampion: "Champion",
  executiveSummary: "Executive Summary",
  actionPlan: "Prioritized Action Plan",
  immediate: "Immediate (Next 24-48 Hours)",
  shortTerm: "Short-Term (Next 1-2 Weeks)",
  longTerm: "Long-Term (Next 1-3 Months)",
  readyEmail: "Ready-to-Send First Email",
  toLabel: "To",
  subjectALabel: "Subject A",
  subjectBLabel: "Subject B",
  ctaLabel: "CTA",
  decisionMakerMap: "Decision Maker Map",
  nameCol: "Name",
  titleCol: "Title",
  seniorityCol: "Seniority",
  buyingRoleCol: "Buying Role",
  linkedinCol: "LinkedIn",
  notAvailable: NOT_PUBLICLY_AVAILABLE,
  sen_CSuite: "C-Suite",
  sen_VP: "VP",
  sen_Director: "Director",
  sen_Manager: "Manager",
  sen_IC: "Individual Contributor",
  role_EconomicBuyer: "Economic Buyer",
  role_Champion: "Champion",
  role_TechnicalEvaluator: "Technical Evaluator",
  role_EndUser: "End User",
  role_Unknown: "Unknown",
  claimCol: "Claim",
  recommendationLabel: "Recommendation",
  analysisUnavailableTemplate:
    "Analysis unavailable - neutral score assigned. Reason: {reason}",
  degradedNoteTemplate:
    "Note: {categories} analysis was degraded; confidence reduced accordingly.",
  sellPrompt:
    'Tell me what you sell (e.g. "we sell payroll software for mid-market companies") and I\'ll sharpen the Company Fit and Competitive Position scoring on your next request.',
  footer: "Generated by Prospect Copilot",
};

/**
 * Preserve localized subagent findings when the synthesis call fails.
 * @param briefing discovery briefing
 * @param results settled subagent results
 * @param composite deterministic composite score
 * @param runtimeLabels translated progress and agent labels
 * @returns a compact localized markdown fallback
 */
export function assembleLocalizedFallbackReport(
  briefing: DiscoveryBriefing,
  results: PromiseSettledResult<SubagentResult>[],
  composite: ProspectComposite,
  runtimeLabels: RuntimeLabels,
): string {
  const lines = [
    `# ${briefing.companyName ?? briefing.url}`,
    "",
    formatRuntimeLabel(runtimeLabels.synthesizingTemplate, {
      score: composite.score,
      grade: composite.grade,
    }),
    "",
  ];
  subagentOutcomes(results).forEach(({ definition, settled }) => {
    const agent = localizedAgentName(runtimeLabels, definition.name);
    lines.push(`## ${agent}`, "");
    if (settled.status === "fulfilled") {
      lines.push(settled.value.summary, "");
      settled.value.findings.forEach((finding) => {
        lines.push(`- ${finding.claim} — ${finding.evidence}`);
      });
      lines.push("", settled.value.recommendation, "");
    } else {
      lines.push(
        formatRuntimeLabel(runtimeLabels.agentFailedTemplate, { agent }),
        "",
      );
    }
  });
  return lines.join("\n");
}

/** Report-label key for each MEDDIC element, keyed by its stable code. */
const MEDDIC_LABEL_KEYS: Record<string, string> = {
  M: "meddicMetrics",
  E: "meddicEconomicBuyer",
  Dc: "meddicDecisionCriteria",
  Dp: "meddicDecisionProcess",
  I: "meddicIdentifyPain",
  C: "meddicChampion",
};

/**
 * Resolve the translated display name for one MEDDIC element.
 * @param labels synthesis-translated report labels
 * @param code stable element code
 * @param englishName the scorer's English element name
 * @returns the translated name, or the English name when untranslated
 */
function meddicElementLabel(
  labels: ProspectReportLabels,
  code: string,
  englishName: string,
): string {
  const key = MEDDIC_LABEL_KEYS[code];
  return (key ? labels[key] : undefined) ?? englishName;
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
 * @param runtimeLabels router translations, the single source of truth for
 *   score categories, subagent names, and confidence values
 * @param meddic deterministic MEDDIC completeness, omitted to hide the table
 * @returns the full report markdown
 */
export function assembleReport(
  briefing: DiscoveryBriefing,
  results: PromiseSettledResult<SubagentResult>[],
  composite: ProspectComposite,
  synthesis: SynthesisResult,
  bant: ReturnType<typeof scoreBant>,
  sellingContext: string | null,
  runtimeLabels: RuntimeLabels = RUNTIME_LABEL_DEFAULTS,
  meddic?: MeddicResult,
): string {
  // Merged rather than trusted: the synthesis labels arrive as an untyped
  // record, so completing them here guarantees every key the report reads.
  const labels: ProspectReportLabels = synthesis.labels
    ? mergeLabelSet(PROSPECT_REPORT_LABELS, synthesis.labels)
    : PROSPECT_REPORT_LABELS;
  const categoryDisplayName = (englishName: string): string =>
    localizedCategoryName(runtimeLabels, englishName);
  const subagentLabel = (definition: (typeof SUBAGENTS)[number]): string =>
    localizedAgentName(runtimeLabels, definition.name);
  const confidenceLabel = (value: string): string =>
    localizedConfidence(runtimeLabels, value);
  const seniorityLabel = (value: string): string => {
    const key = value === "C-Suite" ? "CSuite" : value;
    return labels[`sen_${key}`] ?? value;
  };
  const buyingRoleLabel = (value: string): string =>
    labels[`role_${value.replaceAll(" ", "")}`] ?? value;

  const today = new Date().toISOString().slice(0, 10);
  const reportTitle = labels.reportTitleTemplate.replace(
    "{company}",
    briefing.companyName ?? briefing.url,
  );
  const lines: string[] = [
    `# ${reportTitle}`,
    "",
    `**${labels.urlLabel}:** ${briefing.url}  `,
    `**${labels.dateLabel}:** ${today}  `,
    `**${labels.scoreLabel}:** ${composite.score}/100 (${labels.gradeLabel} ${composite.grade})  `,
    `**${labels.confidenceLabel}:** ${confidenceLabel(composite.confidence)}`,
    "",
    `## ${labels.scoreBreakdown}`,
    "",
    `| ${labels.categoryCol} | ${labels.scoreCol} | ${labels.weightCol} |`,
    "|----------|-------|--------|",
  ];
  for (const row of composite.weighted) {
    lines.push(
      `| ${categoryDisplayName(row.category)} | ${row.score}/100 | ${Math.round(row.weight * 100)}% |`,
    );
  }
  lines.push(
    `| **${labels.totalRow}** | **${composite.score}/100** | **100%** |`,
    "",
    `## ${labels.bantSignals}`,
    "",
    `| ${labels.dimensionCol} | ${labels.scoreCol} | ${labels.evidenceCol} |`,
    "|-----------|-------|----------|",
  );
  for (const [index, dimension] of bant.dimensions.entries()) {
    const translated = synthesis.bantTranslations?.[index];
    lines.push(
      `| ${translated?.name ?? dimension.name} | ${dimension.score}/25 | ${translated?.evidence ?? dimension.evidence} |`,
    );
  }
  if (meddic) {
    lines.push(
      "",
      `## ${labels.meddicSignals}`,
      "",
      labels.meddicCompleteTemplate.replace(
        "{percent}",
        String(meddic.completenessPercent),
      ),
      "",
      `| ${labels.elementCol} | ${labels.knownCol} | ${labels.missingCol} | ${labels.notAssessedCol} |`,
      "|---------|-------|----------|----------|",
    );
    for (const element of meddic.elements) {
      const missing = element.checks
        .filter((check) => check.assessed && !check.present)
        .map((check) => check.label)
        .join(", ");
      const notAssessed = element.checks
        .filter((check) => !check.assessed)
        .map((check) => check.label)
        .join(", ");
      lines.push(
        `| ${meddicElementLabel(labels, element.code, element.name)} | ${element.percent}% | ${missing || "-"} | ${notAssessed || "-"} |`,
      );
    }
    lines.push("", `_${labels.meddicNotAssessedNote}_`);
  }
  lines.push(
    "",
    `## ${labels.executiveSummary}`,
    "",
    synthesis.executiveSummary,
    "",
    `## ${labels.actionPlan}`,
    "",
    `### ${labels.immediate}`,
  );
  for (const action of synthesis.actionPlan.immediate) lines.push(`- ${action}`);
  lines.push("", `### ${labels.shortTerm}`);
  for (const action of synthesis.actionPlan.shortTerm) lines.push(`- ${action}`);
  lines.push("", `### ${labels.longTerm}`);
  for (const action of synthesis.actionPlan.longTerm) lines.push(`- ${action}`);
  lines.push(
    "",
    `## ${labels.readyEmail}`,
    "",
    `**${labels.toLabel}:** ${synthesis.firstEmail.to}  `,
    `**${labels.subjectALabel}:** ${synthesis.firstEmail.subjectA}  `,
    `**${labels.subjectBLabel}:** ${synthesis.firstEmail.subjectB}`,
    "",
    synthesis.firstEmail.body,
    "",
    `**${labels.ctaLabel}:** ${synthesis.firstEmail.cta}`,
    "",
    "---",
    "",
  );
  if (briefing.contacts.length > 0) {
    lines.push(
      `## ${labels.decisionMakerMap}`,
      "",
      `| ${labels.nameCol} | ${labels.titleCol} | ${labels.seniorityCol} | ${labels.buyingRoleCol} | ${labels.linkedinCol} |`,
      "|------|-------|-----------|-------------|----------|",
    );
    for (const contact of briefing.contacts.slice(0, MAX_CONTACTS_IN_REPORT)) {
      lines.push(
        `| ${contact.name} | ${contact.title ?? labels.notAvailable} | ${seniorityLabel(contact.seniority)} | ${buyingRoleLabel(contact.buyingRole)} | ${contact.linkedin ?? "-"} |`,
      );
    }
    lines.push("", "---", "");
  }
  subagentOutcomes(results).forEach(({ definition, settled }) => {
    lines.push(`## ${subagentLabel(definition)} (${Math.round(definition.weight * 100)}%)`, "");
    if (settled.status === "fulfilled") {
      lines.push(
        settled.value.summary,
        "",
        `| ${labels.claimCol} | ${labels.evidenceCol} | ${labels.confidenceLabel} |`,
        "|-------|----------|-------------|",
      );
      for (const finding of settled.value.findings) {
        lines.push(
          `| ${finding.claim} | ${finding.evidence} | ${confidenceLabel(finding.confidence)} |`,
        );
      }
      lines.push("", `**${labels.recommendationLabel}:** ${settled.value.recommendation}`, "");
    } else {
      lines.push(
        labels.analysisUnavailableTemplate.replace(
          "{reason}",
          labels.notAvailable,
        ),
        "",
      );
    }
  });
  if (composite.degradedCategories.length > 0) {
    const degradedNames = composite.degradedCategories
      .map((key) => {
        const english = CATEGORY_LABELS[key as keyof typeof CATEGORY_LABELS];
        return english ? localizedCategoryName(runtimeLabels, english) : key;
      })
      .join(", ");
    lines.push(
      "---",
      "",
      `> ${labels.degradedNoteTemplate.replace("{categories}", degradedNames)}`,
      "",
    );
  }
  if (!sellingContext) {
    lines.push("---", "", `> ${labels.sellPrompt}`, "");
  }
  lines.push(`*${labels.footer}*`);
  return lines.join("\n");
}
