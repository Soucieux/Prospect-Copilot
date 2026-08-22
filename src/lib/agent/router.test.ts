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
