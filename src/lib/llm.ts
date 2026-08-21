/**
 * Thin client for an OpenAI-compatible chat-completions endpoint (GLM).
 * Streaming and non-streaming calls; no SDK dependency.
 */

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmCallOptions {
  temperature?: number;
  /** Request a JSON-mode response from endpoints that support it. */
  jsonMode?: boolean;
  timeoutMs?: number;
}

export class LlmError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Build the absolute chat-completions URL for a base URL.
 * @param baseUrl OpenAI-compatible base URL, e.g. https://api.z.ai/api/paas/v4
 * @returns {baseUrl}/chat/completions with no duplicate slash
 */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * Build the JSON request body for a chat-completions call.
 * @param config endpoint credentials and model
 * @param messages conversation so far
 * @param stream whether to request an SSE stream
 * @param options temperature and JSON-mode flags
 * @returns the serialized request body
 */
function buildBody(
  config: LlmConfig,
  messages: LlmMessage[],
  stream: boolean,
  options: LlmCallOptions,
): string {
  return JSON.stringify({
    model: config.model,
    messages,
    stream,
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
  });
}

/**
 * Build the request headers for a chat-completions call.
 * @param config endpoint credentials
 * @returns headers with content-type and bearer authorization
 */
function buildHeaders(config: LlmConfig): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
  };
}

/**
 * Non-streaming chat completion; returns the full assistant message content.
 * @param config endpoint credentials and model
 * @param messages conversation so far
 * @param options temperature, JSON mode, timeout
 * @returns the assistant's reply text
 * @throws LlmError on non-2xx or unparseable responses
 */
export async function chatCompletion(
  config: LlmConfig,
  messages: LlmMessage[],
  options: LlmCallOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: buildHeaders(config),
      body: buildBody(config, messages, false, options),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new LlmError(
        `LLM request failed (${response.status}): ${detail.slice(0, 500)}`,
        response.status,
      );
    }
    const payload: unknown = await response.json();
    const content = extractContent(payload);
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streaming chat completion; yields assistant text deltas as they arrive.
 * @param config endpoint credentials and model
 * @param messages conversation so far
 * @param options temperature, timeout
 * @yields incremental text chunks
 * @throws LlmError on non-2xx responses
 */
export async function* streamChatCompletion(
  config: LlmConfig,
  messages: LlmMessage[],
  options: LlmCallOptions = {},
): AsyncGenerator<string> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: buildHeaders(config),
      body: buildBody(config, messages, true, options),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new LlmError(
        `LLM request failed (${response.status}): ${detail.slice(0, 500)}`,
        response.status,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new LlmError("LLM response had no body", 502);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const delta = parseSseLine(line);
        if (delta !== null) yield delta;
      }
    }
    const tail = parseSseLine(buffer);
    if (tail !== null) yield tail;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract one delta from an SSE line, or null for non-data/keepalive lines.
 * @param line raw SSE line such as `data: {"choices":[...]}`
 * @returns the delta text, or null when the line carries no content
 */
function parseSseLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (data === "" || data === "[DONE]") return null;
  try {
    return extractContent(JSON.parse(data), true);
  } catch {
    return null;
  }
}

/**
 * Pull assistant text out of a chat-completions payload.
 * @param payload parsed JSON body (non-stream) or SSE chunk (stream)
 * @param isChunk true when payload is a streaming chunk with choices[0].delta
 * @returns text content, or empty string when absent
 */
function extractContent(payload: unknown, isChunk = false): string {
  if (typeof payload !== "object" || payload === null) return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0] as Record<string, unknown>;
  const holder = isChunk ? first.delta : first.message;
  if (typeof holder !== "object" || holder === null) return "";
  const content = (holder as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

/**
 * Extract the {...} JSON object substring from raw LLM text, stripping any
 * markdown code fence around it first.
 * @param raw the model's reply text
 * @returns the JSON substring, or null when no object span is found
 */
export function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}
