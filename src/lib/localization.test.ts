import { describe, expect, it } from "vitest";
import {
  RUNTIME_LABEL_DEFAULTS,
  buildScoreLabels,
  formatRuntimeLabel,
  localizedAgentName,
  localizedCategoryName,
  localizedConfidence,
  matchCardLabels,
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

  it("inserts a value verbatim even when it looks like a replacement pattern", () => {
    expect(
      formatRuntimeLabel("Fetching {target}", { target: "https://a.example/?q=$&x" }),
    ).toBe("Fetching https://a.example/?q=$&x");
    expect(formatRuntimeLabel("{product} matches", { product: "Save $$ now" })).toBe(
      "Save $$ now matches",
    );
  });

  it("localizes visible agent, category, and confidence values by category key", () => {
    const labels = mergeRuntimeLabels({
      agentCompanyResearch: "بحث الشركة",
      categoryCompanyFit: "ملاءمة الشركة",
      confidenceHigh: "عالية",
    });
    expect(localizedAgentName(labels, "companyFit")).toBe("بحث الشركة");
    expect(localizedCategoryName(labels, "companyFit")).toBe("ملاءمة الشركة");
    expect(localizedConfidence(labels, "High")).toBe("عالية");
  });

  it("returns an unknown confidence value unchanged", () => {
    expect(localizedConfidence(RUNTIME_LABEL_DEFAULTS, "Certain")).toBe(
      "Certain",
    );
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

describe("matchCardLabels", () => {
  it("takes the sell-direction card chrome from the router translations", () => {
    const labels = matchCardLabels({
      ...RUNTIME_LABEL_DEFAULTS,
      foundedLabel: "Fondée",
      fitLabel: "Adéquation",
      auditHint: "Cliquez pour l'audit complet →",
      auditRequestTemplate: "Analyser {url} comme prospect",
    });
    expect(labels).toEqual({
      founded: "Fondée",
      fit: "Adéquation",
      auditHint: "Cliquez pour l'audit complet →",
      auditRequestTemplate: "Analyser {url} comme prospect",
    });
  });
});
