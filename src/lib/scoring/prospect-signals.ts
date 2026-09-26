/**
 * The single place discovery evidence becomes deterministic scoring input.
 * Both the full prospect pipeline and the standalone skills derive their
 * signals here so the two can never drift apart.
 */

import type { ContactCandidate } from "@/lib/extract/contact-finder";
import type { ProspectExtraction } from "@/lib/extract/analyze-prospect";
import type { ProspectSignals } from "@/lib/scoring/lead-scorer";

/** The extraction fields deterministic scoring reads, however they were built. */
export type SignalSource = Pick<
  ProspectExtraction,
  "techStack" | "hasPricingPage" | "enterpriseTierListed" | "employeeCount"
>;

/** The signals no page extractor can read, evidenced by an analysis worker. */
export type DiscoverySignals = Pick<
  ProspectSignals,
  | "painPointsDetected"
  | "activeJobPostings"
  | "recentFundingWithin12Months"
  | "fundingTotalUsd"
>;

/**
 * Derive deterministic BANT and MEDDIC signals from discovery evidence.
 * Page-derived facts come from deterministic extraction; the pain, hiring,
 * and funding signals no extractor can read are folded in only when the
 * Opportunity Scoring subagent evidenced them.
 * @param source homepage extraction or the discovery briefing built from it
 * @param contacts people found during discovery
 * @param discoverySignals evidence-backed signals reported by that subagent
 * @returns the signal blob for scoreBant and scoreMeddic
 */
export function buildProspectSignals(
  source: SignalSource,
  contacts: ContactCandidate[],
  discoverySignals?: DiscoverySignals,
): ProspectSignals {
  return {
    employeeCount: source.employeeCount,
    hasPricingPage: source.hasPricingPage,
    enterpriseTierListed: source.enterpriseTierListed,
    decisionMakersFound: contacts.length,
    cSuiteIdentified: contacts.some(
      (contact) => contact.seniority === "C-Suite",
    ),
    techStackCount: source.techStack.length,
    orgChartMapped: contacts.some((contact) => contact.title !== null),
    ...discoverySignals,
  };
}
