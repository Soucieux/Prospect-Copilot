import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { CHAT_PHASE } from "@/lib/agent/schemas";
import {
  resolveMatchCandidatesStage,
  scoreMatchCandidatesStage,
  type CandidatePool,
  type CandidateScoreBatch,
  type MatchRequest,
} from "@/lib/skills/match";
import { formatMatchSkillResult } from "@/lib/skills/match-report";
import { buildScoreLabels } from "@/lib/localization";
import type { WorkflowRuntimeContext } from "@/lib/workflow/context";
import { WORKFLOW_NODE, WORKFLOW_STATUS } from "@/lib/workflow/constants";
import { buildReport } from "@/lib/workflow/report";
import {
  WorkflowStateAnnotation,
  requireStageValue,
  type WorkflowState,
} from "@/lib/workflow/state";

/** Stage-level state retained only while the match subgraph is active. */
const MatchStateAnnotation = Annotation.Root({
  ...WorkflowStateAnnotation.spec,
  candidatePool: Annotation<CandidatePool | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  scoreBatch: Annotation<CandidateScoreBatch | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
});

type MatchState = typeof MatchStateAnnotation.State;
type MatchStateUpdate = typeof MatchStateAnnotation.Update;

/**
 * Read the validated match request out of graph state once, so every stage
 * consumes the same values instead of each re-deriving defaults from routing.
 * @param state current request state
 * @returns the request every match stage consumes
 * @internal exported for deterministic stage tests
 */
export function matchRequestFrom(state: WorkflowState): MatchRequest {
  const routing = state.routing;
  return {
    sellingContext: routing?.sellingContext ?? null,
    candidates: routing?.candidates ?? null,
    requesterMessage: state.message,
    responseLanguage: state.language,
    runtimeLabels: state.runtimeLabels,
    matchDirection: routing?.matchDirection ?? "sell",
    matchLocation: routing?.matchLocation ?? null,
  };
}

/**
 * Select clarification or candidate discovery from validated routing state.
 * @param state current match subgraph state
 * @returns next node identifier
 * @internal exported for deterministic stage-selection tests
 */
export function selectMatchEntry(state: MatchState): string {
  const routing = state.routing;
  return !routing?.sellingContext && !routing?.candidates?.length
    ? WORKFLOW_NODE.matchClarify
    : WORKFLOW_NODE.matchResolve;
}

/**
 * Emit the localized product clarification without calling another model.
 * @param state current match subgraph state
 * @param context non-persisted request runtime
 * @returns localized reply and completed-status update
 * @internal exported for deterministic stage tests
 */
export function clarifyMatchNode(
  state: MatchState,
  context: WorkflowRuntimeContext,
): MatchStateUpdate {
  const reply =
    state.routing?.matchDirection === "buy"
      ? state.runtimeLabels.matchBuyNudge
      : state.runtimeLabels.matchNudge;
  context.emit({ type: "token", text: reply });
  return { reply, status: WORKFLOW_STATUS.completed };
}

/**
 * Resolve and deduplicate match candidates as an independent graph stage.
 * @param state current match subgraph state
 * @param context non-persisted request runtime
 * @returns candidate-pool update
 */
async function resolveMatchNode(
  state: MatchState,
  context: WorkflowRuntimeContext,
): Promise<MatchStateUpdate> {
  const request = matchRequestFrom(state);
  context.signal.throwIfAborted();
  context.emit({
    type: "phase",
    phase: CHAT_PHASE.routing,
    detail:
      request.matchDirection === "buy"
        ? state.runtimeLabels.matchedBuyMatch
        : state.runtimeLabels.matchedMatch,
  });
  const candidatePool = await resolveMatchCandidatesStage(
    context.config,
    request,
    context.emit,
    context.signal,
  );
  return { candidatePool };
}

/**
 * Select scoring only when candidate resolution produced work.
 * @param state current match subgraph state
 * @returns scoring or formatting node identifier
 * @internal exported for deterministic stage-selection tests
 */
