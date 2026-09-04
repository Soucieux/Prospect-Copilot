import { RESPOND_IN_USER_LANGUAGE } from "@/lib/constants";

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

/** Serializable workflow lifecycle values. */
export const WORKFLOW_STATUS = {
  running: "running",
  completed: "completed",
  cancelled: "cancelled",
  failed: "failed",
} as const;

/** Internal phase identifiers preserved on the existing SSE contract. */
export const WORKFLOW_PHASE = {
  routing: "routing",
  discovery: "discovery",
  analysis: "analysis",
  synthesis: "synthesis",
  done: "done",
} as const;

/** LangGraph retry settings for one structured routing request. */
export const ROUTER_RETRY_POLICY = {
  initialInterval: 300,
  backoffFactor: 2,
  maxInterval: 300,
  maxAttempts: 2,
  jitter: false,
  logWarning: false,
} as const;

/** System prompt for the ordinary chat branch. */
export const PLAIN_CHAT_SYSTEM_PROMPT =
  `You are a helpful sales intelligence assistant. Answer concisely and practically.\n${RESPOND_IN_USER_LANGUAGE}`;

/** Recovery language used only when routing cannot identify the user's language. */
export const DEFAULT_RESPONSE_LANGUAGE = "English";
