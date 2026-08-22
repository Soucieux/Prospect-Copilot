import { NextRequest } from "next/server";
import { z } from "zod";
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  LLM_API_KEY_HEADER,
  LLM_BASE_URL_HEADER,
  LLM_MODEL_HEADER,
  RESPOND_IN_USER_LANGUAGE,
} from "@/lib/constants";
import { LlmError, streamChatCompletion, type LlmConfig } from "@/lib/llm";
import { routeMessage } from "@/lib/agent/router";
import { runProspectPipeline } from "@/lib/agent/orchestrator";
import {
  runStandaloneSkill,
  type StandaloneSkillName,
} from "@/lib/skills/standalone";
import { runMatchSkill } from "@/lib/skills/match";
import type { ChatEvent } from "@/lib/agent/schemas";

export const runtime = "nodejs";
export const maxDuration = 300;

const REQUEST_SCHEMA = z.object({
  message: z.string().min(1).max(8_000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .max(50)
    .default([]),
});

const PLAIN_CHAT_SYSTEM_PROMPT = `You are a helpful sales intelligence assistant. Answer concisely and practically.
${RESPOND_IN_USER_LANGUAGE}`;

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
    baseUrl:
      request.headers.get(LLM_BASE_URL_HEADER)?.trim() ||
      DEFAULT_LLM_BASE_URL,
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
  const config = readLlmConfig(request);
  if (!config) {
    return Response.json(
      { error: `Missing ${LLM_API_KEY_HEADER} header` },
      { status: 400 },
    );
  }

  const rawBody: unknown = await request.json().catch(() => null);
  const parsedBody = REQUEST_SCHEMA.safeParse(rawBody);
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
      const send = (event: ChatEvent): void =>
        controller.enqueue(encoder.encode(sseFrame(event)));
      try {
        const routing = await routeMessage(config, message, history);
        if (routing.skill === "prospect" && routing.url) {
          send({
            type: "phase",
            phase: "routing",
            detail: "Matched the prospect audit skill - starting full analysis",
          });
          const outcome = await runProspectPipeline(
            config,
            routing.url,
            send,
            routing.sellingContext,
          );
          send({
            type: "report",
            report: {
              kind: "prospect",
              companyName: outcome.companyName,
              url: outcome.url,
              score: outcome.composite.score,
              grade: outcome.composite.grade,
              confidence: outcome.composite.confidence,
              categories: outcome.composite.weighted.map((row) => ({
                category: row.category,
                score: row.score,
                weight: row.weight,
              })),
              matches: null,
              markdown: outcome.markdown,
            },
          });
        } else if (routing.skill === "match") {
          if (!routing.sellingContext && !routing.candidates?.length) {
            send({
              type: "token",
              text: 'Tell me what you sell (e.g. "we sell payroll software for mid-market companies") and I can find and rank the best-fit companies for it.',
            });
          } else {
            send({
              type: "phase",
              phase: "routing",
              detail: "Matched the match skill - finding candidate prospects",
            });
            const { markdown, title, matches } = await runMatchSkill(
              config,
              routing.sellingContext,
              routing.candidates,
              send,
            );
            send({
              type: "report",
              report: {
                kind: "match",
                companyName: title,
                url: null,
                score: null,
                grade: null,
                confidence: null,
                categories: null,
                matches,
                markdown,
              },
            });
          }
        } else if (routing.skill !== "none" && routing.skill !== "prospect") {
          const skill = routing.skill as StandaloneSkillName;
          send({
            type: "phase",
            phase: "routing",
            detail: `Matched the ${skill} skill`,
          });
          const { markdown, title } = await runStandaloneSkill(
            config,
            skill,
            routing.url,
            routing.entity ?? null,
            send,
            routing.sellingContext,
          );
          send({
            type: "report",
            report: {
              kind: skill,
              companyName: title,
              url: routing.url,
              score: null,
              grade: null,
              confidence: null,
              categories: null,
              matches: null,
              markdown,
            },
          });
        } else {
          await streamPlainChat(config, message, history, send);
        }
      } catch (caught) {
        const errorMessage =
          caught instanceof LlmError
            ? caught.message
            : `Request failed: ${String(caught)}`;
        send({ type: "error", message: errorMessage });
      } finally {
        controller.close();
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

/**
 * Stream a plain chat reply token by token.
 * @param config LLM credentials
 * @param message the new user message
 * @param history prior conversation turns
 * @param send event emitter
 */
async function streamPlainChat(
  config: LlmConfig,
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  send: (event: ChatEvent) => void,
): Promise<void> {
  for await (const delta of streamChatCompletion(config, [
    { role: "system", content: PLAIN_CHAT_SYSTEM_PROMPT },
    ...history,
    { role: "user", content: message },
  ])) {
    send({ type: "token", text: delta });
  }
}
