/** LangChain model adapter for OpenAI-compatible chat endpoints. */

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

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
  /** Cancels the provider request when the originating chat request stops. */
  signal?: AbortSignal;
}

export interface StructuredLlmCallOptions extends LlmCallOptions {
  /** Stable operation name used in LangChain structured-output metadata. */
  schemaName?: string;
}

export class LlmError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

/** Provider request timeout that is distinct from caller cancellation. */
export class LlmTimeoutError extends LlmError {
  public constructor() {
    super("LLM request timed out", 408);
    this.name = "LlmTimeoutError";
  }
}

/** Invalid JSON/schema output produced by a successful model response. */
export class LlmStructuredOutputError extends Error {
  public constructor(cause: unknown) {
    super("Structured model response was invalid", { cause });
    this.name = "LlmStructuredOutputError";
  }
}

const REQUEST_TIMEOUT_MS = 120_000;

/** Build the absolute chat-completions URL for diagnostic compatibility. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/** Convert the app's stable message shape into LangChain message objects. */
function toLangChainMessages(messages: LlmMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (message.role === "system") return new SystemMessage(message.content);
    if (message.role === "assistant") return new AIMessage(message.content);
    return new HumanMessage(message.content);
  });
}

/** Convert text or text content blocks from a LangChain message to one string. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        return block.text;
      }
      return "";
    })
    .join("");
}

/**
 * Tolerate OpenAI-compatible providers that omit a response Content-Type.
 * The SDK otherwise treats their valid JSON/SSE payload as an empty result.
 */
const providerFetch: typeof fetch = async (input, init) => {
  const response = await globalThis.fetch(input, init);
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType && !contentType.startsWith("text/plain")) return response;
  const headers = new Headers(response.headers);
  const requestBody = typeof init?.body === "string" ? init.body : "";
  headers.set(
    "content-type",
    requestBody.includes('"stream":true')
      ? "text/event-stream"
      : "application/json",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/** Create one provider model while leaving retries owned by app workflows. */
function createModel(
  config: LlmConfig,
  options: LlmCallOptions,
): ChatOpenAI {
  return new ChatOpenAI({
    apiKey: config.apiKey,
    model: config.model,
    temperature: options.temperature,
    timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    maxRetries: 0,
    streamUsage: false,
    configuration: { baseURL: config.baseUrl, fetch: providerFetch },
    ...(options.jsonMode
      ? { modelKwargs: { response_format: { type: "json_object" } } }
      : {}),
  });
}

interface AbortContext {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

/** Combine the provider timeout with caller cancellation for one operation. */
function createAbortContext(options: LlmCallOptions): AbortContext {
  const controller = new AbortController();
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new DOMException("LLM request timed out", "TimeoutError"));
  }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const abortFromCaller = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

/** Normalize provider-specific errors into the app's stable error contract. */
function normalizeProviderError(caught: unknown): LlmError {
  if (caught instanceof LlmError) return caught;
  const source =
    typeof caught === "object" && caught !== null
      ? (caught as Record<string, unknown>)
      : {};
  const status = typeof source.status === "number" ? source.status : 502;
  const detail = caught instanceof Error ? caught.message : String(caught);
  return new LlmError(
    `LLM request failed (${status}): ${detail.slice(0, 500)}`,
    status,
  );
}

/** Execute one LangChain invocation under the app's timeout/error contract. */
async function invokeWithContract<T>(
  options: LlmCallOptions,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = createAbortContext(options);
  try {
    return await operation(abort.signal);
  } catch (caught) {
    if (options.signal?.aborted) options.signal.throwIfAborted();
    if (abort.timedOut()) throw new LlmTimeoutError();
    throw normalizeProviderError(caught);
  } finally {
    abort.cleanup();
  }
}

/** Non-streaming completion through LangChain's ChatOpenAI adapter. */
export async function chatCompletion(
  config: LlmConfig,
  messages: LlmMessage[],
  options: LlmCallOptions = {},
): Promise<string> {
  return invokeWithContract(options, async (signal) => {
    const response = await createModel(config, options).invoke(
      toLangChainMessages(messages),
      { signal, maxRetries: 0 },
    );
    return messageText(response.content);
  });
}

/** Parse and validate JSON-mode output through a LangChain runnable. */
export async function structuredChatCompletion<Schema extends z.ZodTypeAny>(
  config: LlmConfig,
  messages: LlmMessage[],
  schema: Schema,
  options: StructuredLlmCallOptions = {},
): Promise<z.infer<Schema>> {
  const abort = createAbortContext(options);
  try {
    const runnable = createModel(config, options).withStructuredOutput<
      z.infer<Schema>
    >(schema, {
      method: "jsonMode",
      name: options.schemaName,
    });
    return await runnable.invoke(toLangChainMessages(messages), {
      signal: abort.signal,
    });
  } catch (caught) {
    if (options.signal?.aborted) options.signal.throwIfAborted();
    if (abort.timedOut()) throw new LlmTimeoutError();
    const name = caught instanceof Error ? caught.name : "";
    const code =
      typeof caught === "object" && caught !== null && "lc_error_code" in caught
        ? String((caught as { lc_error_code: unknown }).lc_error_code)
        : "";
    if (
      caught instanceof z.ZodError ||
      caught instanceof SyntaxError ||
      name === "OutputParserException" ||
      code === "OUTPUT_PARSING_FAILURE"
    ) {
      throw new LlmStructuredOutputError(caught);
    }
    throw normalizeProviderError(caught);
  } finally {
    abort.cleanup();
  }
}

/** Streaming completion while preserving the app's text-delta contract. */
export async function* streamChatCompletion(
  config: LlmConfig,
  messages: LlmMessage[],
  options: LlmCallOptions = {},
): AsyncGenerator<string> {
  const abort = createAbortContext(options);
  try {
    const stream = await createModel(config, options).stream(
      toLangChainMessages(messages),
      { signal: abort.signal, maxRetries: 0 },
    );
    for await (const chunk of stream) {
      const delta = messageText(chunk.content);
      if (delta) yield delta;
    }
  } catch (caught) {
    if (options.signal?.aborted) options.signal.throwIfAborted();
    if (abort.timedOut()) throw new LlmTimeoutError();
    throw normalizeProviderError(caught);
  } finally {
    abort.cleanup();
  }
}

/**
 * Extract the {...} JSON object substring from raw LLM text, stripping any
 * markdown code fence around it first. Retained for compatibility and tests.
 */
export function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}
