/** LangChain model adapter for OpenAI-compatible chat endpoints. */

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { z, ZodError } from "zod";
import { createAbortContext, type AbortContext } from "@/lib/retry";

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
  timeoutMs?: number;
  /** Cancels the provider request when the originating chat request stops. */
  signal?: AbortSignal;
}

export interface StructuredLlmCallOptions extends LlmCallOptions {
  /** Stable operation name used in LangChain structured-output metadata. */
  schemaName?: string;
}

/** A failed provider call carrying the HTTP status used for retry decisions. */
export class LlmError extends Error {
  public readonly status: number;

  /**
   * Create a provider failure with its retry-classifying status.
   * @param message human-readable failure detail
   * @param status HTTP status reported by, or inferred for, the provider
   */
  public constructor(message: string, status: number) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

/** Provider request timeout that is distinct from caller cancellation. */
export class LlmTimeoutError extends LlmError {
  /** Create a provider timeout reported as a retryable 408. */
  public constructor() {
    super("LLM request timed out", 408);
    this.name = "LlmTimeoutError";
  }
}

/** Invalid JSON/schema output produced by a successful model response. */
export class LlmStructuredOutputError extends Error {
  /**
   * Create a repairable structured-output failure.
   * @param cause the originating parse or schema error
   */
  public constructor(cause: unknown) {
    super("Structured model response was invalid", { cause });
    this.name = "LlmStructuredOutputError";
  }
}

const REQUEST_TIMEOUT_MS = 120_000;

/** Provider statuses worth one more attempt; the single owner of this policy. */
export const RETRYABLE_LLM_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Classify failures from one structured LLM operation.
 * @param caught unknown provider, JSON, or schema failure
 * @returns true for temporary provider failures and repairable output errors
 */
export function isRetryableStructuredLlmError(caught: unknown): boolean {
  if (caught instanceof LlmError) {
    return RETRYABLE_LLM_STATUSES.has(caught.status);
  }
  return (
    caught instanceof TypeError ||
    caught instanceof SyntaxError ||
    caught instanceof ZodError ||
    caught instanceof LlmStructuredOutputError
  );
}

/** Standard two-attempt policy for non-streamed structured model calls. */
export const STRUCTURED_LLM_RETRY_OPTIONS = {
  maxAttempts: 2,
  initialDelayMs: 300,
  maxDelayMs: 1_000,
  shouldRetry: isRetryableStructuredLlmError,
} as const;

/**
 * Convert the app's stable message shape into LangChain message objects.
 * @param messages app-shaped chat messages in send order
 * @returns the equivalent LangChain message instances
 */
function toLangChainMessages(messages: LlmMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (message.role === "system") return new SystemMessage(message.content);
    if (message.role === "assistant") return new AIMessage(message.content);
    return new HumanMessage(message.content);
  });
}

/**
 * Convert text or text content blocks from a LangChain message to one string.
 * @param content raw message content, either a string or content blocks
 * @returns the concatenated text, or an empty string when none is present
 */
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

/**
 * Create one provider model while leaving retries and the deadline owned by
 * the app: the abort context every call runs under is the only timeout, so a
 * timed-out call is always classified the same way.
 * @param config per-request BYOK endpoint, key, and model
 * @param options temperature for this call
 * @returns a configured adapter with provider retries disabled
 */
function createModel(
  config: LlmConfig,
  options: LlmCallOptions,
): ChatOpenAI {
  return new ChatOpenAI({
    apiKey: config.apiKey,
    model: config.model,
    temperature: options.temperature,
    maxRetries: 0,
    streamUsage: false,
    configuration: { baseURL: config.baseUrl, fetch: providerFetch },
  });
}

/**
 * Normalize provider-specific errors into the app's stable error contract.
 * @param caught unknown failure raised by the provider or adapter
 * @returns an LlmError carrying the status used for retry decisions
 */
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

/**
 * Decide whether a failure is the model returning unparseable structured
 * output rather than the provider failing.
 * @param caught unknown failure raised while parsing structured output
 * @returns true for JSON, schema, and LangChain output-parser failures
 */
function isStructuredOutputFailure(caught: unknown): boolean {
  const name = caught instanceof Error ? caught.name : "";
  const code =
    typeof caught === "object" && caught !== null && "lc_error_code" in caught
      ? String((caught as { lc_error_code: unknown }).lc_error_code)
      : "";
  return (
    caught instanceof ZodError ||
    caught instanceof SyntaxError ||
    name === "OutputParserException" ||
    code === "OUTPUT_PARSING_FAILURE"
  );
}

/**
 * Map one failed provider operation onto the app's error contract: the
 * caller's own cancellation first, then the timeout, then the provider error.
 * @param caught unknown failure raised by the operation
 * @param options the call options carrying the caller's signal
 * @param abort the merged abort context the operation ran under
 * @returns the error to throw
 */
function classifyFailure(
  caught: unknown,
  options: LlmCallOptions,
  abort: AbortContext,
): Error {
  if (options.signal?.aborted) options.signal.throwIfAborted();
  if (abort.timedOut()) return new LlmTimeoutError();
  if (caught instanceof LlmStructuredOutputError) return caught;
  return normalizeProviderError(caught);
}

/**
 * Execute one LangChain invocation under the app's timeout/error contract.
 * @param options caller cancellation and timeout for this invocation
 * @param operation receives the merged signal and performs the provider call
 * @returns whatever the operation resolves to
 */
async function invokeWithContract<T>(
  options: LlmCallOptions,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = createAbortContext(
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    options.signal,
  );
  try {
    return await operation(abort.signal);
  } catch (caught) {
    throw classifyFailure(caught, options, abort);
  } finally {
    abort.cleanup();
  }
}

/**
 * Non-streaming completion through LangChain's ChatOpenAI adapter.
 * @param config per-request BYOK endpoint, key, and model
 * @param messages the conversation to send
 * @param options temperature, timeout, and cancellation
 * @returns the model's reply as plain text
 */
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

/**
 * Parse and validate JSON-mode output through a LangChain runnable.
 * @param config per-request BYOK endpoint, key, and model
 * @param messages the conversation to send
 * @param schema Zod schema the reply must satisfy
 * @param options call settings plus the structured-output operation name
 * @returns the parsed value inferred from the schema
 */
export async function structuredChatCompletion<Schema extends z.ZodTypeAny>(
  config: LlmConfig,
  messages: LlmMessage[],
  schema: Schema,
  options: StructuredLlmCallOptions = {},
): Promise<z.infer<Schema>> {
  return invokeWithContract(options, async (signal) => {
    const runnable = createModel(config, options).withStructuredOutput<
      z.infer<Schema>
    >(schema, {
      method: "jsonMode",
      name: options.schemaName,
    });
    try {
      return await runnable.invoke(toLangChainMessages(messages), { signal });
    } catch (caught) {
      if (isStructuredOutputFailure(caught)) {
        throw new LlmStructuredOutputError(caught);
      }
      throw caught;
    }
  });
}

/**
 * Streaming completion while preserving the app's text-delta contract.
 * @param config per-request BYOK endpoint, key, and model
 * @param messages the conversation to send
 * @param options temperature, timeout, and cancellation
 * @yields each non-empty text delta as it arrives
 */
export async function* streamChatCompletion(
  config: LlmConfig,
  messages: LlmMessage[],
  options: LlmCallOptions = {},
): AsyncGenerator<string> {
  const abort = createAbortContext(
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    options.signal,
  );
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
    throw classifyFailure(caught, options, abort);
  } finally {
    abort.cleanup();
  }
}
