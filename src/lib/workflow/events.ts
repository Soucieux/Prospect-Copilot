import type { ReportState } from "@/lib/chat-types";
import {
  formatRuntimeLabel,
  localizedSkillName,
  type LocalizedSkillName,
  type RuntimeLabels,
} from "@/lib/localization";

/**
 * Build the localized scorecard labels stored with a report.
 * @param labels complete runtime translations for the request
 * @param skill internal report kind
 * @param confidenceValue localized confidence value when available
 * @returns localized report-card chrome
 */
export function buildScoreLabels(
  labels: RuntimeLabels,
  skill: LocalizedSkillName,
  confidenceValue: string = "",
): ReportState["scoreLabels"] {
  const skillName = localizedSkillName(labels, skill);
  return {
    grade: labels.gradeLabel,
    confidence: labels.confidenceLabel,
    confidenceValue,
    report: formatRuntimeLabel(labels.reportTemplate, { skill: skillName }),
  };
}
