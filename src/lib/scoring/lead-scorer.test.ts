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

describe("scoreBant budget funding", () => {
  it("does not score or label a reported zero as a small funding total", () => {
    const zero = scoreBant({ fundingTotalUsd: 0 }).dimensions.find(
      (dimension) => dimension.name === "budget",
    );
    expect(zero?.score).toBe(0);
    expect(zero?.evidence).not.toContain("small funding total");
  });

  it("still scores a genuine small raise", () => {
    const small = scoreBant({ fundingTotalUsd: 250_000 }).dimensions.find(
      (dimension) => dimension.name === "budget",
    );
    expect(small?.score).toBe(4);
    expect(small?.evidence).toContain("small funding total");
  });
});

describe("scoreMeddic renewal timing", () => {
  it("marks a distant renewal window looked-for-and-absent, not evidence", () => {
    const element = scoreMeddic({
      contractRenewalWindowMonths: 24,
    }).elements.find((candidate) => candidate.code === "Dp");
    const renewal = element?.checks.find(
      (check) => check.label === "contract renewal window",
    );
    expect(renewal).toMatchObject({ assessed: true, present: false });
  });

  it("counts a near renewal window as evidence", () => {
    const element = scoreMeddic({
      contractRenewalWindowMonths: 3,
    }).elements.find((candidate) => candidate.code === "Dp");
    const renewal = element?.checks.find(
      (check) => check.label === "contract renewal window",
    );
    expect(renewal).toMatchObject({ assessed: true, present: true });
  });
});

describe("scoreMeddic", () => {
  /**
   * Read one element's graded percentage out of a MEDDIC result.
   * @param signals discovery signals to score
   * @param code the MEDDIC element code
   * @returns that element's percentage
   */
  const percentFor = (signals: ProspectSignals, code: string): number =>
    scoreMeddic(signals).elements.find((element) => element.code === code)
      ?.percent ?? -1;

  it("returns 0 percent for every element when nothing was collected", () => {
    const result = scoreMeddic({});
    expect(result.completenessPercent).toBe(0);
    expect(result.elements).toHaveLength(6);
    expect(result.elements.every((element) => element.percent === 0)).toBe(true);
  });

  it("grades an element by the share of its signals, not all-or-nothing", () => {
    // Metrics checks funding, employee count, and pain points: 1 of 3.
    expect(percentFor({ employeeCount: 120 }, "M")).toBe(33);
    expect(
      percentFor({ employeeCount: 120, fundingTotalUsd: 5_000_000 }, "M"),
    ).toBe(67);
    expect(
      percentFor(
        {
          employeeCount: 120,
          fundingTotalUsd: 5_000_000,
          painPointsDetected: 2,
        },
        "M",
      ),
    ).toBe(100);
  });

  it("reaches 100 percent on a two-signal element with both signals", () => {
    expect(
      percentFor({ cSuiteIdentified: true, decisionMakersFound: 3 }, "E"),
    ).toBe(100);
    expect(percentFor({ decisionMakersFound: 3 }, "E")).toBe(50);
  });

  it("averages the six element percentages into overall completeness", () => {
    const result = scoreMeddic(STRONG_SIGNALS);
    const mean = Math.round(
      result.elements.reduce((sum, element) => sum + element.percent, 0) /
        result.elements.length,
    );
    expect(result.completenessPercent).toBe(mean);
  });

  it("lists the missing signals behind a partial element", () => {
    const metrics = scoreMeddic({ employeeCount: 120 }).elements.find(
      (element) => element.code === "M",
    );
    const missing = metrics?.checks
      .filter((check) => !check.present)
      .map((check) => check.label);
    expect(missing).toEqual(["funding amount", "pain points"]);
  });

  it("raises Identify Pain once the subagent evidences pain and hiring", () => {
    expect(percentFor({}, "I")).toBe(0);
    expect(
      percentFor({ painPointsDetected: 3, activeJobPostings: 12 }, "I"),
    ).toBe(100);
  });

  it("excludes uncollectable signals so every element can still reach 100", () => {
    const complete = scoreMeddic({
      fundingTotalUsd: 5_000_000,
      employeeCount: 120,
      painPointsDetected: 3,
      cSuiteIdentified: true,
      decisionMakersFound: 3,
      hasPricingPage: true,
      techStackCount: 4,
      orgChartMapped: true,
      activeJobPostings: 12,
    });
    expect(complete.completenessPercent).toBe(100);
    expect(complete.elements.every((element) => element.percent === 100)).toBe(
      true,
    );
  });

  it("marks review and renewal evidence unassessed rather than absent", () => {
    const elements = scoreMeddic({}).elements;
    const unassessed = elements.flatMap((element) =>
      element.checks.filter((check) => !check.assessed).map((c) => c.label),
    );
    expect(unassessed).toEqual([
      "reviews mention pain",
      "contract renewal window",
      "competitor complaints",
    ]);
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
