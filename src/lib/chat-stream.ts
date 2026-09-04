/**
 * The /api/chat SSE wire reader. Pure protocol handling kept out of the page
 * component so it can be exercised without React, matching how chat-state and
 * chat-history already separate logic from rendering.
 */

import { REPORT_STATE_SCHEMA } from "@/lib/agent/schemas";
import type { ChatMessage, ProgressEvent } from "@/lib/chat-types";

/** Applies an immutable patch to the trailing assistant message. */
export type UpdateLastMessage = (
  patch: (message: ChatMessage) => ChatMessage,
) => void;

const AGENT_STATUSES = ["running", "done", "failed"] as const;

/**
 * Narrow an agent status from the wire instead of asserting it.
 * @param value the raw status field carried by an agent event
 * @returns the status when recognized, otherwise undefined
 */
function agentStatus(value: unknown): ProgressEvent["status"] {
  return AGENT_STATUSES.find((status) => status === value);
}

/**
 * Read the SSE stream from /api/chat, updating the last assistant message.
 * @param body the fetch response body
 * @param updateLast patches the trailing assistant message
 */
export async function consumeStream(
  body: ReadableStream<Uint8Array>,
  updateLast: UpdateLastMessage,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      applyEvent(frame, updateLast);
    }
  }
}

/**
 * Apply one SSE frame to the trailing assistant message.
 * @param frame raw SSE frame
 * @param updateLast patches the trailing assistant message
 */
function applyEvent(
  frame: string,
  updateLast: UpdateLastMessage,
): void {
  const trimmed = frame.trim();
  if (!trimmed.startsWith("data:")) return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed.slice(5).trim());
  } catch {
    return;
  }
  if (event.type === "token") {
    const text = typeof event.text === "string" ? event.text : "";
    updateLast((message) => ({ ...message, content: message.content + text }));
  } else if (event.type === "phase") {
    updateLast((message) => ({
      ...message,
      progress: [
        ...(message.progress ?? []),
        {
          kind: "phase",
          label: String(event.phase),
          detail: String(event.detail),
        },
      ],
    }));
  } else if (event.type === "agent") {
    updateLast((message) => ({
      ...message,
      progress: [
        ...(message.progress ?? []),
        {
          kind: "agent",
          label: String(event.agent),
          detail: String(event.detail),
          status: agentStatus(event.status),
          score: typeof event.score === "number" ? event.score : undefined,
        },
      ],
    }));
  } else if (event.type === "report") {
    // Validated rather than cast: this is the one event whose shape is complex
    // and which is persisted, so a contract break must not reach the renderer.
    const parsed = REPORT_STATE_SCHEMA.safeParse(event.report);
    if (!parsed.success) return;
    const report = parsed.data;
    updateLast((message) => ({ ...message, report }));
  } else if (event.type === "error") {
    throw new Error(String(event.message));
  }
}
