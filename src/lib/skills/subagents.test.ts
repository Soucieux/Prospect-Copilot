import { describe, expect, it } from "vitest";
import { SUBAGENTS, subagentUserMessage } from "./subagents";

describe("SUBAGENTS", () => {
  it("gives every agent scoring dimensions that can reach exactly 100", () => {
    for (const definition of SUBAGENTS) {
      const scale = definition.systemPrompt.match(
        /Score these (?:five )?dimensions \(0-(\d+) each/,
      );
      expect(scale, `${definition.name} declares no scoring scale`).not.toBeNull();
      const perDimensionMax = Number(scale?.[1]);
      const dimensionBlock =
        definition.systemPrompt
          .split(/Score these (?:five )?dimensions[^\n]*\n/)[1]
          ?.split("\n\n")[0] ?? "";
      const dimensions = dimensionBlock
        .split("\n")
        .filter((line) => line.startsWith("- "));
      expect(
        dimensions.length * perDimensionMax,
        `${definition.name} dimensions sum to ${dimensions.length * perDimensionMax}, not 100`,
      ).toBe(100);
    }
  });

  it("keeps the design doc's category weights summing to one", () => {
    const total = SUBAGENTS.reduce((sum, agent) => sum + agent.weight, 0);
    expect(Number(total.toFixed(2))).toBe(1);
  });
});

describe("subagentUserMessage", () => {
  it("always carries the router-recognized response language", () => {
    const message = subagentUserMessage("{}", null);
    expect(message).toContain("DETECTED RESPONSE LANGUAGE: English");
  });

  it("includes an arbitrary recognized language and the requester's message", () => {
    const message = subagentUserMessage(
      "{}",
      null,
      "この会社を分析してください",
      "Japanese",
    );
    expect(message).toContain("DETECTED RESPONSE LANGUAGE: Japanese");
    expect(message).toContain("この会社を分析してください");
  });

  it("still includes the WHAT WE SELL line and the discovery briefing", () => {
    const message = subagentUserMessage(
      '{"url":"https://acme.example.com"}',
      "payroll software",
      "wer sollte das kaufen?",
      "German",
    );
    expect(message).toContain("DETECTED RESPONSE LANGUAGE: German");
    expect(message).toContain("WHAT WE SELL: payroll software");
    expect(message).toContain("wer sollte das kaufen?");
    expect(message).toContain('"url":"https://acme.example.com"');
  });
});
