/**
 * Deterministic scoring engine - TypeScript port of scripts/lead_scorer.py.
 *
 * Pure functions only: given a signal blob extracted during discovery and
 * the five subagent dimension scores, computes BANT, MEDDIC completeness,
 * the weighted composite Prospect Score, grade, and confidence. No I/O.
 */

/** Raw discovery signals used by the deterministic heuristics. */
export interface ProspectSignals {
  fundingTotalUsd?: number;
  employeeCount?: number;
  hasPricingPage?: boolean;
  enterpriseTierListed?: boolean;
  decisionMakersFound?: number;
  cSuiteIdentified?: boolean;
  painPointsDetected?: number;
  reviewsMentioningPain?: number;
  recentFundingWithin12Months?: boolean;
  activeJobPostings?: number;
  contractRenewalWindowMonths?: number;
}

export interface BantDimension {
  name: "budget" | "authority" | "need" | "timeline";
  score: number;
  evidence: string;
}

export interface BantResult {
  total: number;
  grade: ProspectGrade;
  dimensions: BantDimension[];
}

export interface MeddicResult {
  completenessPercent: number;
  elements: {
    code: "M" | "E" | "Dc" | "Dp" | "I" | "C";
    name: string;
    present: boolean;
  }[];
}

export type ProspectGrade = "A+" | "A" | "B" | "C" | "D";

export type ConfidenceLevel = "High" | "Medium" | "Low" | "Very Low";

/** The five subagent category scores (0-100 each). */
export interface CategoryScores {
  companyFit?: number;
  contactAccess?: number;
  opportunityQuality?: number;
  competitivePosition?: number;
  outreachReadiness?: number;
}

export interface ProspectComposite {
  score: number;
  grade: ProspectGrade;
  confidence: ConfidenceLevel;
  weighted: { category: string; score: number; weight: number }[];
  degradedCategories: string[];
}

/** Weights from the design doc; must sum to 1. */
export const CATEGORY_WEIGHTS = {
  companyFit: 0.25,
  contactAccess: 0.2,
  opportunityQuality: 0.2,
  competitivePosition: 0.15,
  outreachReadiness: 0.2,
} as const;

/** Score assigned to a category whose subagent failed (design doc rule). */
export const NEUTRAL_CATEGORY_SCORE = 50;

const FUNDING_STRONG_USD = 10_000_000;
const FUNDING_MODERATE_USD = 1_000_000;

/**
 * Score the Budget dimension (0-25) from funding, size, and pricing signals.
 * @param signals raw discovery signals
 * @returns dimension score with human-readable evidence
 */
function scoreBudget(signals: ProspectSignals): BantDimension {
  let score = 0;
  const notes: string[] = [];
  if (signals.fundingTotalUsd !== undefined) {
    if (signals.fundingTotalUsd >= FUNDING_STRONG_USD) {
      score += 15;
      notes.push("strong funding total");
    } else if (signals.fundingTotalUsd >= FUNDING_MODERATE_USD) {
      score += 10;
      notes.push("moderate funding total");
    } else {
      score += 4;
      notes.push("small funding total");
    }
  }
  if (signals.employeeCount !== undefined) {
    if (signals.employeeCount >= 200) {
      score += 8;
      notes.push("200+ employees");
    } else if (signals.employeeCount >= 50) {
      score += 5;
      notes.push("50+ employees");
    }
  }
  if (signals.hasPricingPage) {
    score += 2;
    notes.push("public pricing page");
  }
  if (signals.enterpriseTierListed) {
    score += 2;
    notes.push("enterprise tier listed");
  }
  return {
    name: "budget",
    score: clamp(score, 0, 25),
    evidence: notes.length > 0 ? notes.join("; ") : "no budget signals found",
  };
}

/**
 * Score the Authority dimension (0-25) from decision-maker discovery.
 * @param signals raw discovery signals
 * @returns dimension score with human-readable evidence
 */
function scoreAuthority(signals: ProspectSignals): BantDimension {
  let score = 0;
  const notes: string[] = [];
  const found = signals.decisionMakersFound ?? 0;
  score += Math.min(15, found * 5);
  if (found > 0) notes.push(`${found} decision makers identified`);
  if (signals.cSuiteIdentified) {
    score += 10;
    notes.push("C-suite identified");
  }
  return {
    name: "authority",
    score: clamp(score, 0, 25),
    evidence: notes.length > 0 ? notes.join("; ") : "no authority signals found",
  };
}

/**
 * Score the Need dimension (0-25) from pain-point evidence.
 * @param signals raw discovery signals
 * @returns dimension score with human-readable evidence
 */
function scoreNeed(signals: ProspectSignals): BantDimension {
  let score = 0;
  const notes: string[] = [];
  const pains = signals.painPointsDetected ?? 0;
  score += Math.min(15, pains * 5);
  if (pains > 0) notes.push(`${pains} pain points detected`);
  const reviews = signals.reviewsMentioningPain ?? 0;
  score += Math.min(10, reviews * 2);
  if (reviews > 0) notes.push(`${reviews} reviews mention pain`);
  return {
    name: "need",
    score: clamp(score, 0, 25),
    evidence: notes.length > 0 ? notes.join("; ") : "no need signals found",
  };
}

