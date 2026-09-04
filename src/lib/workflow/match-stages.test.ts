import { describe, expect, it } from "vitest";
import type { ChatEvent } from "@/lib/agent/schemas";
import type { ReportState } from "@/lib/chat-types";
import type { ResolvedRouterResult } from "@/lib/agent/router";
import { MATCH_REPORT_LABELS, type CandidatePool } from "@/lib/skills/match";
import { RUNTIME_LABEL_DEFAULTS } from "@/lib/localization";
import { WORKFLOW_NODE, WORKFLOW_STATUS } from "@/lib/workflow/constants";
import type { WorkflowRuntimeContext } from "@/lib/workflow/context";
import {
  clarifyMatchNode,
  formatMatchNode,
  selectMatchEntry,
  selectResolvedCandidates,
} from "@/lib/workflow/match";

/**
 * Build one routing result carrying only the fields under test.
 * @param overrides routing fields under test
 * @returns a complete resolved routing result
 */
function routing(
  overrides: Partial<ResolvedRouterResult> = {},
): ResolvedRouterResult {
  return {
    skill: "match",
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
 * Build a runtime context that records the events its node emits.
 * @returns the context and the array it appends emitted events to
 */
function recordingContext(): {
  context: WorkflowRuntimeContext;
  events: ChatEvent[];
} {
  const events: ChatEvent[] = [];
  return {
    events,
    context: {
      config: { apiKey: "k", baseUrl: "https://api.example.com", model: "m" },
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    },
  };
}

const POOL: CandidatePool = {
  candidates: [{ url: "https://northwind.example.com", nameHint: "Northwind" }],
  urls: ["https://northwind.example.com"],
  labels: MATCH_REPORT_LABELS,
};

/**
 * Build match state for a stage under test.
 * @param overrides state fields the stage reads
 * @returns state shaped as the subgraph passes it to a node
 */
function matchState(overrides: Record<string, unknown> = {}) {
  return {
    message: "we sell payroll software",
    language: "English",
    runtimeLabels: RUNTIME_LABEL_DEFAULTS,
    routing: routing(),
    candidatePool: null,
    scoreBatch: null,
    ...overrides,
  } as Parameters<typeof formatMatchNode>[0];
}

/**
 * Read the report a stage update carries. The update type widens `report`
 * into LangGraph's overwrite wrapper, so the concrete report the format stage
 * sets is narrowed here once instead of at every assertion.
 * @param update the update returned by the format stage
 * @returns the report the update sets
 */
function reportOf(
  update: ReturnType<typeof formatMatchNode>,
): ReportState {
  return update.report as ReportState;
}

describe("selectMatchEntry", () => {
  it("asks for clarification when neither a product nor candidates were named", () => {
    expect(selectMatchEntry(matchState())).toBe(WORKFLOW_NODE.matchClarify);
  });

  it("resolves candidates once a product is known", () => {
    expect(
      selectMatchEntry(
        matchState({ routing: routing({ sellingContext: "payroll software" }) }),
      ),
    ).toBe(WORKFLOW_NODE.matchResolve);
  });

  it("resolves candidates when the request named companies itself", () => {
    expect(
      selectMatchEntry(
        matchState({ routing: routing({ candidates: ["Acme Corp"] }) }),
      ),
    ).toBe(WORKFLOW_NODE.matchResolve);
  });

  it("asks for clarification when the named-candidate list is empty", () => {
    expect(
      selectMatchEntry(matchState({ routing: routing({ candidates: [] }) })),
    ).toBe(WORKFLOW_NODE.matchClarify);
  });

  it("asks for clarification when routing is missing entirely", () => {
    expect(selectMatchEntry(matchState({ routing: undefined }))).toBe(
      WORKFLOW_NODE.matchClarify,
    );
  });
});

describe("clarifyMatchNode", () => {
  it("asks a seller what they sell", () => {
    const { context, events } = recordingContext();
    const update = clarifyMatchNode(
      matchState({ routing: routing({ matchDirection: "sell" }) }),
      context,
    );

    expect(update.reply).toBe(RUNTIME_LABEL_DEFAULTS.matchNudge);
    expect(update.status).toBe(WORKFLOW_STATUS.completed);
    expect(events).toEqual([
      { type: "token", text: RUNTIME_LABEL_DEFAULTS.matchNudge },
    ]);
  });

  it("asks a buyer what they want to buy", () => {
    const { context, events } = recordingContext();
    const update = clarifyMatchNode(
      matchState({ routing: routing({ matchDirection: "buy" }) }),
      context,
    );

    expect(update.reply).toBe(RUNTIME_LABEL_DEFAULTS.matchBuyNudge);
    expect(events).toEqual([
      { type: "token", text: RUNTIME_LABEL_DEFAULTS.matchBuyNudge },
    ]);
  });

  it("treats missing routing as the selling direction", () => {
    const { context } = recordingContext();
    expect(
      clarifyMatchNode(matchState({ routing: undefined }), context).reply,
    ).toBe(RUNTIME_LABEL_DEFAULTS.matchNudge);
  });
});

describe("selectResolvedCandidates", () => {
  it("scores the pool when discovery found candidates", () => {
    expect(selectResolvedCandidates(matchState({ candidatePool: POOL }))).toBe(
      WORKFLOW_NODE.matchScore,
    );
  });

  it("skips scoring when discovery found nothing", () => {
    expect(
      selectResolvedCandidates(
        matchState({ candidatePool: { ...POOL, candidates: [], urls: [] } }),
      ),
    ).toBe(WORKFLOW_NODE.matchFormat);
  });

  it("skips scoring when no pool was produced at all", () => {
    expect(selectResolvedCandidates(matchState())).toBe(
      WORKFLOW_NODE.matchFormat,
    );
  });
});

describe("formatMatchNode", () => {
  it("emits a match report and completes the subgraph", () => {
    const { context, events } = recordingContext();
    const update = formatMatchNode(
      matchState({
        candidatePool: POOL,
        scoreBatch: {
          labels: MATCH_REPORT_LABELS,
          scored: [
            {
              url: "https://northwind.example.com",
              companyName: "Northwind Trading",
              score: 88,
              description: "Mid-market distributor.",
              fitReason: "Headcount fits.",
              location: "Leeds, UK",
              founded: "1998",
            },
          ],
        },
      }),
      context,
    );

    expect(update.status).toBe(WORKFLOW_STATUS.completed);
    expect(reportOf(update).kind).toBe("match");
    expect(reportOf(update).matches?.[0]?.companyName).toBe("Northwind Trading");
    expect(events.filter((event) => event.type === "report")).toHaveLength(1);
  });

  it("still produces a report when scoring never ran", () => {
    const { context } = recordingContext();
    const update = formatMatchNode(
      matchState({ candidatePool: { ...POOL, candidates: [], urls: [] } }),
      context,
    );

    expect(update.status).toBe(WORKFLOW_STATUS.completed);
    expect(reportOf(update).kind).toBe("match");
    expect(reportOf(update).matches).toEqual([]);
  });

  it("fails loudly when the pool the stage depends on is missing", () => {
    const { context } = recordingContext();
    expect(() => formatMatchNode(matchState(), context)).toThrow(
      /candidate pool/,
    );
  });
});
