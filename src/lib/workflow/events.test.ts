import { describe, expect, it } from "vitest";
import { RUNTIME_LABEL_DEFAULTS } from "@/lib/localization";
import { buildScoreLabels } from "@/lib/workflow/events";

describe("buildScoreLabels", () => {
  it("names the report after the localized skill", () => {
    const labels = buildScoreLabels(RUNTIME_LABEL_DEFAULTS, "prospect");
    expect(labels.report).toBe("prospect report");
    expect(labels.grade).toBe("Grade");
    expect(labels.confidenceValue).toBe("");
  });

  it("uses the translated skill name and confidence value", () => {
    const labels = buildScoreLabels(
      { ...RUNTIME_LABEL_DEFAULTS, skillMatch: "照合", reportTemplate: "{skill}レポート" },
      "match",
      "高",
    );
    expect(labels.report).toBe("照合レポート");
    expect(labels.confidenceValue).toBe("高");
  });
});
