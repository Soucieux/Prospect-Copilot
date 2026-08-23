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
