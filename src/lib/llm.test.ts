import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCompletion, extractJsonObject } from "./llm";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractJsonObject", () => {
  it("returns the object span from plain JSON text", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("strips a markdown code fence with a json language tag", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips a markdown code fence with no language tag", () => {
    expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("ignores preamble and trailing text around the object", () => {
    expect(extractJsonObject('Here is the result: {"a":1} Thanks!')).toBe(
      '{"a":1}',
    );
  });

  it("captures a nested object using the outermost braces", () => {
    expect(extractJsonObject('{"a":{"b":2}}')).toBe('{"a":{"b":2}}');
  });

  it("returns null when there is no JSON object", () => {
    expect(extractJsonObject("no json here")).toBeNull();
  });

  it("returns null for an unterminated object", () => {
    expect(extractJsonObject("{ incomplete")).toBeNull();
  });
});

describe("chatCompletion", () => {
  it("aborts the provider request when the caller signal stops", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      ),
    );
    const controller = new AbortController();
    const pending = chatCompletion(
      {
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        model: "test-model",
      },
      [{ role: "user", content: "hello" }],
      { signal: controller.signal },
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
