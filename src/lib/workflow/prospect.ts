import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { resolveCompanyUrl } from "@/lib/agent/router";
import {
  analyzeProspectBriefing,
  discoverProspect,
  formatProspectOutcome,
  scoreProspectBriefing,
  synthesizeProspectBriefing,
  type DiscoveryBriefing,
  type ProspectAnalysisResults,
  type ProspectScoreState,
} from "@/lib/agent/orchestrator";
import type { SynthesisResult } from "@/lib/agent/schemas";
import type { ReportState } from "@/lib/chat-types";
import type { WorkflowRuntimeContext } from "@/lib/workflow/context";
import {
  WORKFLOW_NODE,
  WORKFLOW_PHASE,
  WORKFLOW_STATUS,
} from "@/lib/workflow/constants";
import { buildScoreLabels } from "@/lib/workflow/events";
import { runPlainChatNode } from "@/lib/workflow/standalone";
import { WorkflowStateAnnotation } from "@/lib/workflow/state";

/** Stage-level state retained only while the prospect subgraph is active. */
const ProspectStateAnnotation = Annotation.Root({
  ...WorkflowStateAnnotation.spec,
  target: Annotation<string | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  briefing: Annotation<DiscoveryBriefing | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  analysisResults: Annotation<ProspectAnalysisResults | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  scoreState: Annotation<ProspectScoreState | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  synthesis: Annotation<SynthesisResult | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
});

type ProspectState = typeof ProspectStateAnnotation.State;
type ProspectStateUpdate = typeof ProspectStateAnnotation.Update;

/**
 * Resolve a routed URL or entity before discovery begins.
 * @param state current prospect subgraph state
 * @param context non-persisted request runtime
 * @returns resolved target update
 */
async function resolveProspectTarget(
  state: ProspectState,
  context: WorkflowRuntimeContext,
): Promise<ProspectStateUpdate> {
  const routing = state.routing;
  if (!routing || routing.skill !== "prospect") return { target: null };
  context.signal.throwIfAborted();
  const target =
    routing.url ??
    (routing.entity
      ? await resolveCompanyUrl(context.config, routing.entity, context.signal)
      : null);
  if (target) {
    context.emit({
      type: "phase",
      phase: WORKFLOW_PHASE.routing,
      detail: state.runtimeLabels.matchedProspect,
    });
  }
  return { target };
}

/**
 * Select discovery or the existing plain-chat fallback after resolution.
 * @param state current prospect subgraph state
 * @returns next node identifier
 */
function selectProspectTarget(state: ProspectState): string {
  return state.target
    ? WORKFLOW_NODE.prospectDiscover
    : WORKFLOW_NODE.prospectFallbackChat;
}

/**
 * Discover bounded public evidence for the resolved target.
 * @param state current prospect subgraph state
 * @param context non-persisted request runtime
 * @returns discovered briefing update
 */
async function discoverProspectNode(
  state: ProspectState,
  context: WorkflowRuntimeContext,
): Promise<ProspectStateUpdate> {
  context.signal.throwIfAborted();
  const briefing = await discoverProspect(
    state.target as string,
    context.emit,
    state.runtimeLabels,
    context.signal,
  );
  return { briefing };
}

/**
 * Run the five fixed analysis workers for the discovered briefing.
 * @param state current prospect subgraph state
 * @param context non-persisted request runtime
 * @returns settled analysis update
 */
async function analyzeProspectNode(
  state: ProspectState,
  context: WorkflowRuntimeContext,
): Promise<ProspectStateUpdate> {
  context.signal.throwIfAborted();
  const analysisResults = await analyzeProspectBriefing(
    context.config,
    state.briefing as DiscoveryBriefing,
    context.emit,
    state.routing?.sellingContext ?? null,
    state.message,
    state.language,
    state.runtimeLabels,
    context.signal,
  );
  return { analysisResults };
}

/**
 * Calculate deterministic prospect scores after worker fan-in.
 * @param state current prospect subgraph state
 * @returns deterministic score update
 */
function scoreProspectNode(state: ProspectState): ProspectStateUpdate {
  return {
    scoreState: scoreProspectBriefing(
      state.briefing as DiscoveryBriefing,
      state.analysisResults as ProspectAnalysisResults,
    ),
  };
}

/**
 * Produce the optional localized synthesis without discarding prior results.
 * @param state current prospect subgraph state
 * @param context non-persisted request runtime
 * @returns optional synthesis update
 */
