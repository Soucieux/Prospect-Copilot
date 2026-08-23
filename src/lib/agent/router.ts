/**
 * Intent router: classifies a user message against the skill directory.
 * A cheap, temperature-0 LLM call; falls back to plain chat on "none".
 */

import {
  LlmError,
  chatCompletion,
  structuredChatCompletion,
  type LlmConfig,
} from "@/lib/llm";
import { ROUTER_RESULT_SCHEMA, type RouterResult } from "@/lib/agent/schemas";
import { normalizeUrl } from "@/lib/extract/fetch-page";
import {
  RUNTIME_LABEL_DEFAULTS,
  mergeRuntimeLabels,
  type RuntimeLabels,
} from "@/lib/localization";
import {
  STRUCTURED_LLM_RETRY_OPTIONS,
  retryOperation,
} from "@/lib/retry";

const ROUTER_SYSTEM_PROMPT = `You classify user messages for a sales intelligence assistant.
Available skills:
- prospect: full prospect audit of a company URL (analyze, audit, evaluate, "run a prospect on", "sales analysis of"). Use this ONLY when exactly ONE company is the target.
- research: company research and firmographics for a URL. Exactly ONE company.
- qualify: BANT/MEDDIC lead qualification for a URL. Exactly ONE company.
- contacts: find decision makers / buying committee for a URL or company. Exactly ONE company.
- outreach: draft outreach emails for a company or person. Exactly ONE company.
- match: find and rank candidate companies or places for a product. This covers BOTH directions with the exact same skill and result structure:
  - sell: rank companies likely to buy what the user sells (e.g. "who should we target", "where can I sell X", "who is a good customer for X", "find companies that need X").
  - buy: rank companies, retailers, distributors, suppliers, or other places likely to sell the requested product (e.g. "where can I buy X", "who sells X", "find places to purchase X").
  Questions and requests are handled identically. Use match whenever ZERO or TWO-OR-MORE candidate organizations are involved - never for exactly one named company, which uses one of the skills above instead.
Rules:
- Company count decides prospect/research/qualify/contacts/outreach vs match: exactly one named company -> pick from the first five based on intent; zero or several -> match.
- Extract the company URL when present (prefer https:// form); otherwise null. Only set this for a single-company skill.
- Extract the company/person name into entity when no URL is present. Only set this for a single-company skill.
- For match, extract every company name or URL the user explicitly listed into candidates (verbatim, as an array); when none are named (discovery mode), candidates is null.
- For match, set matchDirection to "buy" when the user wants to buy, source,
  purchase, order, or find sellers of the product. Set it to "sell" when the
  user wants to sell, market, offer, find buyers, or find customers. Use "sell"
  for other skills and as the backward-compatible default.
- For match, extract an explicitly requested city, region, or country into
  matchLocation. Preserve the place name in the user's language; otherwise
  return null. Never infer matchLocation from the detected language, IP address,
  a company address, or your own assumptions. The latest explicit location
  overrides earlier locations in the conversation.
- Interpret selling intent semantically in ANY language; never require a fixed
  sentence template such as "we sell X". A user saying that they sell, want to
  sell, plan to offer, market, or find buyers/customers for a product or service
  has supplied a sellingContext. This remains true when the accompanying
  question is brief or indirect, such as "how should I choose?", "where do I
  start?", or "who needs this?". For example, "I want to sell wool blankets,
  how should I choose?" and equivalent wording in any language are match
  requests with "wool blankets" as sellingContext.
- If the assistant previously asked what the user sells, a short product-only
  reply supplies sellingContext and continues match discovery.
- For buy requests, sellingContext stores the product the user wants to buy;
  do not require the user to phrase it as something they sell. Recover that
  product from the ENTIRE conversation when the latest request uses a reference
  such as "it", "this", "that", "them", or "these" in ANY language. For
  example, after discussing wool blankets, "Where can I buy them?" is match,
  matchDirection is "buy", and sellingContext is "wool blankets".
- A location-only follow-up continues the previous match direction and product.
  For example, after "Where can I buy wool blankets in Toronto?", the follow-up
  "What about Montreal?" remains match with matchDirection "buy",
  sellingContext "wool blankets", and matchLocation "Montreal". Apply the same
  rule in ANY language and for sell mode.
- candidates contains ONLY organizations explicitly named by the user as
  prospective buyers in sell mode or prospective sellers in buy mode, plus
  their URLs. A product, service, category, market, geography, or other common
  noun is never a candidate company. Do not copy a sellingContext term into
  candidates.
- Answer none only for messages with no sales or purchase-discovery intent at
  all (greetings, small talk, unrelated questions). Questions about where to
  sell or buy a product are match, never none.
- Also look across the ENTIRE conversation (not just the latest message) for
  the product/service relevant to the current buy or sell request, plus any
  stated customer or purchase criteria. Extract it into sellingContext verbatim
  or paraphrased; otherwise null. Never invent a product that the user did not
  explicitly mention.
- Detect the language of the LATEST user message. Return its commonly used
  language name in "language". URLs, company names, product names, and earlier
  messages must not override the language used by the latest user-authored text.
- Translate every value in the RUNTIME LABELS object into that detected
  language. Preserve every key and every {placeholder} exactly. Product names,
  company names, URLs, numbers, and internal enum values are never translated.

RUNTIME LABELS:
${JSON.stringify(RUNTIME_LABEL_DEFAULTS)}

Respond with ONLY JSON: {"skill": "prospect|research|qualify|contacts|outreach|match|none", "url": <string|null>, "entity": <string|null>, "sellingContext": <string|null>, "matchDirection": "sell|buy", "matchLocation": <string|null>, "candidates": <string[]|null>, "language": "<detected language>", "runtimeLabels": {...same keys as RUNTIME LABELS, translated}}`;

