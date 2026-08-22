/**
 * Intent router: classifies a user message against the skill directory.
 * A cheap, temperature-0 LLM call; falls back to plain chat on "none".
 */

import { chatCompletion, extractJsonObject, type LlmConfig } from "@/lib/llm";
import { ROUTER_RESULT_SCHEMA, type RouterResult } from "@/lib/agent/schemas";
import { normalizeUrl } from "@/lib/extract/fetch-page";

const ROUTER_SYSTEM_PROMPT = `You classify user messages for a sales intelligence assistant.
Available skills:
- prospect: full prospect audit of a company URL (analyze, audit, evaluate, "run a prospect on", "sales analysis of"). Use this ONLY when exactly ONE company is the target.
- research: company research and firmographics for a URL. Exactly ONE company.
- qualify: BANT/MEDDIC lead qualification for a URL. Exactly ONE company.
- contacts: find decision makers / buying committee for a URL or company. Exactly ONE company.
- outreach: draft outreach emails for a company or person. Exactly ONE company.
- match: find and rank candidate companies as prospects for what the user sells (e.g. "who should we target", "what company should I sell it to", "who is a good customer for X", "which companies would want X", "find companies that need X", "rank these prospects for fit"). This applies just as much when phrased as a question as when phrased as a request - a question asking who to sell to is match, not none. Use this whenever ZERO or TWO-OR-MORE companies are involved - never for exactly one named company, which always uses one of the skills above instead.
Rules:
- Company count decides prospect/research/qualify/contacts/outreach vs match: exactly one named company -> pick from the first five based on intent; zero or several -> match.
- Extract the company URL when present (prefer https:// form); otherwise null. Only set this for a single-company skill.
- Extract the company/person name into entity when no URL is present. Only set this for a single-company skill.
- For match, extract every company name or URL the user explicitly listed into candidates (verbatim, as an array); when none are named (discovery mode), candidates is null.
- Answer none only for messages with no prospecting intent at all (greetings, small talk, unrelated questions) - a question about who to sell to or which companies to target is match, never none.
- Also look across the ENTIRE conversation (not just the latest message) for
  a stated description of what the user's own company sells or its ideal
  customer profile. Extract it into sellingContext verbatim or paraphrased;
  otherwise null. Never guess or infer a product from the prospect being
  discussed - only from what the user has explicitly said about themselves.

Respond with ONLY JSON: {"skill": "prospect|research|qualify|contacts|outreach|match|none", "url": <string|null>, "entity": <string|null>, "sellingContext": <string|null>, "candidates": <string[]|null>}`;

const NONE_RESULT: RouterResult = {
  skill: "none",
  url: null,
  entity: null,
  sellingContext: null,
  candidates: null,
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
  if (!routing.url && routing.entity) {
    const resolved = await resolveCompanyUrl(config, routing.entity);
    if (resolved) return { ...routing, url: resolved };
  }
  return routing;
}

/** Hostnames that are never a company's own site (social/reference platforms). */
const NON_COMPANY_HOST_PATTERN =
  /(linkedin|facebook|twitter|x\.com|wikipedia|crunchbase)\./i;

/**
 * Whether a URL looks like a company's own site rather than a social,
 * reference, or aggregator platform.
 * @param url the candidate URL
 * @returns false for unparseable URLs or known non-company hosts
 */
export function isLikelyCompanyUrl(url: string): boolean {
  try {
    return !NON_COMPANY_HOST_PATTERN.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

const URL_GUESS_SYSTEM_PROMPT = `You help resolve a company or person's name to their official website.
Respond with ONLY the URL in https:// form, and nothing else - no explanation.
If you do not know a real, specific URL for this name, respond with exactly
"unknown" rather than guessing a plausible-looking one.`;

/**
 * Resolve a company name to its official website by asking the LLM directly.
 * The guess is never trusted blindly - callers fetch it before using it, so a
 * wrong or unknown answer just means no page to work from, not a bad report.
 * @param config LLM credentials
 * @param entity the company name to resolve
 * @returns the guessed URL, or null when unknown/unparseable/not company-like
 */
export async function resolveCompanyUrl(
  config: LlmConfig,
  entity: string,
): Promise<string | null> {
  try {
    const raw = await chatCompletion(
      config,
      [
        { role: "system", content: URL_GUESS_SYSTEM_PROMPT },
        { role: "user", content: entity },
      ],
      { temperature: 0 },
    );
    const candidate = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
    if (!candidate || candidate.toLowerCase() === "unknown") return null;
    const url = normalizeUrl(candidate).toString();
    return isLikelyCompanyUrl(url) ? url : null;
  } catch {
    return null;
  }
}
