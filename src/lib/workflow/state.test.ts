import { describe, expect, it } from "vitest";
import { requireStageValue } from "@/lib/workflow/state";

describe("requireStageValue", () => {
  it("returns a value the previous stage produced", () => {
    expect(requireStageValue("https://acme.example.com", "discover")).toBe(
      "https://acme.example.com",
    );
    expect(requireStageValue(0, "scoring")).toBe(0);
    expect(requireStageValue(false, "scoring")).toBe(false);
  });

  it("names the stage whose ordering broke when the input is absent", () => {
    expect(() => requireStageValue(null, "briefing")).toThrow(
      /briefing ran before its input was produced/,
    );
    expect(() => requireStageValue(undefined, "analysis")).toThrow(
      /analysis ran before its input was produced/,
    );
  });
});
