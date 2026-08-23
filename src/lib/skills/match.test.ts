import { afterEach, describe, expect, it, vi } from "vitest";
import {
  quickScoreCandidate,
  rankCandidates,
  renderMatchReport,
  resolveCandidates,
  runMatchSkill,
  type CandidateScore,
} from "./match";
import type { LlmConfig } from "@/lib/llm";
import { RUNTIME_LABEL_DEFAULTS } from "@/lib/localization";

vi.mock("@/lib/extract/fetch-page", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/extract/fetch-page")>();
  return {
    ...actual,
    fetchWithVariants: vi.fn(async (url: string) => ({
      url,
      status: 200,
      html: '<html><head><title>Acme</title><meta property="og:site_name" content="Acme Corp"></head><body>Payroll for growing teams</body></html>',
    })),
  };
});

import { fetchWithVariants } from "@/lib/extract/fetch-page";

const CONFIG: LlmConfig = {
  baseUrl: "https://api.example.com",
  apiKey: "test-key",
  model: "test-model",
};

const DEFAULT_SCORE_JSON = {
  companyName: "Acme Corp",
  score: 70,
  description: "Sells payroll and HR software to mid-market companies.",
  fitReason: "Decent fit for the described offering.",
};

/**
 * Stub the single chat-completions endpoint, branching the canned response
 * by which system prompt the call used (quick-score, candidate suggestion,
 * or name-to-URL resolution) since all three now hit the same LLM.
 */
function stubNetwork(options: {
  suggestJson?: Record<string, unknown>;
  urlGuess?: string;
  scoreJson?: Record<string, unknown>;
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as {
            messages?: { content?: string }[];
          })
        : {};
      const systemContent = body.messages?.[0]?.content ?? "";
      const content = systemContent.includes("discover real companies")
        ? JSON.stringify(options.suggestJson ?? { candidates: [] })
        : systemContent.includes("resolve a company or person's name")
          ? (options.urlGuess ?? "unknown")
          : JSON.stringify(options.scoreJson ?? DEFAULT_SCORE_JSON);
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
      );
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(fetchWithVariants).mockClear();
});

describe("rankCandidates", () => {
  const make = (name: string, score: number): CandidateScore => ({
    url: `https://${name}.example.com`,
    companyName: name,
    score,
    description: `${name} description`,
    fitReason: `${name} fit`,
    location: null,
    founded: null,
  });

  it("sorts by score descending", () => {
    const ranked = rankCandidates(
      [make("low", 20), make("high", 90), make("mid", 55)],
      5,
    );
    expect(ranked.map((c) => c.companyName)).toEqual(["high", "mid", "low"]);
  });

  it("truncates to the limit", () => {
    const candidates = [make("a", 10), make("b", 20), make("c", 30)];
    const ranked = rankCandidates(candidates, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((c) => c.companyName)).toEqual(["c", "b"]);
  });

  it("returns fewer than the limit when there aren't enough candidates", () => {
    const ranked = rankCandidates([make("only", 50)], 5);
    expect(ranked).toHaveLength(1);
  });
});

