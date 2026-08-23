import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "@/lib/agent/schemas";
import { createWorkflowGraph } from "@/lib/workflow/graph";
import { createMatchSubgraph } from "@/lib/workflow/match";
import { createProspectSubgraph } from "@/lib/workflow/prospect";
import { WORKFLOW_NODE } from "@/lib/workflow/constants";

const API_KEY = "workflow-secret-key";

/** Build one OpenAI-compatible non-streaming response. */
function completionResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Prospect Copilot workflow graph", () => {
  it("keeps prospect discovery, analysis, scoring, synthesis, and formatting as separate nodes", () => {
    const graph = createProspectSubgraph({
      config: {
        apiKey: API_KEY,
        baseUrl: "https://api.example.com",
        model: "test-model",
      },
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    const nodeNames = Object.keys(graph.getGraph().nodes);

    expect(nodeNames).toEqual(
      expect.arrayContaining([
        WORKFLOW_NODE.prospectDiscover,
        WORKFLOW_NODE.prospectAnalyze,
        WORKFLOW_NODE.prospectScore,
        WORKFLOW_NODE.prospectSynthesize,
        WORKFLOW_NODE.prospectFormat,
      ]),
    );
  });

  it("keeps match resolution, scoring, and formatting as separate nodes", () => {
    const graph = createMatchSubgraph({
      config: {
        apiKey: API_KEY,
        baseUrl: "https://api.example.com",
        model: "test-model",
      },
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    const nodeNames = Object.keys(graph.getGraph().nodes);

    expect(nodeNames).toEqual(
      expect.arrayContaining([
        WORKFLOW_NODE.matchResolve,
        WORKFLOW_NODE.matchScore,
        WORKFLOW_NODE.matchFormat,
      ]),
    );
  });

  it("routes a match clarification without serializing runtime secrets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        completionResponse(
          JSON.stringify({
            skill: "match",
            url: null,
            entity: null,
            sellingContext: null,
            matchDirection: "buy",
            matchLocation: null,
            candidates: null,
            language: "English",
            runtimeLabels: {},
          }),
        ),
      ),
    );
    const events: ChatEvent[] = [];
    const graph = createWorkflowGraph({
      config: {
        apiKey: API_KEY,
        baseUrl: "https://api.example.com",
        model: "test-model",
      },
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    const state = await graph.invoke({
      requestId: "request-1",
      message: "Where can I buy it?",
      history: [],
    });

    expect(state.routing?.skill).toBe("match");
    expect(events).toContainEqual({
      type: "token",
      text: state.runtimeLabels.matchBuyNudge,
    });
    expect(JSON.stringify(state)).not.toContain(API_KEY);
  });

  it("retries invalid router output once without adding another retry layer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(completionResponse("not-json"))
      .mockResolvedValueOnce(
        completionResponse(
          JSON.stringify({
            skill: "match",
            url: null,
            entity: null,
            sellingContext: null,
            matchDirection: "sell",
            matchLocation: null,
            candidates: null,
            language: "English",
            runtimeLabels: {},
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const graph = createWorkflowGraph({
      config: {
        apiKey: API_KEY,
        baseUrl: "https://api.example.com",
        model: "test-model",
      },
      signal: new AbortController().signal,
      emit: () => undefined,
    });

    const state = await graph.invoke({
      requestId: "request-2",
      message: "Who should I sell to?",
      history: [],
    });

    expect(state.routing?.skill).toBe("match");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
