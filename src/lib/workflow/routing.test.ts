import type { NodeError } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { RouterOutputError, type ResolvedRouterResult } from "@/lib/agent/router";
import { RUNTIME_LABEL_DEFAULTS } from "@/lib/localization";
import { WORKFLOW_NODE } from "@/lib/workflow/constants";
import { recoverRouterOutput, selectWorkflow } from "@/lib/workflow/graph";
import type {
  WorkflowState,
  WorkflowStateUpdate,
} from "@/lib/workflow/state";

/**
 * Read the routing value a node update carries. The update type widens
 * `routing` into LangGraph's overwrite wrapper, so the concrete result the
 * recovery node sets is narrowed here once instead of at every assertion.
 * @param update the update returned by the routing recovery node
 * @returns the routing result the update sets
 */
function routingOf(update: WorkflowStateUpdate): ResolvedRouterResult {
  return update.routing as ResolvedRouterResult;
}

/**
 * Build one routing result with only the fields a selection test cares about.
 * @param overrides routing fields under test
 * @returns a complete resolved routing result
 */
function routing(
  overrides: Partial<ResolvedRouterResult> = {},
): ResolvedRouterResult {
  return {
    skill: "none",
    url: null,
    entity: null,
    sellingContext: null,
    matchDirection: "sell",
    matchLocation: null,
    candidates: null,
    language: "English",
    runtimeLabels: RUNTIME_LABEL_DEFAULTS,
    ...overrides,
  };
}

/**
 * Build graph state carrying one routing result.
 * @param overrides routing fields under test
 * @returns state shaped as the conditional edge receives it
 */
function stateWith(
  overrides: Partial<ResolvedRouterResult> = {},
): WorkflowState {
  return { routing: routing(overrides) } as WorkflowState;
}

describe("selectWorkflow", () => {
  it("sends a match request to the match subgraph", () => {
    expect(selectWorkflow(stateWith({ skill: "match" }))).toBe(
      WORKFLOW_NODE.matchSubgraph,
    );
  });

  it("sends a match request to the match subgraph even with no product yet", () => {
    expect(
      selectWorkflow(stateWith({ skill: "match", sellingContext: null })),
    ).toBe(WORKFLOW_NODE.matchSubgraph);
  });

  it("sends a prospect request with a URL to the prospect subgraph", () => {
    expect(
      selectWorkflow(stateWith({ skill: "prospect", url: "https://acme.com" })),
    ).toBe(WORKFLOW_NODE.prospectSubgraph);
  });

  it("sends a prospect request named only by company to the prospect subgraph", () => {
    expect(
      selectWorkflow(stateWith({ skill: "prospect", entity: "Acme Corp" })),
    ).toBe(WORKFLOW_NODE.prospectSubgraph);
  });

  it("falls back to plain chat when a prospect request names no target", () => {
    expect(
      selectWorkflow(stateWith({ skill: "prospect", url: null, entity: null })),
    ).toBe(WORKFLOW_NODE.plainChat);
  });

  it.each(["research", "qualify", "contacts", "outreach"] as const)(
    "sends the %s skill to the standalone subgraph",
    (skill) => {
      expect(selectWorkflow(stateWith({ skill }))).toBe(
        WORKFLOW_NODE.standaloneSubgraph,
      );
    },
  );

  it("falls back to plain chat when no skill matched", () => {
    expect(selectWorkflow(stateWith({ skill: "none" }))).toBe(
      WORKFLOW_NODE.plainChat,
    );
  });

  it("falls back to plain chat when routing is missing entirely", () => {
    expect(selectWorkflow({} as WorkflowState)).toBe(WORKFLOW_NODE.plainChat);
  });
});

describe("recoverRouterOutput", () => {
  it("falls back to plain chat after invalid router output", () => {
    const update = recoverRouterOutput({} as WorkflowState, {
      error: new RouterOutputError(),
    } as NodeError);

    expect(routingOf(update).skill).toBe("none");
    expect(update.runtimeLabels).toEqual(RUNTIME_LABEL_DEFAULTS);
    expect(update.failures).toEqual([
      {
        stage: WORKFLOW_NODE.understandRequest,
        category: "invalid_structured_output",
        retryable: true,
      },
    ]);
  });

  it("keeps the fallback free of any resolved target or product", () => {
    const update = recoverRouterOutput({} as WorkflowState, {
      error: new RouterOutputError(),
    } as NodeError);

    expect(routingOf(update).url).toBeNull();
    expect(routingOf(update).entity).toBeNull();
    expect(routingOf(update).sellingContext).toBeNull();
    expect(routingOf(update).candidates).toBeNull();
  });

  it("rethrows a failure that is not invalid router output", () => {
    const original = new Error("provider unreachable");
    expect(() =>
      recoverRouterOutput({} as WorkflowState, { error: original } as NodeError),
    ).toThrow(original);
  });
});
