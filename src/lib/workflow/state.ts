import { Annotation } from "@langchain/langgraph";
import type { ResolvedRouterResult } from "@/lib/agent/router";
import type { ReportState } from "@/lib/chat-types";
import {
  RUNTIME_LABEL_DEFAULTS,
  type RuntimeLabels,
} from "@/lib/localization";
import {
  DEFAULT_RESPONSE_LANGUAGE,
  WORKFLOW_STATUS,
} from "@/lib/workflow/constants";

/** One bounded prior conversation turn supplied to the workflow. */
export interface WorkflowHistoryItem {
  role: "user" | "assistant";
  content: string;
}

/** Display-safe failure metadata retained in graph state. */
export interface WorkflowFailure {
  stage: string;
  category: string;
  retryable: boolean;
}

/** Shared serializable state for the top-level request graph and subgraphs. */
export const WorkflowStateAnnotation = Annotation.Root({
  requestId: Annotation<string>,
  message: Annotation<string>,
  history: Annotation<WorkflowHistoryItem[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
  routing: Annotation<ResolvedRouterResult | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  language: Annotation<string>({
    reducer: (_current, update) => update,
    default: () => DEFAULT_RESPONSE_LANGUAGE,
  }),
  runtimeLabels: Annotation<RuntimeLabels>({
    reducer: (_current, update) => update,
    default: () => RUNTIME_LABEL_DEFAULTS,
  }),
  report: Annotation<ReportState | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  reply: Annotation<string>({
    reducer: (current, update) => current + update,
    default: () => "",
  }),
  failures: Annotation<WorkflowFailure[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  status: Annotation<(typeof WORKFLOW_STATUS)[keyof typeof WORKFLOW_STATUS]>({
    reducer: (_current, update) => update,
    default: () => WORKFLOW_STATUS.running,
  }),
});

/** Fully materialized graph state. */
export type WorkflowState = typeof WorkflowStateAnnotation.State;

/** Partial state updates returned by graph nodes. */
export type WorkflowStateUpdate = typeof WorkflowStateAnnotation.Update;

/**
 * Read a stage value the graph's edges guarantee has already been produced.
 * The edges make this unreachable, so this is not defensive handling: it
 * replaces an unchecked cast with a failure that names the broken ordering
 * if an edge is ever rewired.
 * @param value the stage value to read
 * @param stage the node reading it, used in the failure message
 * @returns the value, proven present
 * @throws Error when a node ran before the stage that fills its input
 */
export function requireStageValue<Value>(
  value: Value | null | undefined,
  stage: string,
): Value {
  if (value === null || value === undefined) {
    throw new Error(`${stage} ran before its input was produced`);
  }
  return value;
}
