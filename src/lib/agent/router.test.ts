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
});