/** A routing result with a complete, validated runtime-label set. */
export type ResolvedRouterResult = Omit<RouterResult, "runtimeLabels"> & {
  runtimeLabels: RuntimeLabels;
};

const NONE_RESULT: ResolvedRouterResult = {
  skill: "none",
  url: null,
  entity: null,
  sellingContext: null,
  matchDirection: "sell",
  matchLocation: null,
  candidates: null,
  language: "English",
  runtimeLabels: RUNTIME_LABEL_DEFAULTS,
};

/** Raised when the router model returns text that does not satisfy its schema. */
export class RouterOutputError extends Error {
  /** Create an invalid-router-output failure for graph retry classification. */
  public constructor() {
    super("Router returned invalid structured output");
    this.name = "RouterOutputError";
  }
}

/**
 * Run the router without resolving company names into URLs.
 * @param config LLM credentials
 * @param message latest user-authored message
 * @param history prior bounded conversation turns
 * @param signal cancels the provider request
 * @returns validated routing and a complete runtime-label set
 * @throws RouterOutputError when structured output is missing or invalid
 */
export async function routeMessageForWorkflow(
  config: LlmConfig,
  message: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
  signal?: AbortSignal,
): Promise<ResolvedRouterResult> {
  try {
    const parsed = await structuredChatCompletion(
      config,
      [
        { role: "system", content: ROUTER_SYSTEM_PROMPT },
        ...history,
        { role: "user", content: message },
      ],
      ROUTER_RESULT_SCHEMA,
      { temperature: 0, schemaName: "route_request", signal },
    );
    return {
      ...parsed,
      runtimeLabels: mergeRuntimeLabels(parsed.runtimeLabels),
    };
  } catch (caught) {
    signal?.throwIfAborted();
    if (caught instanceof LlmError) throw caught;
    throw new RouterOutputError();
  }
}

/**
 * Classify a user message into a skill invocation or plain chat.
 * @param config LLM credentials
 * @param message the user's chat message
 * @param history prior turns, scanned for the current product context
 * @param signal cancels routing and any company-name resolution
 * @returns routing decision; parse failures degrade to none
 * @throws LlmError propagated when the endpoint itself fails
 */
export async function routeMessage(
  config: LlmConfig,
  message: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
  signal?: AbortSignal,
): Promise<ResolvedRouterResult> {
  let routing: ResolvedRouterResult;
  try {
    routing = await routeMessageForWorkflow(config, message, history, signal);
  } catch (caught) {
    if (!(caught instanceof RouterOutputError)) throw caught;
    return NONE_RESULT;
  }
  if (!routing.url && routing.entity) {
    const resolved = await resolveCompanyUrl(config, routing.entity, signal);
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
 * @returns false for unparseable URLs, single-label hosts, or known
 *   non-company hosts
 */
export function isLikelyCompanyUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname.includes(".") && !NON_COMPANY_HOST_PATTERN.test(hostname)
    );
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
 * @param signal cancels the provider request
 * @returns the guessed URL, or null when unknown/unparseable/not company-like
 */
export async function resolveCompanyUrl(
  config: LlmConfig,
  entity: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const raw = await retryOperation(
      () =>
        chatCompletion(
          config,
          [
            { role: "system", content: URL_GUESS_SYSTEM_PROMPT },
            { role: "user", content: entity },
          ],
          { temperature: 0, signal },
        ),
      { ...STRUCTURED_LLM_RETRY_OPTIONS, signal },
    );
    const candidate = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
    if (!candidate || candidate.toLowerCase() === "unknown") return null;
    const url = normalizeUrl(candidate).toString();
    return isLikelyCompanyUrl(url) ? url : null;
  } catch (caught) {
    signal?.throwIfAborted();
    return null;
  }
}