describe("renderMatchReport", () => {
  const acme: CandidateScore = {
    url: "https://acme.example.com",
    companyName: "Acme Corp",
    score: 82,
    description: "Acme Corp sells arts and crafts supplies online.",
    fitReason: "Strong fit: growing headcount and no existing payroll vendor.",
    location: "San Francisco, CA",
    founded: "1998",
  };

  it("lists ranked candidates with score, description, location, and founded", () => {
    const { markdown, title, matches } = renderMatchReport(
      "payroll software",
      [acme],
      1,
    );
    expect(markdown).toContain("Acme Corp");
    expect(markdown).toContain("82");
    expect(markdown).toContain("https://acme.example.com");
    expect(markdown).toContain("Acme Corp sells arts and crafts supplies online.");
    expect(markdown).toContain(
      "Strong fit: growing headcount and no existing payroll vendor.",
    );
    expect(markdown).toContain("San Francisco, CA");
    expect(markdown).toContain("1998");
    expect(matches).toEqual([acme]);
    expect(title.length).toBeGreaterThan(0);
  });

  it("omits the location/founded line when neither is known", () => {
    const { markdown } = renderMatchReport(
      "payroll software",
      [{ ...acme, location: null, founded: null }],
      1,
    );
    expect(markdown).not.toContain("Not publicly available");
  });

  it("notes when candidates were dropped from a larger pool", () => {
    const { markdown } = renderMatchReport("payroll software", [acme], 5);
    expect(markdown).toMatch(/5/);
  });

  it("renders a clear message when no candidates could be scored", () => {
    const { markdown, matches } = renderMatchReport("payroll software", [], 0);
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).not.toContain("undefined");
    expect(matches).toEqual([]);
  });

  it("uses translated labels when a custom label set is passed", () => {
    const labels = {
      titleTemplate: "Coincidencias para: {product}",
      titleFallback: "Coincidencias",
      noneScored: "Sin candidatos.",
      rankedTemplateSingular: "1 de {total} candidato:",
      rankedTemplatePlural: "{ranked} de {total} candidatos:",
      locationLabel: "Ubicación",
      foundedLabel: "Fundada",
      fitLabel: "Encaje",
      omittedTemplateSingular: "{count} candidato omitido.",
      omittedTemplatePlural: "{count} candidatos omitidos.",
      auditPrompt: "Pregunta por cualquiera de estos.",
      auditHint: "Haz clic para la auditoría completa →",
      auditRequestTemplate: "Analiza {url} como prospecto",
      nudge: "¿Qué vendes?",
    };
    const { markdown, title } = renderMatchReport(
      "software de nómina",
      [acme],
      3,
      labels,
    );
    expect(title).toBe("Coincidencias para: software de nómina");
    expect(markdown).toContain("1 de 3 candidatos:");
    expect(markdown).toContain("Ubicación: San Francisco, CA");
    expect(markdown).toContain("Fundada: 1998");
    expect(markdown).toContain("Encaje:");
    expect(markdown).toContain("2 candidatos omitidos.");
    expect(markdown).toContain("Pregunta por cualquiera de estos.");
  });
});

