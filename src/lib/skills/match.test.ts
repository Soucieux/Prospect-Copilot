import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MATCH_REPORT_LABELS,
  quickScoreCandidate,
  resolveCandidates,
  resolveMatchCandidatesStage,
  scoreMatchCandidatesStage,
  type CandidatePool,
  type CandidateScore,
  type MatchRequest,
  type ResolvedCandidate,
} from "./match";
import {
  formatMatchSkillResult,
  rankCandidates,
  renderMatchReport,
} from "./match-report";
import type { EmitCallback } from "@/lib/agent/schemas";
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
 * Build one match request with only the fields under test.
 * @param overrides request fields the assertion cares about
 * @returns a complete match request
 */
function request(overrides: Partial<MatchRequest> = {}): MatchRequest {
  return {
    sellingContext: "payroll software",
    candidates: null,
    requesterMessage: "",
    responseLanguage: "English",
    runtimeLabels: RUNTIME_LABEL_DEFAULTS,
    matchDirection: "sell",
    matchLocation: null,
    ...overrides,
  };
}

/**
 * Build one resolved candidate for a homepage URL.
 * @param url the resolved homepage
 * @param nameHint the name discovery gave it, when any
 * @returns the candidate as the scoring stage receives it
 */
function candidate(url: string, nameHint: string | null = null): ResolvedCandidate {
  return { url, nameHint };
}

/**
 * Read the resolved URLs out of a candidate pool.
 * @param pool the resolution stage output
 * @returns the URLs in pool order
 */
function urlsOf(pool: CandidatePool): string[] {
  return pool.candidates.map((entry) => entry.url);
}

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

/**
 * Read the messages one provider call carried.
 * @param index which provider call to read
 * @returns the messages that call carried
 */
function messagesOfCall(index = 0): { content: string }[] {
  const call = vi.mocked(fetch).mock.calls[index];
  const body = JSON.parse(String(call?.[1]?.body)) as {
    messages: { content: string }[];
  };
  return body.messages;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(fetchWithVariants).mockClear();
});

describe("rankCandidates", () => {
  /**
   * Build one scored candidate with a given name and score.
   * @param name company name, also used to build a distinct URL
   * @param score fit score to rank on
   * @returns a complete candidate score
   */
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
    const { markdown, title } = renderMatchReport("payroll software", [acme], 1);
    expect(markdown).toContain("Acme Corp");
    expect(markdown).toContain("82");
    expect(markdown).toContain("https://acme.example.com");
    expect(markdown).toContain("Acme Corp sells arts and crafts supplies online.");
    expect(markdown).toContain(
      "Strong fit: growing headcount and no existing payroll vendor.",
    );
    expect(markdown).toContain("San Francisco, CA");
    expect(markdown).toContain("1998");
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
    const { markdown } = renderMatchReport("payroll software", [], 0);
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).not.toContain("undefined");
  });

  it("uses translated labels when a custom label set is passed", () => {
    const labels = {
      titleTemplate: "Coincidencias para: {product}",
      titleFallback: "Coincidencias",
      titleWithLocationTemplate:
        "Coincidencias para: {product} en {location}",
      locationTitleTemplate: "Coincidencias en {location}",
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

    const located = renderMatchReport(
      "software de nómina",
      [acme],
      1,
      labels,
      "Québec",
    );
    expect(located.title).toBe(
      "Coincidencias para: software de nómina en Québec",
    );
  });
});

