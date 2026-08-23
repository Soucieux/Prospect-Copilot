import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  LlmError,
  LlmStructuredOutputError,
  LlmTimeoutError,
  chatCompletion,
  extractJsonObject,
  streamChatCompletion,
  structuredChatCompletion,
} from "./llm";

const CONFIG = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "test-key",
  model: "test-model",
};

function completionResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content } }],
    }),
    { status },
  );
}

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
  it("uses the configured OpenAI-compatible model and returns assistant text", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        completionResponse("hello"),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      chatCompletion(CONFIG, [{ role: "user", content: "hi" }]),
    ).resolves.toBe("hello");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      model: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("test-model");
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "hi" });
  });

  it("does not add a hidden LangChain retry layer", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: { message: "busy" } }), {
          status: 503,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      chatCompletion(CONFIG, [{ role: "user", content: "hi" }]),
    ).rejects.toMatchObject({ status: 503 } satisfies Partial<LlmError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies an internal provider timeout separately from cancellation", async () => {
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

    await expect(
      chatCompletion(
        {
          baseUrl: "https://api.example.com",
          apiKey: "test-key",
          model: "test-model",
        },
        [{ role: "user", content: "hello" }],
        { timeoutMs: 1 },
      ),
    ).rejects.toBeInstanceOf(LlmTimeoutError);
  });

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

describe("structuredChatCompletion", () => {
  const SCHEMA = z.object({ answer: z.string() });

  it("uses LangChain JSON mode and validates the schema", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        completionResponse(JSON.stringify({ answer: "yes" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      structuredChatCompletion(
        CONFIG,
        [{ role: "user", content: "Return JSON" }],
        SCHEMA,
        { schemaName: "answer" },
      ),
    ).resolves.toEqual({ answer: "yes" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      response_format?: { type: string };
    };
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("classifies invalid structured output for the workflow retry owner", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => completionResponse('{"wrong":1}')));
    await expect(
      structuredChatCompletion(
        CONFIG,
        [{ role: "user", content: "Return JSON" }],
        SCHEMA,
      ),
    ).rejects.toBeInstanceOf(LlmStructuredOutputError);
  });
});

describe("streamChatCompletion", () => {
  it("preserves incremental text deltas for the existing SSE layer", async () => {
    const payload = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(payload)));
    const chunks: string[] = [];
    for await (const chunk of streamChatCompletion(
      CONFIG,
      [{ role: "user", content: "hi" }],
    )) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toBe("hello");
  });
});
