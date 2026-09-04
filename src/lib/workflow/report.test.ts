import { describe, expect, it } from "vitest";
import { buildReport } from "@/lib/workflow/report";

const SCORE_LABELS = {
  grade: "Grade",
  confidence: "confidence",
  confidenceValue: "",
  report: "Report",
};

describe("buildReport", () => {
  it("defaults every field a skill did not populate to null", () => {
    const report = buildReport({
      kind: "research",
      companyName: "Acme",
      scoreLabels: SCORE_LABELS,
      markdown: "# Acme",
    });
    expect(report).toMatchObject({
      url: null,
      score: null,
      grade: null,
      confidence: null,
      categories: null,
      matches: null,
      matchLabels: null,
    });
  });

  it("keeps the fields the caller did populate", () => {
    const report = buildReport({
      kind: "prospect",
      companyName: "Acme",
      url: "https://acme.example.com",
      score: 72,
      grade: "B",
      scoreLabels: SCORE_LABELS,
      markdown: "# Acme",
    });
    expect(report.url).toBe("https://acme.example.com");
    expect(report.score).toBe(72);
    expect(report.grade).toBe("B");
    expect(report.matches).toBeNull();
  });
});
