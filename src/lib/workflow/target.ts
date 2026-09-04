/**
 * Resolving a routed request to a fetchable company URL.
 *
 * Both the prospect subgraph and the standalone subgraph need the same rule:
 * take the URL the router extracted, and only ask the model to resolve a name
 * when there is no URL. Keeping it here means the two branches cannot drift.
 */

import { resolveCompanyUrl } from "@/lib/agent/router";
import type { ResolvedRouterResult } from "@/lib/agent/router";
import type { WorkflowRuntimeContext } from "@/lib/workflow/context";

/**
 * Resolve the company URL a routed request points at.
 * @param routing validated routing for this request
 * @param context non-persisted LLM credentials and cancellation
 * @returns the URL to work from, or null when neither is available
 */
export async function resolveRoutedTarget(
  routing: ResolvedRouterResult,
  context: WorkflowRuntimeContext,
): Promise<string | null> {
  if (routing.url) return routing.url;
  if (!routing.entity) return null;
  return resolveCompanyUrl(context.config, routing.entity, context.signal);
}