export function selectResolvedCandidates(state: MatchState): string {
  return state.candidatePool?.candidates.length
    ? WORKFLOW_NODE.matchScore
    : WORKFLOW_NODE.matchFormat;
}

/**
 * Score resolved candidates as an independent bounded worker stage.
 * @param state current match subgraph state
 * @param context non-persisted request runtime
 * @returns candidate-score update
 */
async function scoreMatchNode(
  state: MatchState,
  context: WorkflowRuntimeContext,
): Promise<MatchStateUpdate> {
  const scoreBatch = await scoreMatchCandidatesStage(
    context.config,
    matchRequestFrom(state),
    requireStageValue(state.candidatePool, "candidate pool"),
    context.emit,
    context.signal,
  );
  return { scoreBatch };
}

/**
 * Build and emit the final match report from completed stage state. The
 * completion phase is emitted here, beside the report event, so the pure
 * formatter never needs the event channel.
 * @param state current match subgraph state
 * @param context non-persisted request runtime
 * @returns report and completed-status update
 * @internal exported for deterministic stage tests
 */
export function formatMatchNode(
  state: MatchState,
  context: WorkflowRuntimeContext,
): MatchStateUpdate {
  const candidatePool = requireStageValue(state.candidatePool, "candidate pool");
  const scoreBatch = state.scoreBatch ?? {
    scored: [],
    labels: candidatePool.labels,
  };
  // An empty pool already reported "no candidates" as its completion.
  if (candidatePool.candidates.length > 0) {
    context.emit({
      type: "phase",
      phase: CHAT_PHASE.done,
      detail: state.runtimeLabels.matchComplete,
    });
  }
  const { markdown, title, matches, cardLabels } = formatMatchSkillResult(
    matchRequestFrom(state),
    scoreBatch,
  );
  const report = buildReport({
    kind: "match",
    companyName: title,
    matches,
    matchLabels: cardLabels,
    scoreLabels: buildScoreLabels(state.runtimeLabels, "match"),
    markdown,
  });
  context.emit({ type: "report", report });
  return { report, status: WORKFLOW_STATUS.completed };
}

/**
 * Compile the stage-level buy/sell match subgraph for one request runtime.
 * @param context non-persisted request runtime captured by node closures
 * @returns compiled match subgraph
 */
export function createMatchSubgraph(context: WorkflowRuntimeContext) {
  return new StateGraph({
    stateSchema: MatchStateAnnotation,
    output: WorkflowStateAnnotation,
  })
    .addNode(WORKFLOW_NODE.matchClarify, (state) =>
      clarifyMatchNode(state, context),
    )
    .addNode(WORKFLOW_NODE.matchResolve, (state) =>
      resolveMatchNode(state, context),
    )
    .addNode(WORKFLOW_NODE.matchScore, (state) =>
      scoreMatchNode(state, context),
    )
    .addNode(WORKFLOW_NODE.matchFormat, (state) =>
      formatMatchNode(state, context),
    )
    .addConditionalEdges(START, selectMatchEntry, {
      [WORKFLOW_NODE.matchClarify]: WORKFLOW_NODE.matchClarify,
      [WORKFLOW_NODE.matchResolve]: WORKFLOW_NODE.matchResolve,
    })
    .addEdge(WORKFLOW_NODE.matchClarify, END)
    .addConditionalEdges(
      WORKFLOW_NODE.matchResolve,
      selectResolvedCandidates,
      {
        [WORKFLOW_NODE.matchScore]: WORKFLOW_NODE.matchScore,
        [WORKFLOW_NODE.matchFormat]: WORKFLOW_NODE.matchFormat,
      },
    )
    .addEdge(WORKFLOW_NODE.matchScore, WORKFLOW_NODE.matchFormat)
    .addEdge(WORKFLOW_NODE.matchFormat, END)
    .compile({ name: WORKFLOW_NODE.matchSubgraph });
}
