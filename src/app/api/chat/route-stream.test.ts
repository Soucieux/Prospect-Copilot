import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, EmitCallback } from "@/lib/agent/schemas";
import { LLM_API_KEY_HEADER } from "@/lib/constants";
import { LlmError } from "@/lib/llm";
import { RUNTIME_LABEL_DEFAULTS, type RuntimeLabels } from "@/lib/localization";
import { resetRateLimit } from "@/lib/rate-limit";

/** Runtime context handed to the mocked workflow by the route under test. */
interface CapturedContext {
  emit: EmitCallback;
  signal: AbortSignal;
  setRuntimeLabels?: (labels: RuntimeLabels) => void;
}

const runWorkflowMock = vi.hoisted(() =>
  vi.fn<(input: unknown, context: CapturedContext) => Promise<void>>(),
);
vi.mock("@/lib/workflow/graph", () => ({ runWorkflow: runWorkflowMock }));

const { POST } = await import("./route");

beforeEach(() => {
  resetRateLimit();
  runWorkflowMock.mockReset();
  runWorkflowMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Build one authorized chat request.
 * @param body request body sent as JSON, or a raw string to send verbatim
 * @param init extra request options such as an abort signal
 * @returns a NextRequest the route accepts past its guard rails
 */
function chatRequest(
  body: unknown = { message: "hello", history: [] },
  init: { signal?: AbortSignal; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: {
      [LLM_API_KEY_HEADER]: "test-key",
      "content-type": "application/json",
      ...init.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: init.signal,
  });
}

/**
 * Read a whole SSE response body and parse each frame's JSON payload.
 * @param response the streaming response returned by the route
 * @returns every decoded event, in order
 */
async function readEvents(response: Response): Promise<ChatEvent[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice("data: ".length)) as ChatEvent);
}

describe("chat route guard rails", () => {
  it("refuses a caller that is over the request limit", async () => {
    let response = new Response();
    for (let attempt = 0; attempt < 21; attempt++) {
      response = await POST(chatRequest());
    }
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
    await expect(response.json()).resolves.toEqual({ error: "Too many requests" });
  });

  it("refuses a request that carries no API key header", async () => {
    const request = new NextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining(LLM_API_KEY_HEADER),
    });
  });

  it("refuses a body that is not valid JSON", async () => {
    const response = await POST(chatRequest("not json at all"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Invalid request body"),
    });
  });

  it("refuses a body whose message is empty", async () => {
    const response = await POST(chatRequest({ message: "", history: [] }));
    expect(response.status).toBe(400);
  });

  it("accepts a body that omits history entirely", async () => {
    const response = await POST(chatRequest({ message: "hello" }));
    expect(response.status).toBe(200);
    await response.text();
    expect(runWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "hello", history: [] }),
      expect.anything(),
    );
  });
});

describe("chat route event stream", () => {
  it("answers with an SSE content type that is never cached", async () => {
    const response = await POST(chatRequest());
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    await response.text();
  });

  it("forwards every workflow event as its own SSE frame", async () => {
    runWorkflowMock.mockImplementation(async (_input, context) => {
      context.emit({ type: "phase", phase: "discovery", detail: "Fetching" });
      context.emit({ type: "token", text: "hi" });
    });
    const events = await readEvents(await POST(chatRequest()));
    expect(events).toEqual([
      { type: "phase", phase: "discovery", detail: "Fetching" },
      { type: "token", text: "hi" },
    ]);
  });

  it("gives the workflow a request id that is not the caller's message", async () => {
    let seen: { requestId?: string } = {};
    runWorkflowMock.mockImplementation(async (input) => {
      seen = input as { requestId?: string };
    });
    await (await POST(chatRequest())).text();
    expect(seen.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("closes the stream once the workflow resolves", async () => {
    const response = await POST(chatRequest());
    await expect(response.text()).resolves.toBe("");
  });
});

describe("chat route failure handling", () => {
  it("reports a provider failure with its status and the default label", async () => {
    runWorkflowMock.mockRejectedValue(new LlmError("upstream", 503));
    const events = await readEvents(await POST(chatRequest()));
    expect(events).toEqual([
      {
        type: "error",
        message: `${RUNTIME_LABEL_DEFAULTS.requestFailed} (503)`,
      },
    ]);
  });

  it("reports any other failure without leaking its message", async () => {
    runWorkflowMock.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.5:5432"),
    );
    const events = await readEvents(await POST(chatRequest()));
    expect(events).toEqual([
      { type: "error", message: RUNTIME_LABEL_DEFAULTS.requestFailed },
    ]);
    expect(JSON.stringify(events)).not.toContain("10.0.0.5");
  });

  it("reports the failure in the language the router selected", async () => {
    runWorkflowMock.mockImplementation(async (_input, context) => {
      context.setRuntimeLabels?.({
        ...RUNTIME_LABEL_DEFAULTS,
        requestFailed: "La demande a échoué.",
      });
      throw new LlmError("upstream", 500);
    });
    const events = await readEvents(await POST(chatRequest()));
    expect(events).toEqual([
      { type: "error", message: "La demande a échoué. (500)" },
    ]);
  });

  it("stays silent when the caller aborted before the failure", async () => {
    const controller = new AbortController();
    runWorkflowMock.mockImplementation(async () => {
      controller.abort();
      throw new Error("cancelled downstream");
    });
    const events = await readEvents(
      await POST(chatRequest(undefined, { signal: controller.signal })),
    );
    expect(events).toEqual([]);
  });

  it("drops events emitted after the caller aborted", async () => {
    const controller = new AbortController();
    runWorkflowMock.mockImplementation(async (_input, context) => {
      context.emit({ type: "token", text: "before" });
      controller.abort();
      context.emit({ type: "token", text: "after" });
    });
    const events = await readEvents(
      await POST(chatRequest(undefined, { signal: controller.signal })),
    );
    expect(events).toEqual([{ type: "token", text: "before" }]);
  });

  it("hands the workflow the caller's own abort signal", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null = null;
    runWorkflowMock.mockImplementation(async (_input, context) => {
      seen = context.signal;
    });
    await (
      await POST(chatRequest(undefined, { signal: controller.signal }))
    ).text();
    expect(seen).not.toBeNull();
    controller.abort();
    expect(seen!.aborted).toBe(true);
  });
});
