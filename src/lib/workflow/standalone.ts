import { END, START, StateGraph } from "@langchain/langgraph";
import { streamChatCompletion } from "@/lib/llm";
import {
  runStandaloneSkill,
  type StandaloneSkillName,
} from "@/lib/skills/standalone";
import {
  formatRuntimeLabel,
  localizedSkillName,
} from "@/lib/localization";
import type { WorkflowRuntimeContext } from "@/lib/workflow/context";
import { resolveRoutedTarget } from "@/lib/workflow/target";
import {
  PLAIN_CHAT_SYSTEM_PROMPT,
  WORKFLOW_NODE,
  WORKFLOW_PHASE,
  WORKFLOW_STATUS,
} from "@/lib/workflow/constants";
import { buildScoreLabels } from "@/lib/workflow/events";
import { buildReport } from "@/lib/workflow/report";
import {
  WorkflowStateAnnotation,
  type WorkflowState,
  type WorkflowStateUpdate,
} from "@/lib/workflow/state";

const STANDALONE_SKILL_NAMES: StandaloneSkillName[] = [
  "research",
  "qualify",
  "contacts",
  "outreach",
];

/**
 * Check whether a routed skill belongs to the standalone workflow.
 * @param skill internal router skill value
 * @returns true for research, qualification, contacts, or outreach
 */
function isStandaloneSkill(skill: string): skill is StandaloneSkillName {
  return STANDALONE_SKILL_NAMES.some((name) => name === skill);
}

/**
 * Stream an ordinary chat response while retaining the completed text in state.
 * @param state current request state
 * @param context non-persisted LLM, cancellation, and event context
 * @returns reply and terminal status update
 */
export async function runPlainChatNode(
  state: WorkflowState,
  context: WorkflowRuntimeContext,
): Promise<WorkflowStateUpdate> {
  let reply = "";
  for await (const delta of streamChatCompletion(
    context.config,
    [
      { role: "system", content: PLAIN_CHAT_SYSTEM_PROMPT },
      ...state.history,
      { role: "user", content: state.message },
    ],
    { signal: context.signal },
  )) {
    reply += delta;
    context.emit({ type: "token", text: delta });
  }
  return { reply, status: WORKFLOW_STATUS.completed };
}

/**
 * Run one routed standalone skill and emit its existing report contract.
 * @param state current request state
 * @param context non-persisted workflow context
 * @returns final report and terminal status update
 */
async function runStandaloneNode(
  state: WorkflowState,
  context: WorkflowRuntimeContext,
): Promise<WorkflowStateUpdate> {
  const routing = state.routing;
  if (!routing || !isStandaloneSkill(routing.skill)) {
    return { status: WORKFLOW_STATUS.completed };
  }
  context.signal.throwIfAborted();
  context.emit({
    type: "phase",
    phase: WORKFLOW_PHASE.routing,
    detail: formatRuntimeLabel(state.runtimeLabels.matchedSkillTemplate, {
      skill: localizedSkillName(state.runtimeLabels, routing.skill),
    }),
  });
  const url = await resolveRoutedTarget(routing, context);
  const { markdown, title } = await runStandaloneSkill(
    context.config,
    routing.skill,
    url,
    routing.entity ?? null,
    context.emit,
    routing.sellingContext,
    state.message,
    state.language,
    state.runtimeLabels,
    context.signal,
  );
  const report = buildReport({
    kind: routing.skill,
    companyName: title,
    url,
    scoreLabels: buildScoreLabels(state.runtimeLabels, routing.skill),
    markdown,
  });
  context.emit({ type: "report", report });
  return { report, status: WORKFLOW_STATUS.completed };
}

/**
 * Compile the standalone-skill subgraph for one request runtime.
 * @param context non-persisted request context captured by the node
 * @returns compiled stateless subgraph
 */
export function createStandaloneSubgraph(context: WorkflowRuntimeContext) {
  return new StateGraph(WorkflowStateAnnotation)
    .addNode(WORKFLOW_NODE.standaloneRun, (state) =>
      runStandaloneNode(state, context),
    )
    .addEdge(START, WORKFLOW_NODE.standaloneRun)
    .addEdge(WORKFLOW_NODE.standaloneRun, END)
    .compile({ name: WORKFLOW_NODE.standaloneSubgraph });
}
