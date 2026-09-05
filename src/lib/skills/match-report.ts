/**
 * Presentation for the match skill: ranking scored candidates and rendering
 * them as report markdown and cards. Pure formatting, separated from the
 * discovery and scoring stages that produce the data. The label sets stay in
 * match.ts because those stages consume them too.
 */

import type { EmitCallback, MatchDirection } from "@/lib/agent/schemas";
import { WORKFLOW_PHASE } from "@/lib/workflow/constants";
import {
  MATCH_REPORT_LABELS,
  type CandidatePool,
  type MatchReportLabels,
  type CandidateScore,
  type CandidateScoreBatch,
  type MatchSkillResult,
} from "@/lib/skills/match";
import {
  formatRuntimeLabel,
  type RuntimeLabels,
} from "@/lib/localization";

/** Most candidates one match report will show. */
const MATCH_RESULT_LIMIT = 8;

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
  labels: MatchReportLabels = MATCH_REPORT_LABELS,
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
    emit({ type: "phase", phase: WORKFLOW_PHASE.done, detail: runtimeLabels.matchComplete });
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
