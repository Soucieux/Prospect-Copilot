import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isLikelyCompanyUrl,
  resolveCompanyUrl,
  routeMessageForWorkflow,
} from "./router";
import { LlmError } from "@/lib/llm";
import type { LlmConfig } from "@/lib/llm";

const CONFIG: LlmConfig = {
  baseUrl: "https://api.example.com",
  apiKey: "test-key",
  model: "test-model",
};

/** Stub the chat-completions endpoint to return one router JSON verdict. */
function stubRouterResponse(json: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(json) } }],
          }),
        ),
    ),
  );
}

/** Stub the chat-completions endpoint with a different reply per call, in order. */
function stubSequentialResponses(contents: string[]): void {
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const content = contents[call] ?? contents[contents.length - 1];
      call += 1;
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
      );
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("preserves caller cancellation instead of converting it to router output failure", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("Request cancelled", "AbortError"));

  await expect(
    routeMessageForWorkflow(CONFIG, "analyze Acme", [], controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});

describe("routeMessageForWorkflow", () => {
  it("extracts sellingContext when stated in the current message", async () => {
    stubRouterResponse({
      skill: "prospect",
      url: "https://acme.example.com",
      entity: null,
      sellingContext: "B2B payroll software for mid-market companies",
      candidates: null,
    });
    const result = await routeMessageForWorkflow(
      CONFIG,
      "we sell payroll software, analyze https://acme.example.com as a prospect",
      [],
    );
    expect(result.sellingContext).toBe(
      "B2B payroll software for mid-market companies",
    );
  });

  it("extracts sellingContext from earlier conversation history", async () => {
    stubRouterResponse({
      skill: "prospect",
      url: "https://acme.example.com",
      entity: null,
      sellingContext: "B2B payroll software for mid-market companies",
      candidates: null,
    });
    const history = [
      { role: "user" as const, content: "we sell payroll software" },
      { role: "assistant" as const, content: "Got it!" },
    ];
    const result = await routeMessageForWorkflow(
      CONFIG,
      "analyze https://acme.example.com as a prospect",
      history,
    );
    expect(result.sellingContext).toBe(
      "B2B payroll software for mid-market companies",
    );
  });

  it("returns null sellingContext when it was never mentioned", async () => {
    stubRouterResponse({
      skill: "prospect",
      url: "https://acme.example.com",
      entity: null,
      sellingContext: null,
      candidates: null,
    });
    const result = await routeMessageForWorkflow(
      CONFIG,
      "analyze https://acme.example.com as a prospect",
      [],
    );
    expect(result.sellingContext).toBeNull();
  });

  it("still extracts skill/url/entity correctly alongside sellingContext", async () => {
    stubRouterResponse({
      skill: "outreach",
      url: null,
      entity: "Acme Analytics",
      sellingContext: null,
      candidates: null,
    });
    const result = await routeMessageForWorkflow(
      CONFIG,
      "draft an outreach sequence for Acme Analytics",
      [],
    );
    expect(result.skill).toBe("outreach");
    expect(result.entity).toBe("Acme Analytics");
  });

  it("forwards history to the LLM call before the final user message", async () => {
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    skill: "none",
                    url: null,
                    entity: null,
                    sellingContext: null,
                    candidates: null,
                  }),
                },
              },
            ],
          }),
        ),
    );
    vi.stubGlobal("fetch", spy);
    const history = [{ role: "user" as const, content: "we sell payroll software" }];
    await routeMessageForWorkflow(CONFIG, "hello", history);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(
      body.messages.some((m) => m.content === "we sell payroll software"),
    ).toBe(true);
  });

  it("routes to 'match' with no candidates for discovery mode", async () => {
    stubRouterResponse({
      skill: "match",
      url: null,
      entity: null,
      sellingContext: "payroll software for mid-market companies",
      candidates: null,
    });
    const result = await routeMessageForWorkflow(
      CONFIG,
      "we sell payroll software for mid-market companies, who should we target?",
      [],
    );
    expect(result.skill).toBe("match");
    expect(result.candidates).toBeNull();
  });

  it("treats natural selling intent as discovery without a fixed format", async () => {
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    skill: "match",
                    url: null,
                    entity: null,
                    sellingContext: "羊毛毯",
                    candidates: null,
                    language: "Chinese",
                    runtimeLabels: {},
                  }),
                },
              },
            ],
          }),
        ),
    );
    vi.stubGlobal("fetch", spy);

    const result = await routeMessageForWorkflow(CONFIG, "我想去卖羊毛毯，如何选择", []);

    expect(result.skill).toBe("match");
    expect(result.sellingContext).toBe("羊毛毯");
    expect(result.candidates).toBeNull();
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages[0]?.content).toContain(
      "never require a fixed\n  sentence template",
    );
    expect(body.messages[0]?.content).toContain(
      "A product, service, category, market",
    );
  });

  it("continues discovery from a product-only reply to the prior nudge", async () => {
    stubRouterResponse({
      skill: "match",
      url: null,
      entity: null,
      sellingContext: "羊毛毯",
      candidates: null,
      language: "Chinese",
      runtimeLabels: {},
    });
    const result = await routeMessageForWorkflow(CONFIG, "羊毛毯", [
      { role: "user", content: "我想去卖羊毛毯，如何选择" },
      { role: "assistant", content: "请告诉我你销售什么。" },
    ]);
    expect(result.skill).toBe("match");
    expect(result.sellingContext).toBe("羊毛毯");
    expect(result.candidates).toBeNull();
  });

  it("routes a natural where-to-buy request through the same match skill", async () => {
    stubRouterResponse({
      skill: "match",
      url: null,
      entity: null,
      sellingContext: "羊毛毯",
      matchDirection: "buy",
      candidates: null,
      language: "Chinese",
      runtimeLabels: {},
    });
    const result = await routeMessageForWorkflow(CONFIG, "哪里可以买到羊毛毯？", []);
    expect(result.skill).toBe("match");
    expect(result.matchDirection).toBe("buy");
    expect(result.sellingContext).toBe("羊毛毯");
    expect(result.matchLocation).toBeNull();
  });

  it("extracts a city for a multilingual buy request", async () => {
    stubRouterResponse({
      skill: "match",
      url: null,
      entity: null,
      sellingContext: "羊毛毯",
      matchDirection: "buy",
      matchLocation: "多伦多",
      candidates: null,
      language: "Chinese",
      runtimeLabels: {},
    });
    const result = await routeMessageForWorkflow(CONFIG, "多伦多哪里可以买到羊毛毯？", []);
    expect(result.matchLocation).toBe("多伦多");
    expect(result.matchDirection).toBe("buy");
  });

  it("extracts a region for a multilingual sell request", async () => {
    stubRouterResponse({
      skill: "match",
      url: null,
      entity: null,
      sellingContext: "logiciel de paie",
      matchDirection: "sell",
      matchLocation: "Québec",
      candidates: null,
      language: "French",
      runtimeLabels: {},
    });
    const result = await routeMessageForWorkflow(
      CONFIG,
      "Où vendre un logiciel de paie au Québec ?",
      [],
    );
    expect(result.matchLocation).toBe("Québec");
    expect(result.matchDirection).toBe("sell");
  });

  it("extracts a country without translating its user-authored name", async () => {
    stubRouterResponse({
      skill: "match",
      url: null,
      entity: null,
      sellingContext: "بطانيات صوفية",
      matchDirection: "buy",
      matchLocation: "فرنسا",
      candidates: null,
      language: "Arabic",
      runtimeLabels: {},
    });
    const result = await routeMessageForWorkflow(
      CONFIG,
      "أين يمكنني شراء بطانيات صوفية في فرنسا؟",
      [],
    );
    expect(result.matchLocation).toBe("فرنسا");
  });

  it("uses the latest location while retaining product and direction", async () => {
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    skill: "match",
                    url: null,
                    entity: null,
                    sellingContext: "wool blankets",
                    matchDirection: "buy",
                    matchLocation: "Montreal",
                    candidates: null,
                    language: "English",
                    runtimeLabels: {},
                  }),
                },
              },
            ],
          }),
        ),
    );
    vi.stubGlobal("fetch", spy);
    const result = await routeMessageForWorkflow(CONFIG, "What about Montreal?", [
      { role: "user", content: "Where can I buy wool blankets in Toronto?" },
      { role: "assistant", content: "Here are places in Toronto." },
    ]);
    expect(result.sellingContext).toBe("wool blankets");
    expect(result.matchDirection).toBe("buy");
    expect(result.matchLocation).toBe("Montreal");
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[0]?.content).toContain(
      "latest explicit location\n  overrides earlier locations",
    );
    expect(body.messages[0]?.content).toContain(
      'follow-up\n  "What about Montreal?" remains match',
    );
  });

  it("recovers a referenced product for a multilingual buy follow-up", async () => {
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    skill: "match",
                    url: null,
                    entity: null,
                    sellingContext: "couvertures en laine",
                    matchDirection: "buy",
                    candidates: null,
                    language: "French",
                    runtimeLabels: {},
                  }),
                },
              },
            ],
          }),
        ),
    );
    vi.stubGlobal("fetch", spy);
    const result = await routeMessageForWorkflow(CONFIG, "Où puis-je les acheter ?", [
      { role: "user", content: "Je cherche des couvertures en laine." },
      { role: "assistant", content: "Quel type de couverture préférez-vous ?" },
    ]);
    expect(result.skill).toBe("match");
    expect(result.matchDirection).toBe("buy");
    expect(result.sellingContext).toBe("couvertures en laine");
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages[0]?.content).toContain('"Where can I buy them?"');
    expect(
      body.messages.some((item) =>
        item.content.includes("couvertures en laine"),
      ),
    ).toBe(true);
  });

  it("returns an arbitrary detected language with merged runtime labels", async () => {
    stubRouterResponse({
      skill: "match",
      url: null,
      entity: null,
      sellingContext: "منصة تحليلات للمبيعات",
      candidates: null,
      language: "Arabic",
      runtimeLabels: {
        matchedMatch: "تم تحديد مهمة المطابقة",
        matchComplete: "اكتملت المطابقة",
      },
    });
    const result = await routeMessageForWorkflow(
      CONFIG,
      "ما الشركات التي يجب أن نستهدفها؟",
      [],
    );
    expect(result.language).toBe("Arabic");
    expect(result.runtimeLabels.matchedMatch).toBe("تم تحديد مهمة المطابقة");
    expect(result.runtimeLabels.matchComplete).toBe("اكتملت المطابقة");
    expect(result.runtimeLabels.fetchingTemplate).toContain("{target}");
  });

  it("routes to 'match' with a candidates list when companies are named", async () => {
    stubRouterResponse({
      skill: "match",
      url: null,
      entity: null,
      sellingContext: "payroll software",
      candidates: ["Acme Corp", "https://globex.example.com"],
    });
    const result = await routeMessageForWorkflow(
      CONFIG,
      "we sell payroll software, rank Acme Corp and https://globex.example.com for fit",
      [],
    );
    expect(result.skill).toBe("match");
    expect(result.candidates).toEqual([
      "Acme Corp",
      "https://globex.example.com",
    ]);
  });
});

