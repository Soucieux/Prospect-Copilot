import { describe, expect, it } from "vitest";
import { assembleReport, PROSPECT_REPORT_LABELS } from "./orchestrator";
import { SUBAGENTS } from "@/lib/skills/subagents";
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

  it("substitutes translated section headers, categories, subagent names, and confidence tags", () => {
    const labels = {
      ...PROSPECT_REPORT_LABELS,
      scoreBreakdown: "Répartition du score",
      executiveSummary: "Résumé exécutif",
      cat_companyFit: "Adéquation entreprise",
      cat_competitivePosition: "Position concurrentielle",
      sub_companyFit: "Recherche d'entreprise",
      conf_High: "Élevée",
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
    expect(markdown).toContain("| Adéquation entreprise |");
    expect(markdown).toContain("## Recherche d'entreprise");
    expect(markdown).toContain("**Confidence:** Élevée");
    expect(markdown).not.toContain("**Confidence:** High");
  });

  it("translates degraded category names in the degradation note", () => {
    const labels = {
      ...PROSPECT_REPORT_LABELS,
      cat_competitivePosition: "Position concurrentielle",
    };
    const markdown = assembleReport(
      BRIEFING,
      RESULTS,
      COMPOSITE,
      { ...BASE_SYNTHESIS, labels },
      BANT,
      null,
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
