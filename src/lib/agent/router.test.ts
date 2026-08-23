import { afterEach, describe, expect, it, vi } from "vitest";
import { routeMessage } from "./router";
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

describe("routeMessage", () => {
  it("extracts sellingContext when stated in the current message", async () => {
    stubRouterResponse({
      skill: "prospect",
      url: "https://acme.example.com",
      entity: null,
      sellingContext: "B2B payroll software for mid-market companies",
      candidates: null,
    });
    const result = await routeMessage(
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
    const result = await routeMessage(
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
    const result = await routeMessage(
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
    const result = await routeMessage(
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
    await routeMessage(CONFIG, "hello", history);
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
    const result = await routeMessage(
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

    const result = await routeMessage(CONFIG, "我想去卖羊毛毯，如何选择", []);

    expect(result.skill).toBe("match");
    expect(result.sellingContext).toBe("羊毛毯");
    expect(result.candidates).toBeNull();
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages[0].content).toContain(
      "never require a fixed\n  sentence template",
    );
    expect(body.messages[0].content).toContain(
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
    const result = await routeMessage(CONFIG, "羊毛毯", [
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
    const result = await routeMessage(CONFIG, "哪里可以买到羊毛毯？", []);
    expect(result.skill).toBe("match");
    expect(result.matchDirection).toBe("buy");
    expect(result.sellingContext).toBe("羊毛毯");
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
    const result = await routeMessage(CONFIG, "Où puis-je les acheter ?", [
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
    expect(body.messages[0].content).toContain('"Where can I buy them?"');
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
    const result = await routeMessage(
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
    const result = await routeMessage(
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

  it("resolves an entity to a URL via an LLM guess when none is given", async () => {
    stubSequentialResponses([
      JSON.stringify({
        skill: "prospect",
        url: null,
        entity: "Acme Analytics",
        sellingContext: null,
        candidates: null,
      }),
      "https://acme.example.com",
    ]);
    const result = await routeMessage(
      CONFIG,
      "analyze Acme Analytics as a prospect",
      [],
    );
    expect(result.url).toBe("https://acme.example.com/");
  });

  it("leaves url null when the LLM can't guess it", async () => {
    stubSequentialResponses([
      JSON.stringify({
        skill: "prospect",
        url: null,
        entity: "Some Obscure Startup",
        sellingContext: null,
        candidates: null,
      }),
      "unknown",
    ]);
    const result = await routeMessage(
      CONFIG,
      "analyze Some Obscure Startup as a prospect",
      [],
    );
    expect(result.url).toBeNull();
  });
});
