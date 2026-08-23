import { describe, expect, it } from "vitest";
import {
  RUNTIME_LABEL_DEFAULTS,
  formatRuntimeLabel,
  localizedAgentName,
  localizedCategoryName,
  localizedConfidence,
  mergeRuntimeLabels,
  responseLanguageContext,
} from "./localization";

describe("runtime localization", () => {
  it("merges arbitrary-language labels while retaining required placeholders", () => {
    const labels = mergeRuntimeLabels({
      fetchingTemplate: "{target} を取得しています",
      agentDoneTemplate: "{agent}: 完了",
      confidenceHigh: "高",
    });
    expect(
      formatRuntimeLabel(labels.fetchingTemplate, { target: "Acme" }),
    ).toBe("Acme を取得しています");
    expect(labels.agentDoneTemplate).toBe("{agent}: 完了");
    expect(labels.matchComplete).toBe(RUNTIME_LABEL_DEFAULTS.matchComplete);
  });

  it("localizes visible agent, category, and confidence values", () => {
    const labels = mergeRuntimeLabels({
      agentCompanyResearch: "بحث الشركة",
      categoryCompanyFit: "ملاءمة الشركة",
      confidenceHigh: "عالية",
    });
    expect(localizedAgentName(labels, "Company Research")).toBe("بحث الشركة");
    expect(localizedCategoryName(labels, "Company Fit")).toBe(
      "ملاءمة الشركة",
    );
    expect(localizedConfidence(labels, "High")).toBe("عالية");
  });

  it("carries the recognized language independently of scraped content", () => {
    const context = responseLanguageContext(
      "Portuguese",
      "Quais empresas devemos procurar no Brasil?",
    );
    expect(context).toContain("DETECTED RESPONSE LANGUAGE: Portuguese");
    expect(context).toContain("Brasil");
  });
});
