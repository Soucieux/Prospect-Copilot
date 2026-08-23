import { END, START, StateGraph, type NodeError } from "@langchain/langgraph";
import {
  RouterOutputError,
  routeMessageForWorkflow,
  type ResolvedRouterResult,
} from "@/lib/agent/router";
import { RUNTIME_LABEL_DEFAULTS } from "@/lib/localization";
import type { WorkflowRuntimeContext } from "@/lib/workflow/context";
import {
  DEFAULT_RESPONSE_LANGUAGE,
  ROUTER_RETRY_POLICY,
  WORKFLOW_NODE,
} from "@/lib/workflow/constants";
import { isRetryableRouterError } from "@/lib/workflow/errors";
import { createMatchSubgraph } from "@/lib/workflow/match";
import { createProspectSubgraph } from "@/lib/workflow/prospect";
import {
  createStandaloneSubgraph,
  runPlainChatNode,
} from "@/lib/workflow/standalone";
import {
  WorkflowStateAnnotation,
  type WorkflowHistoryItem,
  type WorkflowState,
  type WorkflowStateUpdate,
} from "@/lib/workflow/state";

/** Input accepted by the per-request workflow entry point. */
export interface WorkflowInput {
  requestId: string;
  message: string;
  history: WorkflowHistoryItem[];
}

/** Routing fallback used only after invalid structured output exhausts retry. */
const FALLBACK_ROUTING: ResolvedRouterResult = {
  skill: "none",
  url: null,
  entity: null,
  sellingContext: null,
  matchDirection: "sell",
  matchLocation: null,
  candidates: null,
  language: DEFAULT_RESPONSE_LANGUAGE,
  runtimeLabels: RUNTIME_LABEL_DEFAULTS,
};

/**
 * Invoke and validate the semantic request router.
 * @param state current request state
 * @param context non-persisted request context
 * @returns routing, language, and localized runtime labels
 */
async function understandRequest(
  state: WorkflowState,
  context: WorkflowRuntimeContext,
): Promise<WorkflowStateUpdate> {
  const routing = await routeMessageForWorkflow(
    context.config,
    state.message,
    state.history,
    context.signal,
  );
  context.setRuntimeLabels?.(routing.runtimeLabels);
  return {
    routing,
    language: routing.language,
    runtimeLabels: routing.runtimeLabels,
  };
}

/**
 * Recover invalid router JSON after its graph retry is exhausted.
 * @param _state state supplied to the failed routing node
 * @param nodeError wrapper containing the original router failure
 * @returns safe plain-chat routing update
 */
function recoverRouterOutput(
  _state: WorkflowState,
  nodeError: NodeError,
): WorkflowStateUpdate {
  if (!(nodeError.error instanceof RouterOutputError)) throw nodeError.error;
  return {
    routing: FALLBACK_ROUTING,
    language: FALLBACK_ROUTING.language,
    runtimeLabels: FALLBACK_ROUTING.runtimeLabels,
    failures: [
      {
        stage: WORKFLOW_NODE.understandRequest,
        category: "invalid_structured_output",
        retryable: true,
      },
    ],
  };
}

/**
 * Select one deterministic workflow branch from validated router state.
 * @param state current graph state
 * @returns the next node identifier
 */
function selectWorkflow(state: WorkflowState): string {
  const skill = state.routing?.skill;
  if (skill === "match") return WORKFLOW_NODE.matchSubgraph;
  if (skill === "prospect" && (state.routing?.url || state.routing?.entity)) {
    return WORKFLOW_NODE.prospectSubgraph;
  }
  if (
    skill === "research" ||
    skill === "qualify" ||
    skill === "contacts" ||
    skill === "outreach"
  ) {
    return WORKFLOW_NODE.standaloneSubgraph;
  }
  return WORKFLOW_NODE.plainChat;
}

/**
 * Compile the complete stateless request graph for one runtime context.
 * @param context non-persisted LLM, event, and cancellation values
 * @returns compiled top-level graph
 */
export function createWorkflowGraph(context: WorkflowRuntimeContext) {
  const prospectSubgraph = createProspectSubgraph(context);
  const matchSubgraph = createMatchSubgraph(context);
  const standaloneSubgraph = createStandaloneSubgraph(context);
  return new StateGraph(WorkflowStateAnnotation)
    .addNode(
      WORKFLOW_NODE.understandRequest,
      (state) => understandRequest(state, context),
      {
        retryPolicy: {
          ...ROUTER_RETRY_POLICY,
          retryOn: isRetryableRouterError,
        },
        errorHandler: recoverRouterOutput,
      },
    )
    .addNode(WORKFLOW_NODE.plainChat, (state) =>
      runPlainChatNode(state, context),
    )
    .addNode(WORKFLOW_NODE.prospectSubgraph, prospectSubgraph)
    .addNode(WORKFLOW_NODE.matchSubgraph, matchSubgraph)
    .addNode(WORKFLOW_NODE.standaloneSubgraph, standaloneSubgraph)
    .addEdge(START, WORKFLOW_NODE.understandRequest)
    .addConditionalEdges(WORKFLOW_NODE.understandRequest, selectWorkflow, {
      [WORKFLOW_NODE.plainChat]: WORKFLOW_NODE.plainChat,
      [WORKFLOW_NODE.prospectSubgraph]: WORKFLOW_NODE.prospectSubgraph,
      [WORKFLOW_NODE.matchSubgraph]: WORKFLOW_NODE.matchSubgraph,
      [WORKFLOW_NODE.standaloneSubgraph]: WORKFLOW_NODE.standaloneSubgraph,
    })
    .addEdge(WORKFLOW_NODE.plainChat, END)
    .addEdge(WORKFLOW_NODE.prospectSubgraph, END)
    .addEdge(WORKFLOW_NODE.matchSubgraph, END)
    .addEdge(WORKFLOW_NODE.standaloneSubgraph, END)
    .compile({ name: "prospect_copilot" });
}

/**
 * Execute one request while consuming graph updates until completion.
 * @param input serializable user request state
 * @param context non-persisted request runtime
 * @returns a promise that resolves when the graph reaches END
 */
export async function runWorkflow(
  input: WorkflowInput,
  context: WorkflowRuntimeContext,
): Promise<void> {
  const graph = createWorkflowGraph(context);
  const updates = await graph.stream(input, {
    streamMode: "updates",
    signal: context.signal,
  });
  for await (const _update of updates) {
    context.signal.throwIfAborted();
  }
}