async function synthesizeProspectNode(
  state: ProspectState,
  context: WorkflowRuntimeContext,
): Promise<ProspectStateUpdate> {
  const synthesis = await synthesizeProspectBriefing(
    context.config,
    state.briefing as DiscoveryBriefing,
    state.analysisResults as ProspectAnalysisResults,
    state.scoreState as ProspectScoreState,
    context.emit,
    state.routing?.sellingContext ?? null,
    state.message,
    state.language,
    state.runtimeLabels,
    context.signal,
  );
  return { synthesis };
}

/**
 * Build and emit the final report from completed prospect stage state.
 * @param state current prospect subgraph state
 * @param context non-persisted request runtime
 * @returns report and completed-status update
 */
function formatProspectNode(
  state: ProspectState,
  context: WorkflowRuntimeContext,
): ProspectStateUpdate {
  const outcome = formatProspectOutcome(
    state.briefing as DiscoveryBriefing,
    state.analysisResults as ProspectAnalysisResults,
    state.scoreState as ProspectScoreState,
    state.synthesis,
    state.routing?.sellingContext ?? null,
    state.runtimeLabels,
  );
  const report: ReportState = {
    kind: "prospect",
    companyName: outcome.companyName,
    url: outcome.url,
    score: outcome.composite.score,
    grade: outcome.composite.grade,
    confidence: outcome.composite.confidence,
    categories: outcome.composite.weighted.map((row, index) => ({
      category: outcome.categoryLabels[index] ?? row.category,
      score: row.score,
      weight: row.weight,
    })),
    matches: null,
    matchLabels: null,
    scoreLabels: buildScoreLabels(
      state.runtimeLabels,
      "prospect",
      outcome.confidenceLabel,
    ),
    markdown: outcome.markdown,
  };
  context.emit({ type: "report", report });
  return { report, status: WORKFLOW_STATUS.completed };
}

/**
 * Compile the stage-level prospect-audit subgraph for one request runtime.
 * @param context non-persisted request runtime captured by node closures
 * @returns compiled prospect subgraph
 */
export function createProspectSubgraph(context: WorkflowRuntimeContext) {
  return new StateGraph({
    stateSchema: ProspectStateAnnotation,
    output: WorkflowStateAnnotation,
  })
    .addNode(WORKFLOW_NODE.prospectResolveTarget, (state) =>
      resolveProspectTarget(state, context),
    )
    .addNode(WORKFLOW_NODE.prospectFallbackChat, (state) =>
      runPlainChatNode(state, context),
    )
    .addNode(WORKFLOW_NODE.prospectDiscover, (state) =>
      discoverProspectNode(state, context),
    )
    .addNode(WORKFLOW_NODE.prospectAnalyze, (state) =>
      analyzeProspectNode(state, context),
    )
    .addNode(WORKFLOW_NODE.prospectScore, scoreProspectNode)
    .addNode(WORKFLOW_NODE.prospectSynthesize, (state) =>
      synthesizeProspectNode(state, context),
    )
    .addNode(WORKFLOW_NODE.prospectFormat, (state) =>
      formatProspectNode(state, context),
    )
    .addEdge(START, WORKFLOW_NODE.prospectResolveTarget)
    .addConditionalEdges(
      WORKFLOW_NODE.prospectResolveTarget,
      selectProspectTarget,
      {
        [WORKFLOW_NODE.prospectDiscover]: WORKFLOW_NODE.prospectDiscover,
        [WORKFLOW_NODE.prospectFallbackChat]:
          WORKFLOW_NODE.prospectFallbackChat,
      },
    )
    .addEdge(WORKFLOW_NODE.prospectFallbackChat, END)
    .addEdge(WORKFLOW_NODE.prospectDiscover, WORKFLOW_NODE.prospectAnalyze)
    .addEdge(WORKFLOW_NODE.prospectAnalyze, WORKFLOW_NODE.prospectScore)
    .addEdge(WORKFLOW_NODE.prospectScore, WORKFLOW_NODE.prospectSynthesize)
    .addEdge(WORKFLOW_NODE.prospectSynthesize, WORKFLOW_NODE.prospectFormat)
    .addEdge(WORKFLOW_NODE.prospectFormat, END)
    .compile({ name: WORKFLOW_NODE.prospectSubgraph });
}
