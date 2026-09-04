import type { ChatMessage } from "@/lib/chat-types";

/** Server and client limits for conversation context sent to one LLM request. */
export const MAX_CHAT_HISTORY_ITEMS = 50;
export const MAX_CHAT_HISTORY_CONTENT_CHARS = 8_000;

export interface ChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

/**
 * Build bounded wire history without modifying the messages persisted locally.
 * @param messages the full locally persisted conversation
 * @returns the trailing turns, each truncated to the per-item character limit
 */
export function buildChatHistory(messages: ChatMessage[]): ChatHistoryItem[] {
  return messages
    .slice(-MAX_CHAT_HISTORY_ITEMS)
    .map(({ role, content }) => ({
      role,
      content: content.slice(0, MAX_CHAT_HISTORY_CONTENT_CHARS),
    }));
}
