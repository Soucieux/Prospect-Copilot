import type { ReportState } from "@/lib/chat-types";

/** The report fields a caller must supply; every other field defaults to absent. */
type ReportInput = Pick<
  ReportState,
  "kind" | "companyName" | "scoreLabels" | "markdown"
> &
  Partial<Omit<ReportState, "kind" | "companyName" | "scoreLabels" | "markdown">>;

/**
 * Build a complete report from the fields one skill actually produces.
 * Each skill previously repeated the same block of null fields, so a new
 * report field could be silently forgotten by one branch and not another.
 * @param input the fields this report kind populates
 * @returns a complete report with unpopulated fields set to null
 */
export function buildReport(input: ReportInput): ReportState {
  return {
    url: null,
    score: null,
    grade: null,
    confidence: null,
    categories: null,
    matches: null,
    matchLabels: null,
    ...input,
  };
}
