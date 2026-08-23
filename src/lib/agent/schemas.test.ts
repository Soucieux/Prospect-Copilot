import { describe, expect, it } from "vitest";
import { CHAT_EVENT_SCHEMA, ROUTER_RESULT_SCHEMA } from "./schemas";

describe("ROUTER_RESULT_SCHEMA", () => {
  it("accepts skill 'match' with a candidates list", () => {
    const parsed = ROUTER_RESULT_SCHEMA.parse({
      skill: "match",
      url: null,
      entity: null,
      sellingContext: "payroll software for mid-market companies",
      candidates: ["Acme Corp", "https://widget.example.com"],
    });
    expect(parsed.skill).toBe("match");
    expect(parsed.candidates).toEqual([
      "Acme Corp",
      "https://widget.example.com",
    ]);
  });

  it("accepts skill 'match' with candidates null for discovery mode", () => {
    const parsed = ROUTER_RESULT_SCHEMA.parse({
      skill: "match",
      url: null,
      entity: null,
      sellingContext: "payroll software",
      candidates: null,
    });
    expect(parsed.candidates).toBeNull();
    expect(parsed.matchDirection).toBe("sell");
  });

  it("accepts buy direction while preserving the match result shape", () => {
    const parsed = ROUTER_RESULT_SCHEMA.parse({
      skill: "match",
      url: null,
      entity: null,
      sellingContext: "羊毛毯",
      matchDirection: "buy",
      matchLocation: "多伦多",
      candidates: null,
    });
    expect(parsed.skill).toBe("match");
    expect(parsed.matchDirection).toBe("buy");
    expect(parsed.sellingContext).toBe("羊毛毯");
    expect(parsed.matchLocation).toBe("多伦多");
  });

  it("treats a null direction from older router output as sell mode", () => {
    const parsed = ROUTER_RESULT_SCHEMA.parse({
      skill: "prospect",
      url: "https://acme.example.com",
      entity: null,
      sellingContext: null,
      matchDirection: null,
      candidates: null,
    });
    expect(parsed.matchDirection).toBe("sell");
    expect(parsed.matchLocation).toBeNull();
  });

  it("accepts any recognized language and translated runtime labels", () => {
    const parsed = ROUTER_RESULT_SCHEMA.parse({
      skill: "match",
      url: null,
      entity: null,
      sellingContext: "分析ツール",
      candidates: null,
      language: "Japanese",
      runtimeLabels: { matchComplete: "照合が完了しました" },
    });
    expect(parsed.language).toBe("Japanese");
    expect(parsed.runtimeLabels.matchComplete).toBe("照合が完了しました");
  });
});

describe("CHAT_EVENT_SCHEMA", () => {
  it("accepts a report event with kind 'match'", () => {
    const parsed = CHAT_EVENT_SCHEMA.parse({
      type: "report",
      report: {
        kind: "match",
        companyName: "Prospect matches",
        url: null,
        score: null,
        grade: null,
        confidence: null,
        categories: null,
        matches: [
          {
            url: "https://acme.example.com",
            companyName: "Acme Corp",
            score: 82,
            description: "Acme Corp sells payroll software.",
            fitReason: "Strong fit.",
            location: "San Francisco, CA",
            founded: "1998",
          },
        ],
        matchLabels: {
          founded: "Founded",
          fit: "Fit",
          auditHint: "Click →",
          auditRequestTemplate: "Analyze {url} as a prospect",
        },
        scoreLabels: {
          grade: "Grade",
          confidence: "confidence",
          confidenceValue: "High",
          report: "match report",
        },
        markdown: "# Matches\n",
      },
    });
    expect(parsed.type).toBe("report");
  });
});
