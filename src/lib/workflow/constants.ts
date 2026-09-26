import { RESPOND_IN_USER_LANGUAGE } from "@/lib/constants";
import { STRUCTURED_LLM_RETRY_OPTIONS } from "@/lib/llm";

/** Top-level and subgraph node identifiers. */
export const WORKFLOW_NODE = {
  understandRequest: "understand_request",
  plainChat: "plain_chat",
  prospectSubgraph: "prospect_subgraph",
  prospectResolveTarget: "prospect_resolve_target",
  prospectFallbackChat: "prospect_fallback_chat",
  prospectDiscover: "prospect_discover",
  prospectAnalyze: "prospect_analyze",
  prospectScore: "prospect_score",
  prospectSynthesize: "prospect_synthesize",
  prospectFormat: "prospect_format",
  matchSubgraph: "match_subgraph",
  matchClarify: "match_clarify",
  matchResolve: "match_resolve",
  matchScore: "match_score",
  matchFormat: "match_format",
  standaloneSubgraph: "standalone_subgraph",
  standaloneRun: "run_standalone",
} as const;

/** Serializable workflow lifecycle values a node can record. */
export const WORKFLOW_STATUS = {
  running: "running",
  completed: "completed",
} as const;

/**
 * LangGraph retry settings for one structured routing request. The graph owns
 * this node's retry, but its budget is the one every structured model call
 * uses, so the numbers are read from that policy rather than repeated.
 */
export const ROUTER_RETRY_POLICY = {
  initialInterval: STRUCTURED_LLM_RETRY_OPTIONS.initialDelayMs,
  backoffFactor: 2,
  maxInterval: STRUCTURED_LLM_RETRY_OPTIONS.initialDelayMs,
  maxAttempts: STRUCTURED_LLM_RETRY_OPTIONS.maxAttempts,
  jitter: false,
  logWarning: false,
} as const;

/** System prompt for the ordinary chat branch. */
export const PLAIN_CHAT_SYSTEM_PROMPT =
  `You are a helpful sales intelligence assistant. Answer concisely and practically.\n${RESPOND_IN_USER_LANGUAGE}`;
