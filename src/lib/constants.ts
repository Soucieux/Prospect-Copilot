/** Shared constants: default LLM endpoint, wire header names, storage keys. */

export const DEFAULT_LLM_BASE_URL = "https://api.z.ai/api/paas/v4";
export const DEFAULT_LLM_MODEL = "glm-5.2";

/** Per-request BYOK headers sent from the browser to /api/chat. */
export const LLM_BASE_URL_HEADER = "x-llm-base-url";
export const LLM_API_KEY_HEADER = "x-llm-api-key";
export const LLM_MODEL_HEADER = "x-llm-model";

/** Volcengine web search (联网搜索) endpoint and per-request BYOK header. */
export const SEARCH_API_URL =
  "https://open.feedcoopapi.com/search_api/global_search";
export const SEARCH_API_KEY_HEADER = "x-search-api-key";

/** localStorage key for the persisted settings object. */
export const SETTINGS_STORAGE_KEY = "prospect-copilot:settings";

/** SSE event types on the /api/chat wire protocol. */
export const EVENT_TOKEN = "token";
export const EVENT_ERROR = "error";
