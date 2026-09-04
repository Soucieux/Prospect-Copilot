import { describe, expect, it } from "vitest";
import {
  scoreProspectBriefing,
  SUBPAGE_PATTERNS,
} from "./orchestrator";
import {
  PROSPECT_REPORT_LABELS,
  assembleReport,
} from "./prospect-report";
import { SUBAGENTS } from "@/lib/skills/subagents";
import { scoreMeddic } from "@/lib/scoring/lead-scorer";
import { RUNTIME_LABEL_DEFAULTS } from "@/lib/localization";
import type { SubagentResult, SynthesisResult } from "./schemas";

const BRIEFING = {
  url: "https://acme.example.com",
  companyName: "Acme Corp",
  title: "Acme",
  description: "Payroll software",
  techStack: [],
  socialProfiles: [],
  emails: [],
  hasPricingPage: true,
  enterpriseTierListed: false,
  jsonLdOrg: null,
  pages: [],
  contacts: [],
};

const COMPOSITE = {
  score: 72,
  grade: "B" as const,
  confidence: "High" as const,
  weighted: [
    { category: "Company Fit", score: 80, weight: 0.25 },
    { category: "Contact Access", score: 70, weight: 0.2 },
    { category: "Opportunity Quality", score: 65, weight: 0.2 },
    { category: "Competitive Position", score: 60, weight: 0.15 },
    { category: "Outreach Readiness", score: 75, weight: 0.2 },
  ],
  degradedCategories: ["competitivePosition"],
};

const BANT = {
  total: 60,
  grade: "B" as const,
  dimensions: [
    { name: "budget" as const, score: 15, evidence: "Has a pricing page." },
    { name: "authority" as const, score: 15, evidence: "No contacts found." },
    { name: "need" as const, score: 15, evidence: "Some signals." },
    { name: "timeline" as const, score: 15, evidence: "Unknown." },
  ],
};

const SUBAGENT_RESULT: SubagentResult = {
  score: 70,
  summary: "Looks fine.",
  findings: [{ claim: "Uses modern tech", evidence: "Found React", confidence: "High" }],
  recommendation: "Proceed.",
};

const RESULTS: PromiseSettledResult<SubagentResult>[] = SUBAGENTS.map(() => ({
  status: "fulfilled" as const,
  value: SUBAGENT_RESULT,
}));

const BASE_SYNTHESIS: Omit<SynthesisResult, "labels"> = {
  executiveSummary: "This is a strong prospect.",
  actionPlan: {
    immediate: ["Call them."],
    shortTerm: ["Send a follow-up."],
    longTerm: ["Re-check next quarter."],
  },
  firstEmail: {
    to: "Jane, VP Sales at Acme",
    subjectA: "Quick question",
    subjectB: "Acme + us",
    body: "Hi Jane, ...",
    cta: "Open to a call?",
  },
};

describe("SUBPAGE_PATTERNS", () => {
  /**
   * Find the subpage name a candidate link would be discovered as.
   * @param url absolute same-origin candidate link
   * @returns the matching subpage name, or null when none matches
   */
  const matchName = (url: string): string | null =>
    SUBPAGE_PATTERNS.find((entry) => entry.pattern.test(url))?.name ?? null;

  it("matches bare paths and trailing slashes", () => {
    expect(matchName("https://acme.example.com/pricing")).toBe("pricing");
    expect(matchName("https://acme.example.com/about/")).toBe("about");
  });

  it("still matches when a tracking query string follows the path", () => {
    // buffer.com hangs ?cta=... off its own nav links; requiring a bare path
    // dropped its pricing and about pages from discovery entirely.
    expect(
      matchName("https://buffer.com/pricing?cta=bufferSite-globalNav-pricing"),
    ).toBe("pricing");
    expect(matchName("https://acme.example.com/careers?utm_source=nav")).toBe(
      "careers",
    );
  });

  it("still matches when a fragment follows the path", () => {
    expect(matchName("https://acme.example.com/contact#form")).toBe("contact");
  });

  it("does not match an unrelated path that merely contains the word", () => {
    expect(matchName("https://acme.example.com/pricing-guide-for-teams")).toBeNull();
  });
});

