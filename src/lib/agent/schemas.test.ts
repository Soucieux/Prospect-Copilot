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
        markdown: "# Matches\n",
      },
    });
    expect(parsed.type).toBe("report");
  });
});
