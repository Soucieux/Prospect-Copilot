import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  LLM_API_KEY_HEADER,
  LLM_BASE_URL_HEADER,
} from "@/lib/constants";
import {
  MAX_CHAT_HISTORY_CONTENT_CHARS,
  MAX_CHAT_HISTORY_ITEMS,
} from "@/lib/chat-history";
import { CHAT_REQUEST_SCHEMA, POST } from "./route";

describe("chat API boundaries", () => {
  it("rejects an unapproved browser-selected LLM endpoint", async () => {
    const request = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: {
        [LLM_API_KEY_HEADER]: "test-key",
        [LLM_BASE_URL_HEADER]: "http://127.0.0.1:3101/v1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "hello", history: [] }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("not approved"),
    });
  });

  it("enforces the shared history item and content limits", () => {
    const tooMany = Array.from(
      { length: MAX_CHAT_HISTORY_ITEMS + 1 },
      () => ({ role: "user", content: "hi" }),
    );
    expect(
      CHAT_REQUEST_SCHEMA.safeParse({ message: "hello", history: tooMany })
        .success,
    ).toBe(false);
    expect(
      CHAT_REQUEST_SCHEMA.safeParse({
        message: "hello",
        history: [
          {
            role: "user",
            content: "x".repeat(MAX_CHAT_HISTORY_CONTENT_CHARS + 1),
          },
        ],
      }).success,
    ).toBe(false);
  });
});