describe("resolveCandidates", () => {
  it("uses supplied URLs as-is without any LLM call", async () => {
    stubNetwork({});
    const pool = await resolveCandidates(
      CONFIG,
      request({ candidates: ["https://acme.example.com"] }),
    );
    expect(urlsOf(pool)).toEqual(["https://acme.example.com/"]);
    expect(pool.candidates[0]?.nameHint).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves a supplied company name via an LLM guess and keeps the name", async () => {
    stubNetwork({ urlGuess: "https://acme.example.com" });
    const pool = await resolveCandidates(
      CONFIG,
      request({ candidates: ["Acme Corp"] }),
    );
    expect(urlsOf(pool)).toEqual(["https://acme.example.com/"]);
    expect(pool.candidates[0]?.nameHint).toBe("Acme Corp");
  });

  it("resolves a bare Unicode company name instead of making a Punycode URL", async () => {
    stubNetwork({ urlGuess: "https://www.ikea.cn" });
    const pool = await resolveCandidates(
      CONFIG,
      request({
        candidates: ["宜家家居"],
        sellingContext: "羊毛毯",
        requesterMessage: "我想去卖羊毛毯，如何选择",
        responseLanguage: "Chinese",
      }),
    );
    expect(urlsOf(pool)).toEqual(["https://www.ikea.cn/"]);
    expect(urlsOf(pool).some((url) => url.includes("xn--"))).toBe(false);
  });

  it("drops a product term rather than converting it into a Punycode URL", async () => {
    stubNetwork({ urlGuess: "unknown" });
    const pool = await resolveCandidates(
      CONFIG,
      request({
        candidates: ["羊毛毯"],
        sellingContext: "羊毛毯",
        requesterMessage: "羊毛毯",
        responseLanguage: "Chinese",
      }),
    );
    expect(urlsOf(pool)).toEqual([]);
  });

  it("rejects an explicitly prefixed product term as a single-label host", async () => {
    stubNetwork({});
    const pool = await resolveCandidates(
      CONFIG,
      request({
        candidates: ["https://羊毛毯"],
        sellingContext: "羊毛毯",
        requesterMessage: "羊毛毯",
        responseLanguage: "Chinese",
      }),
    );
    expect(urlsOf(pool)).toEqual([]);
  });

  it("drops a guessed URL that isn't a real company site", async () => {
    stubNetwork({ urlGuess: "https://linkedin.com/company/acme" });
    const pool = await resolveCandidates(
      CONFIG,
      request({ candidates: ["Acme Corp"] }),
    );
    expect(urlsOf(pool)).toEqual([]);
  });

  it("returns an empty list when there is nothing to work with", async () => {
    const pool = await resolveCandidates(
      CONFIG,
      request({ candidates: null, sellingContext: null }),
    );
    expect(urlsOf(pool)).toEqual([]);
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
    const pool = await resolveCandidates(
      CONFIG,
      request({
        requesterMessage: "どの会社を対象にすべきですか？",
        responseLanguage: "Japanese",
      }),
    );
    expect(urlsOf(pool)).toEqual([
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
    expect(suggestionBody.messages[1]?.content).toContain(
      "DETECTED RESPONSE LANGUAGE: Japanese",
    );
    expect(suggestionBody.messages[1]?.content).toContain(
      "どの会社を対象にすべきですか？",
    );
  });

  it("accepts up to twelve discovered candidates", async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      name: `Company ${index + 1}`,
      url: `https://company-${index + 1}.example.com`,
    }));
    stubNetwork({ suggestJson: { candidates } });
    const pool = await resolveCandidates(
      CONFIG,
      request({ requesterMessage: "find companies" }),
    );
    expect(urlsOf(pool)).toHaveLength(12);
  });

  it("bounds explicit candidate resolution work before starting workers", async () => {
    const candidates = Array.from(
      { length: 20 },
      (_, index) => `Company ${index + 1}`,
    );
    stubNetwork({ urlGuess: "https://resolved.example.com" });

    const pool = await resolveCandidates(CONFIG, request({ candidates }));

    expect(urlsOf(pool)).toEqual(["https://resolved.example.com/"]);
    expect(fetch).toHaveBeenCalledTimes(12);
  });

  it("lets explicit geography override the dynamically detected language market", async () => {
    stubNetwork({ suggestJson: { candidates: [] } });
    await resolveCandidates(
      CONFIG,
      request({
        sellingContext: "plateforme de paie pour entreprises québécoises",
        requesterMessage: "Trouvez des entreprises au Québec",
        responseLanguage: "French",
        matchLocation: "Québec",
      }),
    );
    const messages = messagesOfCall();
    expect(messages[0]?.content).toContain(
      "REQUESTED LOCATION, it is a hard discovery",
    );
    expect(messages[1]?.content).toContain("REQUESTED LOCATION: Québec");
  });

  it("discovers sellers with the existing candidate pipeline in buy mode", async () => {
    stubNetwork({ suggestJson: { candidates: [] } });
    await resolveCandidates(
      CONFIG,
      request({
        sellingContext: "羊毛毯",
        requesterMessage: "哪里可以买到羊毛毯？",
        responseLanguage: "Chinese",
        matchDirection: "buy",
        matchLocation: "多伦多",
      }),
    );
    const messages = messagesOfCall();
    expect(messages[0]?.content).toContain(
      "for buy,\nsuggest plausible sellers",
    );
    expect(messages[1]?.content).toContain("MATCH DIRECTION: buy");
    expect(messages[1]?.content).toContain("PRODUCT CONTEXT: 羊毛毯");
    expect(messages[1]?.content).toContain("REQUESTED LOCATION: 多伦多");
  });

  it("retains language-based market inference when no location is supplied", async () => {
    stubNetwork({ suggestJson: { candidates: [] } });
    await resolveCandidates(
      CONFIG,
      request({
        requesterMessage: "quali aziende dovremmo contattare?",
        responseLanguage: "Italian",
      }),
    );
    const messages = messagesOfCall();
    expect(messages[0]?.content).toContain(
      "only when REQUESTED LOCATION is absent",
    );
    expect(messages[1]?.content).toContain(
      "REQUESTED LOCATION: not specified",
    );
  });
});

