import type { ChatMessage } from "@/lib/chat-types";

/** Minimal mutable shape shared by React refs and unit tests. */
export interface MessageSnapshot {
  current: ChatMessage[];
}

/**
 * Replace the authoritative conversation snapshot before scheduling a render.
 * @param snapshot synchronous message storage
 * @param next complete next conversation state
 * @returns the same state for passing directly to React's setter
 */
export function replaceMessageSnapshot(
  snapshot: MessageSnapshot,
  next: ChatMessage[],
): ChatMessage[] {
  snapshot.current = next;
  return next;
}

/**
 * Patch the trailing message and synchronously publish the resulting snapshot.
 * @param snapshot synchronous message storage
 * @param patch immutable transform for the final message
 * @returns updated state, or null when the conversation is empty
 */
export function updateLastMessageSnapshot(
  snapshot: MessageSnapshot,
  patch: (message: ChatMessage) => ChatMessage,
): ChatMessage[] | null {
  const lastIndex = snapshot.current.length - 1;
  const last = snapshot.current[lastIndex];
  if (last === undefined) return null;
  const next = [...snapshot.current];
  next[lastIndex] = patch(last);
  snapshot.current = next;
  return next;
}
