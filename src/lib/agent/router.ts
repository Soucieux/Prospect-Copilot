/**
 * Intent router: classifies a user message against the skill directory.
 * A cheap, temperature-0 LLM call; falls back to plain chat on "none".
 */

import { chatCompletion, extractJsonObject, type LlmConfig } from "@/lib/llm";
import { ROUTER_RESULT_SCHEMA, type RouterResult } from "@/lib/agent/schemas";
import { searchWeb, type SearchConfig } from "@/lib/search/volc-search";

const ROUTER_SYSTEM_PROMPT = `You classify user messages for a sales intelligence assistant.
Available skills:
- prospect: full prospect audit of a company URL (analyze, audit, evaluate, "run a prospect on", "sales analysis of").
- research: company research and firmographics for a URL.
- qualify: BANT/MEDDIC lead qualification for a URL.
- contacts: find decision makers / buying committee for a URL or company.
- outreach: draft outreach emails for a company or person.
Rules:
- Only pick a skill when the message clearly asks for that work.
- Extract the company URL when present (prefer https:// form); otherwise null.
- Extract the company/person name into entity when no URL is present.
- When the message is ordinary conversation or a question, answer none.
- Also look across the ENTIRE conversation (not just the latest message) for
  a stated description of what the user's own company sells or its ideal
  customer profile. Extract it into sellingContext verbatim or paraphrased;
  otherwise null. Never guess or infer a product from the prospect being
  discussed - only from what the user has explicitly said about themselves.

Respond with ONLY JSON: {"skill": "prospect|research|qualify|contacts|outreach|none", "url": <string|null>, "entity": <string|null>, "sellingContext": <string|null>}`;

const NONE_RESULT: RouterResult = {
  skill: "none",
  url: null,
  entity: null,
  sellingContext: null,
};

/**
 * Classify a user message into a skill invocation or plain chat.
 * @param config LLM credentials
 * @param message the user's chat message
 * @param history prior conversation turns, scanned for a stated selling context
 * @returns routing decision; parse failures degrade to none
 * @throws LlmError propagated when the endpoint itself fails
 */
export async function routeMessage(
  config: LlmConfig,
  message: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
  searchConfig: SearchConfig | null = null,
): Promise<RouterResult> {
  const raw = await chatCompletion(
    config,
    [
      { role: "system", content: ROUTER_SYSTEM_PROMPT },
      ...history,
      { role: "user", content: message },
    ],
    { temperature: 0, jsonMode: true },
  );
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return NONE_RESULT;
  let routing: RouterResult;
  try {
    routing = ROUTER_RESULT_SCHEMA.parse(JSON.parse(jsonText));
  } catch {
    return NONE_RESULT;
  }
  if (!routing.url && routing.entity && searchConfig) {
    const resolved = await resolveEntityUrl(searchConfig, routing.entity);
    if (resolved) return { ...routing, url: resolved };
  }
  return routing;
}

/**
 * Resolve a company name to its official website via web search.
 * @param searchConfig search credentials
 * @param entity the company name from the routing result
 * @returns the best candidate URL, or null when search finds nothing
 */
async function resolveEntityUrl(
  searchConfig: SearchConfig,
  entity: string,
): Promise<string | null> {
  try {
    const results = await searchWeb(searchConfig, `${entity} official website`, 3);
    const hit = results.find((result) => {
      try {
        const host = new URL(result.url).hostname;
        return !/(linkedin|facebook|twitter|x\.com|wikipedia|crunchbase)\./i.test(
          host,
        );
      } catch {
        return false;
      }
    });
    return hit?.url ?? null;
  } catch {
    return null;
  }
}