describe("resolveCompanyUrl", () => {
  it("resolves an entity to a URL via an LLM guess", async () => {
    stubSequentialResponses(["https://acme.example.com"]);
    expect(await resolveCompanyUrl(CONFIG, "Acme Analytics")).toBe(
      "https://acme.example.com/",
    );
  });

  it("returns null when the LLM can't guess it", async () => {
    stubSequentialResponses(["unknown"]);
    expect(await resolveCompanyUrl(CONFIG, "Some Obscure Startup")).toBeNull();
  });
});

describe("isLikelyCompanyUrl", () => {
  it("accepts a normal company domain", () => {
    expect(isLikelyCompanyUrl("https://acme.example.com/about")).toBe(true);
  });

  it("rejects a single-label host that cannot be a public site", () => {
    expect(isLikelyCompanyUrl("https://intranet/")).toBe(false);
  });

  it.each([
    "https://www.linkedin.com/company/acme",
    "https://en.wikipedia.org/wiki/Acme",
    "https://www.facebook.com/acme",
  ])("rejects the non-company host %s", (url) => {
    expect(isLikelyCompanyUrl(url)).toBe(false);
  });

  it("rejects a string that is not a URL at all", () => {
    expect(isLikelyCompanyUrl("not a url")).toBe(false);
  });
});

