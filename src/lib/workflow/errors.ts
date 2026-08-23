import { RouterOutputError } from "@/lib/agent/router";
import { LlmError } from "@/lib/llm";

const RETRYABLE_LLM_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Decide whether the graph may safely repeat a structured routing node.
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