describe("quickScoreCandidate", () => {
  const acme = candidate("https://acme.example.com");

  it("scores a candidate and fills description/fitReason from the LLM", async () => {
    stubNetwork({
      scoreJson: {
        companyName: "Acme Corp",
        score: 82,
        description: "Acme Corp is a payroll software vendor.",
        fitReason: "Strong fit for the described offering.",
      },
    });
    const result = await quickScoreCandidate(CONFIG, acme, request());
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
      candidate("https://about.mattel.com"),
      request({ sellingContext: "toys" }),
    );
    expect(result?.companyName).toBe("Mattel, Inc.");
  });

  it("repairs and then omits a candidate when scoring omits its name", async () => {
    const { companyName: _companyName, ...scoreWithoutName } = DEFAULT_SCORE_JSON;
    stubNetwork({ scoreJson: scoreWithoutName });
    const result = await quickScoreCandidate(
      CONFIG,
      candidate("https://about.mattel.com", "Mattel, Inc."),
      request({ sellingContext: "toys" }),
    );
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends the discovery name hint with the homepage evidence", async () => {
    stubNetwork({});
    await quickScoreCandidate(
      CONFIG,
      candidate("https://about.mattel.com", "Mattel, Inc."),
      request({ sellingContext: "toys" }),
    );
    expect(messagesOfCall()[1]?.content).toContain(
      "CANDIDATE NAME HINT: Mattel, Inc.",
    );
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
    const result = await quickScoreCandidate(CONFIG, acme, request());
    expect(result?.location).toBe("San Francisco, CA");
    expect(result?.founded).toBe("1998");
  });

  it("leaves location and founded null when the page has no structured data", async () => {
    stubNetwork({});
    const result = await quickScoreCandidate(CONFIG, acme, request());
    expect(result?.location).toBeNull();
    expect(result?.founded).toBeNull();
  });

  it("returns null when the candidate can't be fetched", async () => {
    stubNetwork({});
    vi.mocked(fetchWithVariants).mockRejectedValueOnce(new Error("unreachable"));
    const result = await quickScoreCandidate(
      CONFIG,
      candidate("https://unreachable.example.com"),
      request(),
    );
    expect(result).toBeNull();
  });

  it("does not drop other candidates when one fails", async () => {
    stubNetwork({
      scoreJson: {
        companyName: "Acme Corp",
        score: 60,
        description: "A candidate company.",
        fitReason: "Fine.",
      },
    });
    vi.mocked(fetchWithVariants).mockRejectedValueOnce(new Error("unreachable"));
    const results = await Promise.all([
      quickScoreCandidate(CONFIG, candidate("https://bad.example.com"), request()),
      quickScoreCandidate(CONFIG, candidate("https://good.example.com"), request()),
    ]);
    expect(results[0]).toBeNull();
    expect(results[1]?.score).toBe(60);
  });

  it("sends an arbitrary recognized language and the raw message to the LLM", async () => {
    stubNetwork({});
    await quickScoreCandidate(
      CONFIG,
      acme,
      request({
        requesterMessage: "quali aziende dovremmo contattare?",
        responseLanguage: "Italian",
      }),
    );
    const messages = messagesOfCall();
    expect(messages[1]?.content).toContain("DETECTED RESPONSE LANGUAGE: Italian");
    expect(messages[1]?.content).toContain("quali aziende dovremmo contattare?");
  });

  it("keeps an explicit response language even when the message is empty", async () => {
    stubNetwork({});
    await quickScoreCandidate(CONFIG, acme, request());
    expect(messagesOfCall()[1]?.content).toContain(
      "DETECTED RESPONSE LANGUAGE: English",
    );
  });

  it("scores purchase sources against what the user wants to buy", async () => {
    stubNetwork({});
    await quickScoreCandidate(
      CONFIG,
      acme,
      request({
        sellingContext: "羊毛毯",
        requesterMessage: "哪里可以买到羊毛毯？",
        responseLanguage: "Chinese",
        matchDirection: "buy",
        matchLocation: "多伦多",
      }),
    );
    const messages = messagesOfCall();
    expect(messages[1]?.content).toContain("MATCH DIRECTION: buy");
    expect(messages[1]?.content).toContain("WHAT WE WANT TO BUY: 羊毛毯");
    expect(messages[1]?.content).toContain("REQUESTED LOCATION: 多伦多");
    expect(messages[0]?.content).toContain(
      "sells, ships, delivers, or serves that location",
    );
  });

  it("applies a requested region when scoring sell candidates", async () => {
    stubNetwork({});
    await quickScoreCandidate(
      CONFIG,
      acme,
      request({
        sellingContext: "logiciel de paie",
        requesterMessage: "Où vendre un logiciel de paie au Québec ?",
        responseLanguage: "French",
        matchLocation: "Québec",
      }),
    );
    const messages = messagesOfCall();
    expect(messages[1]?.content).toContain("MATCH DIRECTION: sell");
    expect(messages[1]?.content).toContain("WHAT WE SELL: logiciel de paie");
    expect(messages[1]?.content).toContain("REQUESTED LOCATION: Québec");
    expect(messages[0]?.content).toContain("operates, purchases, or has a");
  });

  it("omits labels entirely when no labelsToTranslate is given", async () => {
    stubNetwork({});
    const result = await quickScoreCandidate(CONFIG, acme, request());
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
      acme,
      request({ responseLanguage: "French" }),
      MATCH_REPORT_LABELS,
    );
    expect(result?.labels).toMatchObject({
      foundedLabel: "Fondée",
      fitLabel: "Fit",
      locationLabel: "Location",
    });
  });
});

