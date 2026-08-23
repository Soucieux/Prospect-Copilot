import { NextRequest } from "next/server";
import { z } from "zod";
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  LLM_API_KEY_HEADER,
  LLM_BASE_URL_HEADER,
  LLM_MODEL_HEADER,
} from "@/lib/constants";
import { LlmError, type LlmConfig } from "@/lib/llm";
import {
  LlmEndpointPolicyError,
  resolveAllowedLlmBaseUrl,
} from "@/lib/llm-endpoint-policy";
import type { ChatEvent } from "@/lib/agent/schemas";
import {
  MAX_CHAT_HISTORY_CONTENT_CHARS,
  MAX_CHAT_HISTORY_ITEMS,
} from "@/lib/chat-history";
import { RUNTIME_LABEL_DEFAULTS } from "@/lib/localization";
import { runWorkflow } from "@/lib/workflow/graph";

export const runtime = "nodejs";
export const maxDuration = 300;

export const CHAT_REQUEST_SCHEMA = z.object({
  message: z.string().min(1).max(8_000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(MAX_CHAT_HISTORY_CONTENT_CHARS),
      }),
    )
    .max(MAX_CHAT_HISTORY_ITEMS)
    .default([]),
});

/**
 * Extract the per-request BYOK LLM config from headers.
 * @param request the incoming chat request
 * @returns LLM config, or null when the API key header is missing
 */
function readLlmConfig(request: NextRequest): LlmConfig | null {
  const apiKey = request.headers.get(LLM_API_KEY_HEADER)?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: resolveAllowedLlmBaseUrl(
      request.headers.get(LLM_BASE_URL_HEADER)?.trim() || DEFAULT_LLM_BASE_URL,
    ),
    model: request.headers.get(LLM_MODEL_HEADER)?.trim() || DEFAULT_LLM_MODEL,
  };
}

/**
 * Encode one wire event as an SSE frame.
 * @param event the typed event payload
 * @returns a `data: {...}\n\n` frame string
 */
function sseFrame(event: ChatEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Handle one /api/chat request: route the message to a skill (or plain
 * chat) and stream progress/tokens/report/error events back as SSE.
 * @param request the incoming chat request
 * @returns an SSE stream response
 */
export async function POST(request: NextRequest): Promise<Response> {
  let config: LlmConfig | null;
  try {
    config = readLlmConfig(request);
  } catch (caught) {
    if (caught instanceof LlmEndpointPolicyError) {
      return Response.json({ error: caught.message }, { status: 400 });
    }
    throw caught;
  }
  if (!config) {
    return Response.json(
      { error: `Missing ${LLM_API_KEY_HEADER} header` },
      { status: 400 },
    );
  }

  const rawBody: unknown = await request.json().catch(() => null);
  const parsedBody = CHAT_REQUEST_SCHEMA.safeParse(rawBody);
  if (!parsedBody.success) {
    return Response.json(
      { error: `Invalid request body: ${parsedBody.error.message}` },
      { status: 400 },
    );
  }
  const { message, history } = parsedBody.data;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatEvent): void => {
        if (request.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(event)));
        } catch {
          // The browser may have stopped the request between the signal check
          // and enqueue; upstream work receives the same abort signal.
        }
      };
      let runtimeLabels = RUNTIME_LABEL_DEFAULTS;
      try {
        await runWorkflow(
          {
            requestId: crypto.randomUUID(),
            message,
            history,
          },
          {
            config,
            signal: request.signal,
            emit: send,
            setRuntimeLabels: (labels) => {
              runtimeLabels = labels;
            },
          },
        );
      } catch (caught) {
        if (request.signal.aborted) return;
        const errorMessage = caught instanceof LlmError
          ? `${runtimeLabels.requestFailed} (${caught.status})`
          : runtimeLabels.requestFailed;
        send({ type: "error", message: errorMessage });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by a cancelled browser request.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}
