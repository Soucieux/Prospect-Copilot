import { describe, expect, it } from "vitest";
import {
  LlmEndpointPolicyError,
  resolveAllowedLlmBaseUrl,
} from "./llm-endpoint-policy";

describe("resolveAllowedLlmBaseUrl", () => {
  it("allows the default DeepSeek endpoint", () => {
    expect(resolveAllowedLlmBaseUrl(undefined, undefined)).toBe(
      "https://api.deepseek.com",
    );
  });

  it("rejects a browser-selected endpoint that the server did not approve", () => {
    expect(() =>
      resolveAllowedLlmBaseUrl("http://127.0.0.1:3101/v1", undefined),
    ).toThrow(LlmEndpointPolicyError);
  });

  it("allows an exact custom endpoint configured by the server", () => {
    expect(
      resolveAllowedLlmBaseUrl(
        "http://127.0.0.1:11434/v1/",
        "https://api.openai.com/v1, http://127.0.0.1:11434/v1",
      ),
    ).toBe("http://127.0.0.1:11434/v1");
  });

  it("does not approve sibling paths or hosts", () => {
    expect(() =>
      resolveAllowedLlmBaseUrl(
        "http://127.0.0.1:11434/admin",
        "http://127.0.0.1:11434/v1",
      ),
    ).toThrow(/not approved/);
  });

  it("rejects credentials, queries, fragments, and unsupported protocols", () => {
    expect(() =>
      resolveAllowedLlmBaseUrl(
        "https://user:secret@example.com/v1",
        "https://user:secret@example.com/v1",
      ),
    ).toThrow(/credentials/);
    expect(() =>
      resolveAllowedLlmBaseUrl(
        "https://example.com/v1?target=internal",
        "https://example.com/v1?target=internal",
      ),
    ).toThrow(/query/);
    expect(() =>
      resolveAllowedLlmBaseUrl("file:///tmp/provider", "file:///tmp/provider"),
    ).toThrow(/HTTP or HTTPS/);
  });
});
