import { describe, expect, it } from "vitest";
import { MATCH_REPORT_LABELS, type CandidateScore } from "@/lib/skills/match";
import { renderMatchReport } from "@/lib/skills/match-report";

/**
 * Build one scored candidate with only the fields under test.
 * @param overrides candidate fields the assertion cares about
 * @returns a complete candidate score
 */
function candidate(overrides: Partial<CandidateScore> = {}): CandidateScore {
  return {
    url: "https://northwind.example.com",
    companyName: "Northwind Trading",
    score: 88,
    description: "Mid-market distributor.",
    fitReason: "Headcount fits the target band.",
    location: null,
    founded: null,
    ...overrides,
  };
}

describe("renderMatchReport titles", () => {
  it("names the product alone when no location was requested", () => {
    const { title } = renderMatchReport("payroll software", [candidate()], 1);
    expect(title).toBe("Prospect matches for: payroll software");
  });

  it("names both the product and the location when both were given", () => {
    const { title } = renderMatchReport(
      "payroll software",
      [candidate()],
      1,
      MATCH_REPORT_LABELS,
      "Leeds",
    );
    expect(title).toBe("Prospect matches for: payroll software in Leeds");
  });

  it("names the location alone when only a place was given", () => {
    const { title } = renderMatchReport(
      null,
      [candidate()],
      1,
      MATCH_REPORT_LABELS,
      "Leeds",
    );
    expect(title).toBe("Prospect matches in Leeds");
  });
});

describe("renderMatchReport candidate rows", () => {
  it("omits the detail line when a candidate has neither location nor founding date", () => {
    const { markdown } = renderMatchReport("payroll", [candidate()], 1);
    expect(markdown).toContain("**Northwind Trading** - 88/100");
    expect(markdown).not.toContain("Location:");
    expect(markdown).not.toContain("Founded:");
  });

  it("shows only the location when no founding date is known", () => {
    const { markdown } = renderMatchReport(
      "payroll",
      [candidate({ location: "Leeds, UK" })],
      1,
    );
    expect(markdown).toContain("Location: Leeds, UK");
    expect(markdown).not.toContain("Founded:");
  });

  it("shows only the founding date when no location is known", () => {
    const { markdown } = renderMatchReport(
      "payroll",
      [candidate({ founded: "1998" })],
      1,
    );
    expect(markdown).toContain("Founded: 1998");
    expect(markdown).not.toContain("Location:");
  });

  it("joins location and founding date on one line", () => {
    const { markdown } = renderMatchReport(
      "payroll",
      [candidate({ location: "Leeds, UK", founded: "1998" })],
      1,
    );
    expect(markdown).toContain("Location: Leeds, UK · Founded: 1998");
  });
});

describe("renderMatchReport truncation notice", () => {
  it("says nothing when every candidate considered was ranked", () => {
    const { markdown } = renderMatchReport("payroll", [candidate()], 1);
    expect(markdown).not.toMatch(/omitted|lower[- ]scoring/i);
  });

  it("reports a single omitted candidate in the singular", () => {
    const { markdown } = renderMatchReport("payroll", [candidate()], 2);
    expect(markdown).toContain(
      MATCH_REPORT_LABELS.omittedTemplateSingular.replace("{count}", "1"),
    );
  });

  it("reports several omitted candidates in the plural", () => {
    const { markdown } = renderMatchReport("payroll", [candidate()], 4);
    expect(markdown).toContain(
      MATCH_REPORT_LABELS.omittedTemplatePlural.replace("{count}", "3"),
    );
  });
});