describe("scoreProspectBriefing", () => {
  /**
   * Build settled results where the Opportunity Scoring subagent reports the
   * signals no page extractor can read.
   * @param discoverySignals evidence-backed signals from that subagent
   * @returns settled results in SUBAGENTS order
   */
  const resultsWithSignals = (
    discoverySignals?: SubagentResult["discoverySignals"],
  ): PromiseSettledResult<SubagentResult>[] =>
    SUBAGENTS.map((definition) => ({
      status: "fulfilled" as const,
      value:
        definition.category === "opportunityQuality"
          ? { ...SUBAGENT_RESULT, discoverySignals }
          : SUBAGENT_RESULT,
    }));

  it("floors Need and Timeline when no subagent signals arrive", () => {
    const { bant } = scoreProspectBriefing(BRIEFING, resultsWithSignals());
    const need = bant.dimensions.find((d) => d.name === "need");
    const timeline = bant.dimensions.find((d) => d.name === "timeline");
    expect(need?.score).toBe(0);
    expect(timeline?.score).toBe(0);
  });

  it("lifts Need and Timeline from the subagent's evidenced signals", () => {
    const { bant } = scoreProspectBriefing(
      BRIEFING,
      resultsWithSignals({
        painPointsDetected: 3,
        activeJobPostings: 12,
        recentFundingWithin12Months: true,
      }),
    );
    const need = bant.dimensions.find((d) => d.name === "need");
    const timeline = bant.dimensions.find((d) => d.name === "timeline");
    expect(need?.score).toBeGreaterThan(0);
    expect(timeline?.score).toBeGreaterThan(0);
  });

  it("raises MEDDIC completeness once those signals arrive", () => {
    const withoutSignals = scoreProspectBriefing(
      BRIEFING,
      resultsWithSignals(),
    );
    const withSignals = scoreProspectBriefing(
      BRIEFING,
      resultsWithSignals({ painPointsDetected: 3, activeJobPostings: 12 }),
    );
    expect(withSignals.meddic.completenessPercent).toBeGreaterThan(
      withoutSignals.meddic.completenessPercent,
    );
  });
});

describe("assembleReport", () => {
  it("uses the English defaults when synthesis carries no labels", () => {
    const markdown = assembleReport(
      BRIEFING,
      RESULTS,
      COMPOSITE,
      BASE_SYNTHESIS,
      BANT,
      null,
    );
    expect(markdown).toContain("## Score Breakdown");
    expect(markdown).toContain("## Executive Summary");
    expect(markdown).toContain("**Confidence:** High");
    expect(markdown).toContain("Company Fit");
    expect(markdown).toContain("## Company Research");
  });

  it("substitutes translated section headers from the synthesis label set", () => {
    const labels = {
      ...PROSPECT_REPORT_LABELS,
      scoreBreakdown: "Répartition du score",
      executiveSummary: "Résumé exécutif",
    };
    const markdown = assembleReport(
      BRIEFING,
      RESULTS,
      COMPOSITE,
      { ...BASE_SYNTHESIS, labels },
      BANT,
      null,
    );
    expect(markdown).toContain("## Répartition du score");
    expect(markdown).toContain("## Résumé exécutif");
  });

  it("takes categories, subagent names, and confidence from the router labels", () => {
    const markdown = assembleReport(
      BRIEFING,
      RESULTS,
      COMPOSITE,
      BASE_SYNTHESIS,
      BANT,
      null,
      {
        ...RUNTIME_LABEL_DEFAULTS,
        categoryCompanyFit: "Adéquation entreprise",
        agentCompanyResearch: "Recherche d'entreprise",
        confidenceHigh: "Élevée",
      },
    );
    expect(markdown).toContain("| Adéquation entreprise |");
    expect(markdown).toContain("## Recherche d'entreprise");
    expect(markdown).toContain("**Confidence:** Élevée");
    expect(markdown).not.toContain("**Confidence:** High");
  });

  it("localizes the Inferred finding confidence the composite scale lacks", () => {
    const inferredResults: PromiseSettledResult<SubagentResult>[] = SUBAGENTS.map(
      () => ({
        status: "fulfilled" as const,
        value: {
          ...SUBAGENT_RESULT,
          findings: [
            {
              claim: "Likely mid-market",
              evidence: "Team page size",
              confidence: "Inferred" as const,
            },
          ],
        },
      }),
    );
    const markdown = assembleReport(
      BRIEFING,
      inferredResults,
      COMPOSITE,
      BASE_SYNTHESIS,
      BANT,
      null,
      { ...RUNTIME_LABEL_DEFAULTS, confidenceInferred: "Déduit" },
    );
    expect(markdown).toContain("| Déduit |");
    expect(markdown).not.toContain("| Inferred |");
  });

  it("translates degraded category names in the degradation note", () => {
    const markdown = assembleReport(
      BRIEFING,
      RESULTS,
      COMPOSITE,
      BASE_SYNTHESIS,
      BANT,
      null,
      {
        ...RUNTIME_LABEL_DEFAULTS,
        categoryCompetitivePosition: "Position concurrentielle",
      },
    );
    expect(markdown).toContain("Position concurrentielle");
    expect(markdown).not.toContain("competitivePosition");
  });

  it("uses localized deterministic BANT names and evidence", () => {
    const markdown = assembleReport(
      BRIEFING,
      RESULTS,
      COMPOSITE,
      {
        ...BASE_SYNTHESIS,
        labels: {
          ...PROSPECT_REPORT_LABELS,
          bantSignals: "BANTシグナル",
        },
        bantTranslations: [
          { name: "予算", evidence: "料金ページがあります。" },
          { name: "権限", evidence: "連絡先が見つかりません。" },
          { name: "ニーズ", evidence: "いくつかのシグナルがあります。" },
          { name: "時期", evidence: "不明です。" },
        ],
      },
      BANT,
      null,
    );
    expect(markdown).toContain("## BANTシグナル");
    expect(markdown).toContain("| 予算 | 15/25 | 料金ページがあります。 |");
    expect(markdown).not.toContain("Has a pricing page.");
  });

  it("renders graded MEDDIC percentages only when completeness was computed", () => {
    const withMeddic = assembleReport(
      BRIEFING,
      RESULTS,
      COMPOSITE,
      BASE_SYNTHESIS,
      BANT,
      null,
      RUNTIME_LABEL_DEFAULTS,
      scoreMeddic({ employeeCount: 120, cSuiteIdentified: true }),
    );
    expect(withMeddic).toContain("## MEDDIC Completeness");
    expect(withMeddic).toContain("overall MEDDIC completeness");
    // Metrics carries 1 of its 3 signals: the row grades it, not yes/no.
    expect(withMeddic).toContain("| Metrics | 33% |");
    expect(withMeddic).toContain("funding amount, pain points");

    const withoutMeddic = assembleReport(
      BRIEFING,
      RESULTS,
      COMPOSITE,
      BASE_SYNTHESIS,
      BANT,
      null,
    );
    expect(withoutMeddic).not.toContain("MEDDIC");
  });

  it("uses translated MEDDIC element names from the synthesis labels", () => {
    const markdown = assembleReport(
      BRIEFING,
      RESULTS,
      COMPOSITE,
      {
        ...BASE_SYNTHESIS,
        labels: {
          ...PROSPECT_REPORT_LABELS,
          meddicSignals: "Exhaustivité MEDDIC",
          meddicMetrics: "Indicateurs",
        },
      },
      BANT,
      null,
      RUNTIME_LABEL_DEFAULTS,
      scoreMeddic({}),
    );
    expect(markdown).toContain("## Exhaustivité MEDDIC");
    expect(markdown).toContain("| Indicateurs | 0% |");
  });

  it("never invents scores, weights, or evidence while substituting labels", () => {
    const markdown = assembleReport(
      BRIEFING,
      RESULTS,
      COMPOSITE,
      { ...BASE_SYNTHESIS, labels: { ...PROSPECT_REPORT_LABELS, scoreCol: "Puntuación" } },
      BANT,
      null,
    );
    expect(markdown).toContain("80/100");
    expect(markdown).toContain("25%");
    expect(markdown).toContain("Found React");
  });
});