/**
 * Score the Timeline dimension (0-25) from urgency signals.
 * @param signals raw discovery signals
 * @returns dimension score with human-readable evidence
 */
function scoreTimeline(signals: ProspectSignals): BantDimension {
  let score = 0;
  const notes: string[] = [];
  if (signals.recentFundingWithin12Months) {
    score += 12;
    notes.push("funding within last 12 months");
  }
  const jobs = signals.activeJobPostings ?? 0;
  if (jobs >= 10) {
    score += 10;
    notes.push(`${jobs} open roles - hiring surge`);
  } else if (jobs > 0) {
    score += 5;
    notes.push(`${jobs} open roles`);
  }
  const window = signals.contractRenewalWindowMonths;
  if (window !== undefined && window <= 6) {
    score += 3;
    notes.push(`renewal window ~${window} months`);
  }
  return {
    name: "timeline",
    score: clamp(score, 0, 25),
    evidence: notes.length > 0 ? notes.join("; ") : "no timeline signals found",
  };
}

/**
 * Compute the deterministic BANT score from discovery signals.
 * @param signals raw discovery signals
 * @returns total (0-100), grade, and per-dimension breakdown
 */
export function scoreBant(signals: ProspectSignals): BantResult {
  const dimensions = [
    scoreBudget(signals),
    scoreAuthority(signals),
    scoreNeed(signals),
    scoreTimeline(signals),
  ];
  const total = dimensions.reduce((sum, d) => sum + d.score, 0);
  return { total, grade: gradeFromScore(total), dimensions };
}

/**
 * Compute MEDDIC completeness from presence booleans.
 * @param signals element presence flags folded into the signal blob
 * @returns completeness percent and per-element detail
 */
export function scoreMeddic(signals: {
  metrics?: boolean;
  economicBuyer?: boolean;
  decisionCriteria?: boolean;
  decisionProcess?: boolean;
  identifyPain?: boolean;
  champion?: boolean;
}): MeddicResult {
  const checks: { code: MeddicResult["elements"][number]["code"]; name: string; present: boolean }[] = [
    { code: "M", name: "Metrics", present: signals.metrics === true },
    { code: "E", name: "Economic Buyer", present: signals.economicBuyer === true },
    { code: "Dc", name: "Decision Criteria", present: signals.decisionCriteria === true },
    { code: "Dp", name: "Decision Process", present: signals.decisionProcess === true },
    { code: "I", name: "Identify Pain", present: signals.identifyPain === true },
    { code: "C", name: "Champion", present: signals.champion === true },
  ];
  const present = checks.filter((c) => c.present).length;
  return {
    completenessPercent: Math.round((present / checks.length) * 100),
    elements: checks,
  };
}

/**
 * Blend the five subagent category scores into the composite Prospect Score.
 * Missing categories get the neutral score and are flagged as degraded.
 * @param scores the five category scores (0-100), any may be missing
 * @returns composite score, grade, confidence, and degradation notes
 */
export function computeProspectScore(scores: CategoryScores): ProspectComposite {
  const entries = Object.entries(CATEGORY_WEIGHTS) as [
    keyof typeof CATEGORY_WEIGHTS,
    number,
  ][];
  const weighted: ProspectComposite["weighted"] = [];
  const degradedCategories: string[] = [];
  let total = 0;
  for (const [category, weight] of entries) {
    const raw = scores[category];
    const effective =
      raw === undefined || Number.isNaN(raw) ? NEUTRAL_CATEGORY_SCORE : raw;
    if (raw === undefined || Number.isNaN(raw)) {
      degradedCategories.push(category);
    }
    total += effective * weight;
    weighted.push({
      category: CATEGORY_LABELS[category],
      score: effective,
      weight,
    });
  }
  const score = Math.round(total);
  const completed = entries.length - degradedCategories.length;
  return {
    score,
    grade: gradeFromScore(score),
    confidence: confidenceFromCompletion(completed),
    weighted,
    degradedCategories,
  };
}

/** Human-readable labels for the weighted output table. */
export const CATEGORY_LABELS: Record<keyof typeof CATEGORY_WEIGHTS, string> = {
  companyFit: "Company Fit",
  contactAccess: "Contact Access",
  opportunityQuality: "Opportunity Quality",
  competitivePosition: "Competitive Position",
  outreachReadiness: "Outreach Readiness",
};

/**
 * Map a 0-100 score to the design doc's grade scale.
 * @param score numeric score
 * @returns letter grade
 */
export function gradeFromScore(score: number): ProspectGrade {
  if (score >= 90) return "A+";
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

/**
 * Derive the confidence level from how many subagents completed.
 * @param completed number of successful subagent categories (0-5)
 * @returns confidence level
 */
export function confidenceFromCompletion(completed: number): ConfidenceLevel {
  if (completed >= 5) return "High";
  if (completed === 4) return "Medium";
  if (completed === 3) return "Low";
  return "Very Low";
}

/**
 * Clamp a number into [min, max].
 * @param value the number to clamp
 * @param min lower bound
 * @param max upper bound
 * @returns the clamped value
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
