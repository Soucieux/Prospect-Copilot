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
import {
  RUNTIME_LABEL_DEFAULTS,
  formatRuntimeLabel,
  localizedSkillName,
  type LocalizedSkillName,
  type RuntimeLabels,
} from "@/lib/localization";

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
 * Build the localized scorecard labels stored with one report.
 * @param labels complete runtime translations for the request
 * @param skill internal report kind
 * @param confidenceValue localized confidence value when the report has one
 * @returns localized scorecard chrome
 */
function scoreLabels(
  labels: RuntimeLabels,
  skill: LocalizedSkillName,
  confidenceValue: string = "",
): {
  grade: string;
  confidence: string;
  confidenceValue: string;
  report: string;
} {
  const skillName = localizedSkillName(labels, skill);
  return {
    grade: labels.gradeLabel,
    confidence: labels.confidenceLabel,
    confidenceValue,
    report: formatRuntimeLabel(labels.reportTemplate, { skill: skillName }),
  };
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
        const routing = await routeMessage(
          config,
          message,
          history,
          request.signal,
        );
        runtimeLabels = routing.runtimeLabels;
        if (routing.skill === "prospect" && routing.url) {
          send({
            type: "phase",
            phase: "routing",
            detail: runtimeLabels.matchedProspect,
          });
          const outcome = await runProspectPipeline(
            config,
            routing.url,
            send,
            routing.sellingContext,
            message,
            routing.language,
            runtimeLabels,
            request.signal,
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
              categories: outcome.composite.weighted.map((row, index) => ({
                category: outcome.categoryLabels[index] ?? row.category,
                score: row.score,
                weight: row.weight,
              })),
              matches: null,
              matchLabels: null,
              scoreLabels: scoreLabels(
                runtimeLabels,
                "prospect",
                outcome.confidenceLabel,
              ),
              markdown: outcome.markdown,
            },
          });
        } else if (routing.skill === "match") {
          if (!routing.sellingContext && !routing.candidates?.length) {
            send({
              type: "token",
              text:
                routing.matchDirection === "buy"
                  ? runtimeLabels.matchBuyNudge
                  : runtimeLabels.matchNudge,
            });
          } else {
            send({
              type: "phase",
              phase: "routing",
              detail:
                routing.matchDirection === "buy"
                  ? runtimeLabels.matchedBuyMatch
                  : runtimeLabels.matchedMatch,
            });
            const { markdown, title, matches, cardLabels } = await runMatchSkill(
              config,
              routing.sellingContext,
              routing.candidates,
              send,
              message,
              routing.language,
              runtimeLabels,
              routing.matchDirection,
              routing.matchLocation,
              request.signal,
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
                matchLabels: cardLabels,
                scoreLabels: scoreLabels(runtimeLabels, "match"),
                markdown,
              },
            });
          }
        } else if (routing.skill !== "none" && routing.skill !== "prospect") {
          const skill = routing.skill as StandaloneSkillName;
          send({
            type: "phase",
            phase: "routing",
            detail: formatRuntimeLabel(runtimeLabels.matchedSkillTemplate, {
              skill: localizedSkillName(runtimeLabels, skill),
            }),
          });
          const { markdown, title } = await runStandaloneSkill(
            config,
            skill,
            routing.url,
            routing.entity ?? null,
            send,
            routing.sellingContext,
            message,
            routing.language,
            runtimeLabels,
            request.signal,
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
              matchLabels: null,
              scoreLabels: scoreLabels(runtimeLabels, skill),
              markdown,
            },
          });
        } else {
          await streamPlainChat(
            config,
            message,
            history,
            send,
            request.signal,
          );
        }
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

/**
 * Stream a plain chat reply token by token.
 * @param config LLM credentials
 * @param message the new user message
 * @param history prior conversation turns
 * @param send event emitter
 * @param signal cancels provider streaming
 */
async function streamPlainChat(
  config: LlmConfig,
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  send: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  for await (const delta of streamChatCompletion(
    config,
    [
      { role: "system", content: PLAIN_CHAT_SYSTEM_PROMPT },
      ...history,
      { role: "user", content: message },
    ],
    { signal },
  )) {
    send({ type: "token", text: delta });
  }
}