describe("assembleReport fallbacks", () => {
  it("titles the report by URL when the site never names the company", () => {
    const markdown = assembleReport(
      { ...BRIEFING, companyName: null },
      RESULTS,
      COMPOSITE,
      BASE_SYNTHESIS,
      BANT,
      null,
    );
    expect(markdown).toContain("https://acme.example.com");
  });

  it("omits the decision-maker map when discovery found no contacts", () => {
    const markdown = assembleReport(
      { ...BRIEFING, contacts: [] },
      RESULTS,
      COMPOSITE,
      BASE_SYNTHESIS,
      BANT,
      null,
    );
    expect(markdown).not.toContain(PROSPECT_REPORT_LABELS.decisionMakerMap);
  });

  it("reports a failed subagent instead of dropping its section", () => {
    const withFailure: PromiseSettledResult<SubagentResult>[] = RESULTS.map(
      (result, index) =>
        index === 0
          ? { status: "rejected" as const, reason: new Error("provider down") }
          : result,
    );
    const markdown = assembleReport(
      BRIEFING,
      withFailure,
      COMPOSITE,
      BASE_SYNTHESIS,
      BANT,
      null,
    );
    expect(markdown).toContain("## Company Research");
    expect(markdown).not.toContain("provider down");
  });

  it("names a degraded category it cannot translate by its own key", () => {
    const markdown = assembleReport(
      BRIEFING,
      RESULTS,
      { ...COMPOSITE, degradedCategories: ["notARealCategory"] },
      BASE_SYNTHESIS,
      BANT,
      null,
    );
    expect(markdown).toContain("notARealCategory");
  });

  it("translates a degraded category it does recognize", () => {
    const markdown = assembleReport(
      BRIEFING,
      RESULTS,
      { ...COMPOSITE, degradedCategories: ["competitivePosition"] },
      BASE_SYNTHESIS,
      BANT,
      null,
    );
    expect(markdown).toContain(RUNTIME_LABEL_DEFAULTS.categoryCompetitivePosition);
  });

  it("marks a fully assessed MEDDIC element with a dash rather than a blank", () => {
    const { meddic } = scoreProspectBriefing(BRIEFING, RESULTS);
    const markdown = assembleReport(
      BRIEFING,
      RESULTS,
      COMPOSITE,
      BASE_SYNTHESIS,
      BANT,
      null,
      RUNTIME_LABEL_DEFAULTS,
      meddic,
    );
    expect(markdown).toMatch(/\| *- *\|/);
  });
});
