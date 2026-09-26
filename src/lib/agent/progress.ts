/**
 * Per-worker progress events.
 *
 * Every parallel worker — the five prospect subagents and the match candidate
 * scorers alike — reports the same running/done/failed lifecycle with the same
 * three localized templates. Emitting it from one place keeps the identifier
 * and its formatted label from drifting apart at each call site.
 */

import type { AgentStatus, EmitCallback } from "@/lib/agent/schemas";
import { formatRuntimeLabel, type RuntimeLabels } from "@/lib/localization";

/**
 * Template to use for each stage of one worker's lifecycle. Keyed by the wire
 * schema's own status list, so adding a status there without a template here,
 * or the reverse, fails the type check.
 */
const STATUS_TEMPLATE: Record<AgentStatus, keyof RuntimeLabels> = {
  running: "agentRunningTemplate",
  done: "agentDoneTemplate",
  failed: "agentFailedTemplate",
};

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
  status: AgentStatus,
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