describe("resolveCandidates", () => {
  it("uses supplied URLs as-is without any LLM call", async () => {
    stubNetwork({});
    const result = await resolveCandidates(
      CONFIG,
      ["https://acme.example.com"],
      "payroll software",
    );
    expect(result.urls).toEqual(["https://acme.example.com/"]);
  });

  it("resolves a supplied company name via an LLM guess", async () => {
    stubNetwork({ urlGuess: "https://acme.example.com" });
    const result = await resolveCandidates(
      CONFIG,
      ["Acme Corp"],
      "payroll software",
    );
    expect(result.urls).toEqual(["https://acme.example.com/"]);
  });

  it("resolves a bare Unicode company name instead of making a Punycode URL", async () => {
    stubNetwork({ urlGuess: "https://www.ikea.cn" });
    const result = await resolveCandidates(
      CONFIG,
      ["宜家家居"],
      "羊毛毯",
      "我想去卖羊毛毯，如何选择",
      "Chinese",
    );
    expect(result.urls).toEqual(["https://www.ikea.cn/"]);
    expect(result.urls.some((url) => url.includes("xn--"))).toBe(false);
  });

  it("drops a product term rather than converting it into a Punycode URL", async () => {
    stubNetwork({ urlGuess: "unknown" });
    const result = await resolveCandidates(
      CONFIG,
      ["羊毛毯"],
      "羊毛毯",
      "羊毛毯",
      "Chinese",
    );
    expect(result.urls).toEqual([]);
  });

  it("rejects an explicitly prefixed product term as a single-label host", async () => {
    stubNetwork({});
    const result = await resolveCandidates(
      CONFIG,
      ["https://羊毛毯"],
      "羊毛毯",
      "羊毛毯",
      "Chinese",
    );
    expect(result.urls).toEqual([]);
  });

  it("drops a guessed URL that isn't a real company site", async () => {
    stubNetwork({ urlGuess: "https://linkedin.com/company/acme" });
    const result = await resolveCandidates(
      CONFIG,
      ["Acme Corp"],
      "payroll software",
    );
    expect(result.urls).toEqual([]);
  });

  it("returns an empty list when there is nothing to work with", async () => {
    const result = await resolveCandidates(CONFIG, null, null);
    expect(result.urls).toEqual([]);
  });

  it("asks the LLM to suggest candidates in discovery mode and resolves each", async () => {
    stubNetwork({
      suggestJson: {
        candidates: [
          { name: "Acme Corp", url: "https://acme.example.com" },
          { name: "Globex Inc", url: null },
        ],
      },
      urlGuess: "https://globex.example.com",
    });
    const result = await resolveCandidates(
      CONFIG,
      null,
      "payroll software",
      "どの会社を対象にすべきですか？",
      "Japanese",
    );
    expect(result.urls).toEqual([
      "https://acme.example.com/",
      "https://globex.example.com/",
    ]);
    const suggestionCall = vi.mocked(fetch).mock.calls.find((call) => {
      const body = JSON.parse(String(call[1]?.body)) as {
        messages?: { content?: string }[];
      };
      return body.messages?.[0]?.content?.includes("discover real companies");
    });
    const suggestionBody = JSON.parse(String(suggestionCall?.[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(suggestionBody.messages[1].content).toContain(
      "DETECTED RESPONSE LANGUAGE: Japanese",
    );
    expect(suggestionBody.messages[1].content).toContain(
      "どの会社を対象にすべきですか？",
    );
  });

  it("accepts up to twelve discovered candidates", async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      name: `Company ${index + 1}`,
      url: `https://company-${index + 1}.example.com`,
    }));
    stubNetwork({ suggestJson: { candidates } });
    const result = await resolveCandidates(
      CONFIG,
      null,
      "payroll software",
      "find companies",
      "English",
    );
    expect(result.urls).toHaveLength(12);
  });

  it("lets explicit geography override the dynamically detected language market", async () => {
    stubNetwork({ suggestJson: { candidates: [] } });
    await resolveCandidates(
      CONFIG,
      null,
      "plateforme de paie pour entreprises québécoises",
      "Trouvez des entreprises au Québec",
      "French",
    );
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(call[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[0].content).toMatch(
      /explicit country, region, or\s+market/i,
    );
    expect(body.messages[1].content).toContain("Québec");
  });

  it("discovers sellers with the existing candidate pipeline in buy mode", async () => {
    stubNetwork({ suggestJson: { candidates: [] } });
    await resolveCandidates(
      CONFIG,
      null,
      "羊毛毯",
      "哪里可以买到羊毛毯？",
      "Chinese",
      "buy",
    );
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(call[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[0].content).toContain(
      "for buy,\nsuggest plausible sellers",
    );
    expect(body.messages[1].content).toContain("MATCH DIRECTION: buy");
    expect(body.messages[1].content).toContain("PRODUCT CONTEXT: 羊毛毯");
  });
});

describe("quickScoreCandidate", () => {
  it("scores a candidate and fills description/fitReason from the LLM", async () => {
    stubNetwork({
      scoreJson: {
        score: 82,
        description: "Acme Corp is a payroll software vendor.",
        fitReason: "Strong fit for the described offering.",
      },
    });
    const result = await quickScoreCandidate(
      CONFIG,
      "payroll software",
      "https://acme.example.com",
    );
    expect(result).not.toBeNull();
    expect(result?.score).toBe(82);
    expect(result?.companyName).toBe("Acme Corp");
    expect(result?.description).toBe("Acme Corp is a payroll software vendor.");
    expect(result?.fitReason).toBe("Strong fit for the described offering.");
  });

  it("uses the official company name returned by scoring instead of the hostname", async () => {
    stubNetwork({
      scoreJson: {
        ...DEFAULT_SCORE_JSON,
        companyName: "Mattel, Inc.",
      },
    });
    const result = await quickScoreCandidate(
      CONFIG,
      "toys",
      "https://about.mattel.com",
    );
    expect(result?.companyName).toBe("Mattel, Inc.");
  });

  it("falls back to the retained discovery name when scoring omits a name", async () => {
    const { companyName: _companyName, ...scoreWithoutName } = DEFAULT_SCORE_JSON;
    stubNetwork({ scoreJson: scoreWithoutName });
    const result = await quickScoreCandidate(
      CONFIG,
      "toys",
      "https://about.mattel.com",
      "",
      "English",
      undefined,
      "Mattel, Inc.",
    );
    expect(result?.companyName).toBe("Mattel, Inc.");
  });

  it("fills location and founded from the page's own structured data", async () => {
    vi.mocked(fetchWithVariants).mockResolvedValueOnce({
      url: "https://acme.example.com",
      status: 200,
      html: `<html><head><title>Acme</title>
<script type="application/ld+json">{"@type":"Organization","name":"Acme Corp","foundingDate":"1998","address":"San Francisco, CA"}</script>
</head><body>Payroll for growing teams</body></html>`,
    });
    stubNetwork({});
    const result = await quickScoreCandidate(
      CONFIG,
      "payroll software",
      "https://acme.example.com",
    );
    expect(result?.location).toBe("San Francisco, CA");
    expect(result?.founded).toBe("1998");
  });

  it("leaves location and founded null when the page has no structured data", async () => {
    stubNetwork({});
    const result = await quickScoreCandidate(
      CONFIG,
      "payroll software",
      "https://acme.example.com",
    );
    expect(result?.location).toBeNull();
    expect(result?.founded).toBeNull();
  });

  it("returns null when the candidate can't be fetched", async () => {
    stubNetwork({});
    vi.mocked(fetchWithVariants).mockRejectedValueOnce(new Error("unreachable"));
    const result = await quickScoreCandidate(
      CONFIG,
      "payroll software",
      "https://unreachable.example.com",
    );
    expect(result).toBeNull();
  });

  it("does not drop other candidates when one fails", async () => {
    stubNetwork({
      scoreJson: {
        score: 60,
        description: "A candidate company.",
        fitReason: "Fine.",
      },
    });
    vi.mocked(fetchWithVariants).mockRejectedValueOnce(new Error("unreachable"));
    const results = await Promise.all([
      quickScoreCandidate(CONFIG, "payroll software", "https://bad.example.com"),
      quickScoreCandidate(CONFIG, "payroll software", "https://good.example.com"),
    ]);
    expect(results[0]).toBeNull();
    expect(results[1]?.score).toBe(60);
  });

  it("sends an arbitrary recognized language and the raw message to the LLM", async () => {
    stubNetwork({});
    await quickScoreCandidate(
      CONFIG,
      "payroll software",
      "https://acme.example.com",
      "quali aziende dovremmo contattare?",
      "Italian",
    );
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(call[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[1].content).toContain(
      "DETECTED RESPONSE LANGUAGE: Italian",
    );
    expect(body.messages[1].content).toContain(
      "quali aziende dovremmo contattare?",
    );
  });

  it("keeps an explicit response language even when the message is empty", async () => {
    stubNetwork({});
    await quickScoreCandidate(CONFIG, "payroll software", "https://acme.example.com");
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(call[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[1].content).toContain(
      "DETECTED RESPONSE LANGUAGE: English",
    );
  });

  it("scores purchase sources against what the user wants to buy", async () => {
    stubNetwork({});
    await quickScoreCandidate(
      CONFIG,
      "羊毛毯",
      "https://acme.example.com",
      "哪里可以买到羊毛毯？",
      "Chinese",
      undefined,
      null,
      "buy",
    );
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(call[1]?.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[1].content).toContain("MATCH DIRECTION: buy");
    expect(body.messages[1].content).toContain("WHAT WE WANT TO BUY: 羊毛毯");
  });

  it("omits labels entirely when no labelsToTranslate is given", async () => {
    stubNetwork({});
    const result = await quickScoreCandidate(
      CONFIG,
      "payroll software",
      "https://acme.example.com",
    );
    expect(result && "labels" in result).toBe(false);
  });

  it("returns merged translated labels when labelsToTranslate is given", async () => {
    stubNetwork({
      scoreJson: {
        ...DEFAULT_SCORE_JSON,
        labels: { foundedLabel: "Fondée", fitLabel: "" },
      },
    });
    const result = await quickScoreCandidate(
      CONFIG,
      "payroll software",
      "https://acme.example.com",
      "",
      "French",
      { foundedLabel: "Founded", fitLabel: "Fit", locationLabel: "Location" },
    );
    expect(result?.labels).toEqual({
      foundedLabel: "Fondée",
      fitLabel: "Fit",
      locationLabel: "Location",
    });
  });
});

describe("runMatchSkill", () => {
  it("scores and ranks a user-supplied candidate list", async () => {
    stubNetwork({
      scoreJson: {
        score: 75,
        description: "A payroll and HR software vendor.",
        fitReason: "Good fit.",
      },
    });
    const events: unknown[] = [];
    const { markdown, title, matches } = await runMatchSkill(
      CONFIG,
      "payroll software",
      ["https://acme.example.com", "https://globex.example.com"],
      (event) => events.push(event),
    );
    expect(markdown).toContain("Acme Corp");
    expect(markdown).toContain("75");
    expect(title.length).toBeGreaterThan(0);
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.score === 75)).toBe(true);
    const agentEvents = events.filter(
      (e): e is { type: string; status: string } =>
        typeof e === "object" && e !== null && (e as { type?: string }).type === "agent",
    );
    const doneEvents = agentEvents.filter((e) => e.status === "done");
    expect(agentEvents).toHaveLength(4); // running + done per candidate
    expect(doneEvents).toHaveLength(2);
  });

  it("returns up to eight successful matches", async () => {
    stubNetwork({ scoreJson: DEFAULT_SCORE_JSON });
    const candidates = Array.from(
      { length: 10 },
      (_, index) => `https://company-${index + 1}.example.com`,
    );
    const { matches } = await runMatchSkill(
      CONFIG,
      "payroll software",
      candidates,
      () => {},
    );
    expect(matches).toHaveLength(8);
  });

  it("emits localized progress and agent logs", async () => {
    stubNetwork({ scoreJson: DEFAULT_SCORE_JSON });
    const events: { type: string; detail?: string }[] = [];
    await runMatchSkill(
      CONFIG,
      "営業分析プラットフォーム",
      ["https://acme.example.com"],
      (event) => events.push(event),
      "どの会社を対象にすべきですか？",
      "Japanese",
      {
        ...RUNTIME_LABEL_DEFAULTS,
        resolvingCandidatesSingular: "指定された候補を確認しています",
        scoringCandidateSingular: "候補を評価しています",
        agentRunningTemplate: "{agent}: 実行中",
        agentDoneTemplate: "{agent}: 完了",
        matchComplete: "照合が完了しました",
      },
    );
    expect(events.map((event) => event.detail)).toEqual([
      "指定された候補を確認しています",
      "候補を評価しています",
      "https://acme.example.com/: 実行中",
      "https://acme.example.com/: 完了",
      "照合が完了しました",
    ]);
  });

  it("suggests and scores candidates via the LLM when none are named", async () => {
    stubNetwork({
      suggestJson: {
        candidates: [
          { name: "Acme Corp", url: "https://acme.example.com" },
          { name: "Globex Inc", url: "https://globex.example.com" },
        ],
      },
      scoreJson: {
        score: 60,
        description: "A payroll and HR software vendor.",
        fitReason: "Decent fit.",
      },
    });
    const { markdown } = await runMatchSkill(
      CONFIG,
      "payroll software",
      null,
      () => {},
    );
    expect(markdown).toContain("Acme Corp");
    expect(markdown).toContain("60");
  });

  it("renders a no-candidates report instead of throwing when nothing resolves", async () => {
    stubNetwork({ suggestJson: { candidates: [] } });
    const { markdown } = await runMatchSkill(
      CONFIG,
      "payroll software",
      null,
      () => {},
    );
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).not.toContain("undefined");
  });

  it("uses the first candidate's translated labels for the report and cards", async () => {
    stubNetwork({
      scoreJson: {
        ...DEFAULT_SCORE_JSON,
        labels: { foundedLabel: "Fondée", fitLabel: "Adéquation" },
      },
    });
    const { markdown, cardLabels } = await runMatchSkill(
      CONFIG,
      "payroll software",
      ["https://acme.example.com", "https://globex.example.com"],
      () => {},
      "quelles entreprises devrions-nous cibler ?",
      "French",
      {
        ...RUNTIME_LABEL_DEFAULTS,
        foundedLabel: "Fondée",
        fitLabel: "Adéquation",
      },
    );
    expect(cardLabels.founded).toBe("Fondée");
    expect(cardLabels.fit).toBe("Adéquation");
    expect(markdown).toContain("Adéquation:");
  });

  it("uses another successful candidate's labels when the first candidate fails", async () => {
    stubNetwork({
      scoreJson: {
        ...DEFAULT_SCORE_JSON,
        labels: { foundedLabel: "Fondée", fitLabel: "Adéquation" },
      },
    });
    vi.mocked(fetchWithVariants).mockRejectedValueOnce(new Error("unreachable"));
    const { cardLabels } = await runMatchSkill(
      CONFIG,
      "payroll software",
      ["https://bad.example.com", "https://good.example.com"],
      () => {},
      "quelles entreprises devrions-nous cibler ?",
      "French",
      {
        ...RUNTIME_LABEL_DEFAULTS,
        foundedLabel: "Fondée",
        fitLabel: "Adéquation",
      },
    );
    expect(cardLabels.founded).toBe("Fondée");
    expect(cardLabels.fit).toBe("Adéquation");
  });

  it("localizes no-candidate output during language-aware discovery", async () => {
    stubNetwork({
      suggestJson: {
        candidates: [],
        labels: {
          titleTemplate: "مطابقات العملاء المحتملين لـ: {product}",
          noneScored: "تعذر تقييم أي شركة مرشحة.",
          auditRequestTemplate: "حلل {url} كعميل محتمل",
        },
      },
    });
    const { markdown, cardLabels } = await runMatchSkill(
      CONFIG,
      "منصة تحليلات للمبيعات",
      null,
      () => {},
      "ما الشركات التي يجب أن نستهدفها؟",
      "Arabic",
      {
        ...RUNTIME_LABEL_DEFAULTS,
        auditRequestTemplate: "حلل {url} كعميل محتمل",
      },
    );
    expect(markdown).toContain("تعذر تقييم أي شركة مرشحة.");
    expect(cardLabels.auditRequestTemplate).toBe(
      "حلل {url} كعميل محتمل",
    );
  });

  it("uses the same ranked report and card structure for buy mode", async () => {
    stubNetwork({
      suggestJson: {
        candidates: [{ name: "IKEA", url: "https://ikea.example.com" }],
        labels: {
          titleTemplate: "购买地点：{product}",
          fitLabel: "购买匹配度",
          auditHint: "点击查看完整卖家分析 →",
          auditRequestTemplate: "将 {url} 作为供应商进行分析",
        },
      },
      scoreJson: {
        companyName: "IKEA",
        score: 84,
        description: "IKEA 销售家居用品。",
        fitReason: "其目录中提供相关产品。",
        labels: {
          titleTemplate: "购买地点：{product}",
          fitLabel: "购买匹配度",
          auditHint: "点击查看完整卖家分析 →",
          auditRequestTemplate: "将 {url} 作为供应商进行分析",
        },
      },
    });
    const result = await runMatchSkill(
      CONFIG,
      "羊毛毯",
      null,
      () => {},
      "哪里可以买到羊毛毯？",
      "Chinese",
      RUNTIME_LABEL_DEFAULTS,
      "buy",
    );
    expect(result.title).toBe("购买地点：羊毛毯");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].companyName).toBe("IKEA");
    expect(result.markdown).toContain("https://ikea.example.com");
    expect(result.cardLabels.fit).toBe("购买匹配度");
    expect(result.cardLabels.auditRequestTemplate).toContain("{url}");
  });
});
