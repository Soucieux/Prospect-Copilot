/**
 * Conversation persistence in IndexedDB (via idb-keyval).
 * All data stays client-side - nothing ever reaches the server.
 */

import { get, set, del, keys } from "idb-keyval";
import type { ChatMessage } from "@/lib/chat-types";

const CONVERSATION_KEY_PREFIX = "conversation:";

/** Maximum length of an auto-generated conversation title. */
const TITLE_MAX_LENGTH = 60;

export interface StoredConversation {
  id: string;
  title: string;
  /** ISO-8601 timestamp, e.g. "2026-08-18T14:02:00.000Z". */
  createdAt: string;
  /** ISO-8601 timestamp of the last update. */
  updatedAt: string;
  messages: ChatMessage[];
}

/**
 * Create a new, empty conversation record.
 * @returns the new conversation with a generated id
 */
export function createConversation(): StoredConversation {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/**
 * Derive a conversation title from its first user message.
 * @param messages the conversation's messages
 * @returns a truncated title, or the fallback when empty
 */
export function titleFromMessages(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser) return "New conversation";
  const trimmed = firstUser.content.trim().replace(/\s+/g, " ");
  return trimmed.length <= TITLE_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, TITLE_MAX_LENGTH)}…`;
}

/**
 * List all stored conversations, newest first.
 * @returns conversations sorted by updatedAt descending
 */
export async function listConversations(): Promise<StoredConversation[]> {
  const allKeys = await keys<string>();
  const conversationKeys = allKeys.filter((key) =>
    typeof key === "string" ? key.startsWith(CONVERSATION_KEY_PREFIX) : false,
  );
  const conversations = await Promise.all(
    conversationKeys.map((key) => get<StoredConversation>(key)),
  );
  return conversations
    .filter((conversation): conversation is StoredConversation =>
      Boolean(conversation),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Insert or update a conversation record (immutably).
 * @param conversation the conversation to persist
 */
export async function saveConversation(
  conversation: StoredConversation,
): Promise<void> {
  await set(CONVERSATION_KEY_PREFIX + conversation.id, conversation);
}

/**
 * Delete a conversation record.
 * @param id the conversation id
 */
export async function deleteConversation(id: string): Promise<void> {
  await del(CONVERSATION_KEY_PREFIX + id);
}
