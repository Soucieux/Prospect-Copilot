import { describe, expect, it } from "vitest";
import {
  MAX_CHAT_HISTORY_CONTENT_CHARS,
  MAX_CHAT_HISTORY_ITEMS,
  buildChatHistory,
} from "./chat-history";
import type { ChatMessage } from "./chat-types";

describe("buildChatHistory", () => {
  it("keeps only the newest allowed turns", () => {
    const messages: ChatMessage[] = Array.from(
      { length: MAX_CHAT_HISTORY_ITEMS + 4 },
      (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index}`,
      }),
    );
    const history = buildChatHistory(messages);
    expect(history).toHaveLength(MAX_CHAT_HISTORY_ITEMS);
    expect(history[0]?.content).toBe("message-4");
    expect(history.at(-1)?.content).toBe(
      `message-${MAX_CHAT_HISTORY_ITEMS + 3}`,
    );
  });

  it("bounds each wire item without changing the local message", () => {
    const content = "x".repeat(MAX_CHAT_HISTORY_CONTENT_CHARS + 20);
    const messages: ChatMessage[] = [{ role: "user", content }];
    expect(buildChatHistory(messages)[0]?.content).toHaveLength(
      MAX_CHAT_HISTORY_CONTENT_CHARS,
    );
    expect(messages[0]?.content).toBe(content);
  });
});
