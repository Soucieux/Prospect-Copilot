/**
 * The single place discovery evidence becomes deterministic scoring input.
 * Both the full prospect pipeline and the standalone skills derive their
 * signals here so the two can never drift apart.
 */

import type { SubagentResult } from "@/lib/agent/schemas";
import type { ContactCandidate } from "@/lib/extract/contact-finder";
import { parseEmployeeCount } from "@/lib/extract/analyze-prospect";
import type { ProspectSignals } from "@/lib/scoring/lead-scorer";

/** The extraction fields deterministic scoring reads, however they were built. */
export interface SignalSource {
  techStack: string[];
  hasPricingPage: boolean;
  enterpriseTierListed: boolean;
  jsonLdOrg: { numberOfEmployees?: number | string } | null;
}

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
  discoverySignals?: SubagentResult["discoverySignals"],
): ProspectSignals {
  return {
    employeeCount: parseEmployeeCount(source.jsonLdOrg?.numberOfEmployees),
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