describe("routeMessageForWorkflow failures", () => {
  it("lets a provider failure through instead of reporting bad output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream down", { status: 503 })),
    );
    await expect(
      routeMessageForWorkflow(CONFIG, "analyze Acme", []),
    ).rejects.toBeInstanceOf(LlmError);
  });
});

describe("resolveCompanyUrl", () => {
  /** Stub the completions endpoint with one plain-text reply. */
  function stubText(text: string): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: text } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
  }

  it("returns a company URL the model resolved", async () => {
    stubText("https://acme.example.com");
    await expect(resolveCompanyUrl(CONFIG, "Acme Corp")).resolves.toBe(
      "https://acme.example.com/",
    );
  });

  it("strips quoting the model wrapped the URL in", async () => {
    stubText('"https://acme.example.com"');
    await expect(resolveCompanyUrl(CONFIG, "Acme Corp")).resolves.toBe(
      "https://acme.example.com/",
    );
  });

  it("returns nothing when the model admits it does not know", async () => {
    stubText("unknown");
    await expect(resolveCompanyUrl(CONFIG, "Nowhere Ltd")).resolves.toBeNull();
  });

  it("returns nothing for an empty answer", async () => {
    stubText("   ");
    await expect(resolveCompanyUrl(CONFIG, "Nowhere Ltd")).resolves.toBeNull();
  });

  it("refuses a social profile offered in place of a company site", async () => {
    stubText("https://www.linkedin.com/company/acme");
    await expect(resolveCompanyUrl(CONFIG, "Acme Corp")).resolves.toBeNull();
  });

  it("returns nothing when the provider fails outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(resolveCompanyUrl(CONFIG, "Acme Corp")).resolves.toBeNull();
  });
});
