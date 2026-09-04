import { describe, expect, it } from "vitest";
import { createConversation, titleFromMessages } from "@/lib/storage/conversations";
import type { ChatMessage } from "@/lib/chat-types";

describe("createConversation", () => {
  it("starts empty with matching created and updated stamps", () => {
    const conversation = createConversation();
    expect(conversation.messages).toEqual([]);
    expect(conversation.createdAt).toBe(conversation.updatedAt);
    expect(conversation.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("titleFromMessages", () => {
  it("titles a conversation from its first user message", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Hi" },
      { role: "user", content: "analyze https://acme.example.com" },
    ];
    expect(titleFromMessages(messages)).toBe("analyze https://acme.example.com");
  });

  it("collapses whitespace in the title", () => {
    expect(
      titleFromMessages([{ role: "user", content: "  who   should\nwe target " }]),
    ).toBe("who should we target");
  });

  it("truncates a long first message with an ellipsis", () => {
    const title = titleFromMessages([
      { role: "user", content: "x".repeat(80) },
    ]);
    expect(title).toHaveLength(61);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back when no user message exists yet", () => {
    expect(titleFromMessages([])).toBe("New conversation");
  });
});
