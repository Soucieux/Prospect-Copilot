import { RouterOutputError } from "@/lib/agent/router";
import { LlmError } from "@/lib/llm";
import { RETRYABLE_LLM_STATUSES } from "@/lib/retry";

/**
 * Decide whether the graph may safely repeat a structured routing node.
 * The TypeError branch covers Node's `fetch`, which reports transport failures
 * as a bare TypeError rather than a status; it is not a check for a bug.
 * @param caught unknown node failure
 * @returns true for invalid structured output and temporary provider failures
 */
export function isRetryableRouterError(caught: unknown): boolean {
  if (caught instanceof RouterOutputError) return true;
  if (caught instanceof LlmError) {
    return RETRYABLE_LLM_STATUSES.has(caught.status);
  }
  return caught instanceof TypeError;
}
