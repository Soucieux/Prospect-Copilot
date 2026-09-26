import { RouterOutputError } from "@/lib/agent/router";
import { isRetryableStructuredLlmError } from "@/lib/llm";

/**
 * Decide whether the graph may safely repeat a structured routing node. The
 * router wraps unparseable output in its own error; every other failure is
 * classified exactly as the adapter classifies it for the other structured
 * calls, so the two policies cannot drift apart.
 * @param caught unknown node failure
 * @returns true for invalid structured output and temporary provider failures
 */
export function isRetryableRouterError(caught: unknown): boolean {
  return (
    caught instanceof RouterOutputError || isRetryableStructuredLlmError(caught)
  );
}
