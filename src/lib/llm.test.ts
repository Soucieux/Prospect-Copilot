import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  LlmError,
  LlmStructuredOutputError,
  LlmTimeoutError,
  chatCompletion,
  streamChatCompletion,
  structuredChatCompletion,
} from "./llm";

const CONFIG = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "test-key",
  model: "test-model",
};

/**
 * Build one OpenAI-compatible non-streaming completion response.
 * @param content assistant message text the provider should return
 * @param status HTTP status for the stubbed response
 * @returns a Response the stubbed fetch can resolve with
 */
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

describe("provider failure classification", () => {
  it("keeps the provider's own status on a rejected request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );
    await expect(
      chatCompletion(CONFIG, [{ role: "user", content: "hi" }]),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("falls back to 502 when a transport failure carries no status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    );
    await expect(
      chatCompletion(CONFIG, [{ role: "user", content: "hi" }]),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("surfaces the caller's cancellation rather than a provider error", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw new Error("aborted downstream");
      }),
    );
    await expect(
      chatCompletion(CONFIG, [{ role: "user", content: "hi" }], {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports invalid structured output separately from a provider outage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completionResponse("this is not json")),
    );
    await expect(
      structuredChatCompletion(
        CONFIG,
        [{ role: "user", content: "hi" }],
        z.object({ skill: z.string() }),
        { schemaName: "route" },
      ),
    ).rejects.toBeInstanceOf(LlmStructuredOutputError);
  });

  it("reports a provider outage during structured output as a provider error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gateway down", { status: 502 })),
    );
    await expect(
      structuredChatCompletion(
        CONFIG,
        [{ role: "user", content: "hi" }],
        z.object({ skill: z.string() }),
        { schemaName: "route" },
      ),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it("surfaces a provider failure raised mid-stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gateway down", { status: 503 })),
    );
    const consume = async (): Promise<void> => {
      for await (const _delta of streamChatCompletion(CONFIG, [
        { role: "user", content: "hi" },
      ])) {
        // drained only to reach the failure
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(LlmError);
  });
});
