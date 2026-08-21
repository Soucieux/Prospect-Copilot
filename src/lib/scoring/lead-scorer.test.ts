import { describe, expect, it } from "vitest";
import {
  computeProspectScore,
  gradeFromScore,
  confidenceFromCompletion,
  scoreBant,
  scoreMeddic,
  type ProspectSignals,
} from "./lead-scorer";

const STRONG_SIGNALS: ProspectSignals = {
  fundingTotalUsd: 25_000_000,
  employeeCount: 350,
  hasPricingPage: true,
  enterpriseTierListed: true,
  decisionMakersFound: 4,
  cSuiteIdentified: true,
  painPointsDetected: 3,
  reviewsMentioningPain: 5,
  recentFundingWithin12Months: true,
  activeJobPostings: 14,
};

const EMPTY_SIGNALS: ProspectSignals = {};

describe("scoreBant", () => {
  it("scores a strong prospect above 75", () => {
    const result = scoreBant(STRONG_SIGNALS);
    expect(result.total).toBeGreaterThan(75);
    expect(result.dimensions).toHaveLength(4);
    expect(result.dimensions.every((d) => d.score <= 25)).toBe(true);
  });

  it("scores an empty signal blob at zero with no fabrication", () => {
    const result = scoreBant(EMPTY_SIGNALS);
    expect(result.total).toBe(0);
    expect(result.grade).toBe("D");
    expect(result.dimensions.every((d) => d.evidence.includes("no "))).toBe(
      true,
    );
  });

  it("caps every dimension at its 25-point maximum", () => {
    const exaggerated: ProspectSignals = {
      ...STRONG_SIGNALS,
      decisionMakersFound: 50,
      painPointsDetected: 50,
      reviewsMentioningPain: 50,
      activeJobPostings: 500,
      contractRenewalWindowMonths: 3,
    };
    const result = scoreBant(exaggerated);
    expect(result.total).toBe(100);
    expect(result.dimensions.every((d) => d.score === 25)).toBe(true);
  });

  it("awards partial credit for moderate signals", () => {
    const moderate: ProspectSignals = {
      fundingTotalUsd: 5_000_000,
      employeeCount: 80,
      decisionMakersFound: 1,
      painPointsDetected: 1,
      activeJobPostings: 3,
    };
    const result = scoreBant(moderate);
    expect(result.total).toBeGreaterThan(0);
    expect(result.total).toBeLessThan(60);
  });
});

describe("scoreMeddic", () => {
  it("returns 100 percent when all six elements are present", () => {
    const result = scoreMeddic({
      metrics: true,
      economicBuyer: true,
      decisionCriteria: true,
      decisionProcess: true,
      identifyPain: true,
      champion: true,
    });
    expect(result.completenessPercent).toBe(100);
    expect(result.elements).toHaveLength(6);
  });

  it("returns 0 percent when nothing is present", () => {
    expect(scoreMeddic({}).completenessPercent).toBe(0);
  });

  it("treats undefined and false identically", () => {
    expect(scoreMeddic({ metrics: false }).completenessPercent).toBe(
      scoreMeddic({}).completenessPercent,
    );
  });
});

describe("computeProspectScore", () => {
  it("computes the documented weighted blend", () => {
    const result = computeProspectScore({
      companyFit: 100,
      contactAccess: 100,
      opportunityQuality: 100,
      competitivePosition: 100,
      outreachReadiness: 100,
    });
    expect(result.score).toBe(100);
    expect(result.grade).toBe("A+");
    expect(result.confidence).toBe("High");
    expect(result.degradedCategories).toHaveLength(0);
  });

  it("applies the neutral 50 for missing categories and drops confidence", () => {
    const result = computeProspectScore({
      companyFit: 100,
    });
    expect(result.degradedCategories).toHaveLength(4);
    expect(result.score).toBe(Math.round(100 * 0.25 + 50 * 0.75));
    expect(result.confidence).toBe("Very Low");
  });

  it("weights company fit heaviest in a mixed scenario", () => {
    const result = computeProspectScore({
      companyFit: 80,
      contactAccess: 40,
      opportunityQuality: 60,
      competitivePosition: 20,
      outreachReadiness: 60,
    });
    expect(result.score).toBe(
      Math.round(80 * 0.25 + 40 * 0.2 + 60 * 0.2 + 20 * 0.15 + 60 * 0.2),
    );
    expect(result.grade).toBe("C");
  });
});

describe("grade and confidence helpers", () => {
  it("maps grade boundaries per the design doc", () => {
    expect(gradeFromScore(90)).toBe("A+");
    expect(gradeFromScore(89)).toBe("A");
    expect(gradeFromScore(75)).toBe("A");
    expect(gradeFromScore(74)).toBe("B");
    expect(gradeFromScore(60)).toBe("B");
    expect(gradeFromScore(59)).toBe("C");
    expect(gradeFromScore(40)).toBe("C");
    expect(gradeFromScore(39)).toBe("D");
    expect(gradeFromScore(0)).toBe("D");
  });

  it("derives confidence from completion count", () => {
    expect(confidenceFromCompletion(5)).toBe("High");
    expect(confidenceFromCompletion(4)).toBe("Medium");
    expect(confidenceFromCompletion(3)).toBe("Low");
    expect(confidenceFromCompletion(2)).toBe("Very Low");
    expect(confidenceFromCompletion(0)).toBe("Very Low");
  });
});
