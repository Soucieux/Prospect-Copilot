import { describe, expect, it } from "vitest";
import { subagentUserMessage } from "./subagents";

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
