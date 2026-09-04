/**
 * Per-worker progress events.
 *
 * Every parallel worker — the five prospect subagents and the match candidate
 * scorers alike — reports the same running/done/failed lifecycle with the same
 * three localized templates. Emitting it from one place keeps the identifier
 * and its formatted label from drifting apart at each call site.
 */

import type { EmitCallback } from "@/lib/agent/schemas";
import { formatRuntimeLabel, type RuntimeLabels } from "@/lib/localization";

/** Template to use for each stage of one worker's lifecycle. */
const STATUS_TEMPLATE = {
  running: "agentRunningTemplate",
  done: "agentDoneTemplate",
  failed: "agentFailedTemplate",
} as const;

/**
 * Emit one worker's progress event with its localized detail line.
 * @param emit progress callback for this request
 * @param labels translated runtime labels
 * @param agent the worker's display name or URL
 * @param status which point in the worker's lifecycle this reports
 * @param score the worker's score, when it finished with one
 */
export function emitAgentProgress(
  emit: EmitCallback,
  labels: RuntimeLabels,
  agent: string,
  status: keyof typeof STATUS_TEMPLATE,
  score?: number,
): void {
  emit({
    type: "agent",
    agent,
    detail: formatRuntimeLabel(labels[STATUS_TEMPLATE[status]], { agent }),
    status,
    ...(score === undefined ? {} : { score }),
  });
}
