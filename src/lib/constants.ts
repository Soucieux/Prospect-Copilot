/** Shared constants: default LLM endpoint, wire header names, storage keys. */

export const DEFAULT_LLM_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_LLM_MODEL = "deepseek-chat";

/** Per-request BYOK headers sent from the browser to /api/chat. */
export const LLM_BASE_URL_HEADER = "x-llm-base-url";
export const LLM_API_KEY_HEADER = "x-llm-api-key";
export const LLM_MODEL_HEADER = "x-llm-model";

/** localStorage key for the persisted settings object. */
export const SETTINGS_STORAGE_KEY = "prospect-copilot:settings";

/** localStorage key used to reopen the last active saved conversation. */
export const ACTIVE_CONVERSATION_STORAGE_KEY =
  "prospect-copilot:active-conversation";

/** SSE event types on the /api/chat wire protocol. */
export const EVENT_TOKEN = "token";
export const EVENT_ERROR = "error";

/** Standard label for missing/unverified discovery data across reports and prompts. */
export const NOT_PUBLICLY_AVAILABLE = "Not publicly available";

/** Appended to every user-facing prompt so replies match the user's language. */
export const RESPOND_IN_USER_LANGUAGE =
  "Respond in the same language the user is writing in, detected from their message - never default to English unless they wrote in English.";
