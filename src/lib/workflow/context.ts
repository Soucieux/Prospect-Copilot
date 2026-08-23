import type { EmitCallback } from "@/lib/agent/schemas";
import type { LlmConfig } from "@/lib/llm";
import type { RuntimeLabels } from "@/lib/localization";

/** Runtime-only values that must never be serialized into graph state. */
export interface WorkflowRuntimeContext {
  config: LlmConfig;
  signal: AbortSignal;
  emit: EmitCallback;
  setRuntimeLabels?: (labels: RuntimeLabels) => void;
}