/**
 * Compose the three match stages exactly as the workflow subgraph does, so
 * these tests exercise the live path rather than a wrapper around it.
 * @param config LLM credentials
 * @param matchRequest the validated match request
 * @param emit progress callback
 * @param signal cancels discovery and scoring work
 * @returns the formatted match result
 */
async function runMatchStages(
  config: LlmConfig,
  matchRequest: MatchRequest,
  emit: EmitCallback,
  signal?: AbortSignal,
): Promise<ReturnType<typeof formatMatchSkillResult>> {
  const pool = await resolveMatchCandidatesStage(config, matchRequest, emit, signal);
  const batch = await scoreMatchCandidatesStage(
    config,
    matchRequest,
    pool,
    emit,
    signal,
  );
  return formatMatchSkillResult(matchRequest, batch);
}

describe("match stage composition", () => {
  it("scores and ranks a user-supplied candidate list", async () => {
    stubNetwork({
      scoreJson: {
        companyName: "Acme Corp",
        score: 75,
        description: "A payroll and HR software vendor.",
        fitReason: "Good fit.",
      },
    });
    const events: unknown[] = [];
    const { markdown, title, matches } = await runMatchStages(
      CONFIG,
      request({
        candidates: ["https://acme.example.com", "https://globex.example.com"],
      }),
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
    const { matches } = await runMatchStages(
      CONFIG,
      request({ candidates }),
      () => {},
    );
    expect(matches).toHaveLength(8);
  });

  it("emits localized progress and agent logs", async () => {
    stubNetwork({ scoreJson: DEFAULT_SCORE_JSON });
    const events: { type: string; detail?: string }[] = [];
    await runMatchStages(
      CONFIG,
      request({
        sellingContext: "営業分析プラットフォーム",
        candidates: ["https://acme.example.com"],
        requesterMessage: "どの会社を対象にすべきですか？",
        responseLanguage: "Japanese",
        runtimeLabels: {
          ...RUNTIME_LABEL_DEFAULTS,
          resolvingCandidatesSingular: "指定された候補を確認しています",
          scoringCandidateSingular: "候補を評価しています",
          agentRunningTemplate: "{agent}: 実行中",
          agentDoneTemplate: "{agent}: 完了",
        },
      }),
      (event) => events.push(event),
    );
    expect(events.map((event) => event.detail)).toEqual([
      "指定された候補を確認しています",
      "候補を評価しています",
      "https://acme.example.com/: 実行中",
      "https://acme.example.com/: 完了",
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
        companyName: "Acme Corp",
        score: 60,
        description: "A payroll and HR software vendor.",
        fitReason: "Decent fit.",
      },
    });
    const { markdown } = await runMatchStages(CONFIG, request(), () => {});
    expect(markdown).toContain("Acme Corp");
    expect(markdown).toContain("60");
  });

  it("renders a no-candidates report instead of throwing when nothing resolves", async () => {
    stubNetwork({ suggestJson: { candidates: [] } });
    const events: { type: string; phase?: string; detail?: string }[] = [];
    const { markdown } = await runMatchStages(CONFIG, request(), (event) =>
      events.push(event),
    );
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).not.toContain("undefined");
    expect(events.at(-1)).toEqual({
      type: "phase",
      phase: "done",
      detail: RUNTIME_LABEL_DEFAULTS.noCandidates,
    });
  });

  it("uses the first candidate's translated labels for the report and cards", async () => {
    stubNetwork({
      scoreJson: {
        ...DEFAULT_SCORE_JSON,
        labels: { foundedLabel: "Fondée", fitLabel: "Adéquation" },
      },
    });
    const { markdown, cardLabels } = await runMatchStages(
      CONFIG,
      request({
        candidates: ["https://acme.example.com", "https://globex.example.com"],
        requesterMessage: "quelles entreprises devrions-nous cibler ?",
        responseLanguage: "French",
        runtimeLabels: {
          ...RUNTIME_LABEL_DEFAULTS,
          foundedLabel: "Fondée",
          fitLabel: "Adéquation",
        },
      }),
      () => {},
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
    const { cardLabels } = await runMatchStages(
      CONFIG,
      request({
        candidates: ["https://bad.example.com", "https://good.example.com"],
        requesterMessage: "quelles entreprises devrions-nous cibler ?",
        responseLanguage: "French",
        runtimeLabels: {
          ...RUNTIME_LABEL_DEFAULTS,
          foundedLabel: "Fondée",
          fitLabel: "Adéquation",
        },
      }),
      () => {},
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
    const { markdown, cardLabels } = await runMatchStages(
      CONFIG,
      request({
        sellingContext: "منصة تحليلات للمبيعات",
        requesterMessage: "ما الشركات التي يجب أن نستهدفها؟",
        responseLanguage: "Arabic",
        runtimeLabels: {
          ...RUNTIME_LABEL_DEFAULTS,
          auditRequestTemplate: "حلل {url} كعميل محتمل",
        },
      }),
      () => {},
    );
    expect(markdown).toContain("تعذر تقييم أي شركة مرشحة.");
    expect(cardLabels.auditRequestTemplate).toBe("حلل {url} كعميل محتمل");
  });

  it("uses localized empty output when named buy candidates cannot be scored", () => {
    const result = formatMatchSkillResult(
      request({
        sellingContext: "羊毛毯",
        candidates: ["IKEA"],
        matchDirection: "buy",
        runtimeLabels: {
          ...RUNTIME_LABEL_DEFAULTS,
          reportTemplate: "{skill}报告",
          skillMatch: "购买地点",
          noBuyCandidates: "无法评估任何卖家或零售商。",
        },
      }),
      { scored: [], labels: MATCH_REPORT_LABELS },
    );
    expect(result.title).toBe("购买地点报告: 羊毛毯");
    expect(result.markdown).toContain("无法评估任何卖家或零售商。");
    expect(result.matches).toEqual([]);
  });

  it("uses the same ranked report and card structure for buy mode", async () => {
    const translated = {
      titleTemplate: "购买地点：{product}",
      titleWithLocationTemplate: "在 {location} 购买：{product}",
      fitLabel: "购买匹配度",
      auditHint: "点击查看完整卖家分析 →",
      auditRequestTemplate: "将 {url} 作为供应商进行分析",
    };
    stubNetwork({
      suggestJson: {
        candidates: [{ name: "IKEA", url: "https://ikea.example.com" }],
        labels: translated,
      },
      scoreJson: {
        companyName: "IKEA",
        score: 84,
        description: "IKEA 销售家居用品。",
        fitReason: "其目录中提供相关产品。",
        labels: translated,
      },
    });
    const result = await runMatchStages(
      CONFIG,
      request({
        sellingContext: "羊毛毯",
        requesterMessage: "哪里可以买到羊毛毯？",
        responseLanguage: "Chinese",
        matchDirection: "buy",
        matchLocation: "多伦多",
      }),
      () => {},
    );
    expect(result.title).toBe("在 多伦多 购买：羊毛毯");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.companyName).toBe("IKEA");
    expect(result.markdown).toContain("https://ikea.example.com");
    expect(result.cardLabels.fit).toBe("购买匹配度");
    expect(result.cardLabels.auditRequestTemplate).toContain("{url}");
  });
});
