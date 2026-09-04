import { describe, expect, it } from "vitest";
import { consumeStream } from "./chat-stream";
import type { ChatMessage } from "./chat-types";

/**
 * Build a readable SSE body from already-encoded frames.
 * @param frames event objects to serialize as `data:` frames
 * @returns a stream the reader can consume
 */
function sseBody(frames: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });
}

/**
 * Collect the trailing assistant message the reader patches.
 * @returns the patch callback and a getter for the current message
 */
function collector(): {
  updateLast: (patch: (message: ChatMessage) => ChatMessage) => void;
  current: () => ChatMessage;
} {
  let message: ChatMessage = { role: "assistant", content: "", progress: [] };
  return {
    updateLast: (patch) => {
      message = patch(message);
    },
    current: () => message,
  };
}

const VALID_REPORT = {
  kind: "research",
  companyName: "Acme",
  url: null,
  score: null,
  grade: null,
  confidence: null,
  categories: null,
  matches: null,
  matchLabels: null,
  scoreLabels: {
    grade: "Grade",
    confidence: "confidence",
    confidenceValue: "",
    report: "Report",
  },
  markdown: "# Acme",
};

/**
 * Build a readable body from raw frame text, for frames the encoder would
 * never produce but a server or proxy can still emit.
 * @param chunks raw strings written to the stream verbatim
 * @returns a stream the reader can consume
 */
function rawBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("consumeStream", () => {
  it("accumulates token deltas in arrival order", async () => {
    const sink = collector();
    await consumeStream(
      sseBody([
        { type: "token", text: "Hel" },
        { type: "token", text: "lo" },
      ]),
      sink.updateLast,
    );
    expect(sink.current().content).toBe("Hello");
  });

  it("records phase progress events", async () => {
    const sink = collector();
    await consumeStream(
      sseBody([{ type: "phase", phase: "discovery", detail: "Fetching" }]),
      sink.updateLast,
    );
    expect(sink.current().progress).toEqual([
      { kind: "phase", label: "discovery", detail: "Fetching" },
    ]);
  });

  it("applies a report that satisfies the wire schema", async () => {
    const sink = collector();
    await consumeStream(
      sseBody([{ type: "report", report: VALID_REPORT }]),
      sink.updateLast,
    );
    expect(sink.current().report?.companyName).toBe("Acme");
  });

  it("drops a malformed report instead of rendering it", async () => {
    const sink = collector();
    await consumeStream(
      sseBody([
        { type: "report", report: { ...VALID_REPORT, scoreLabels: null } },
      ]),
      sink.updateLast,
    );
    expect(sink.current().report).toBeUndefined();
  });

  it("ignores a keep-alive comment that is not a data frame", async () => {
    const sink = collector();
    await consumeStream(
      rawBody([": keep-alive\n\n", 'data: {"type":"token","text":"hi"}\n\n']),
      sink.updateLast,
    );
    expect(sink.current().content).toBe("hi");
  });

  it("ignores a data frame whose payload is not valid JSON", async () => {
    const sink = collector();
    await consumeStream(
      rawBody(["data: {oops\n\n", 'data: {"type":"token","text":"hi"}\n\n']),
      sink.updateLast,
    );
    expect(sink.current().content).toBe("hi");
  });

  it("reassembles one event split across two network chunks", async () => {
    const sink = collector();
    await consumeStream(
      rawBody(['data: {"type":"token",', '"text":"split"}\n\n']),
      sink.updateLast,
    );
    expect(sink.current().content).toBe("split");
  });

  it("appends nothing when a token event carries no text", async () => {
    const sink = collector();
    await consumeStream(
      sseBody([{ type: "token" }, { type: "token", text: 7 }]),
      sink.updateLast,
    );
    expect(sink.current().content).toBe("");
  });

  it("records an agent event with its status and score", async () => {
    const sink = collector();
    await consumeStream(
      sseBody([
        {
          type: "agent",
          agent: "Company Research",
          detail: "done",
          status: "done",
          score: 82,
        },
      ]),
      sink.updateLast,
    );
    expect(sink.current().progress).toEqual([
      {
        kind: "agent",
        label: "Company Research",
        detail: "done",
        status: "done",
        score: 82,
      },
    ]);
  });

  it("drops an unrecognized agent status rather than rendering it", async () => {
    const sink = collector();
    await consumeStream(
      sseBody([
        {
          type: "agent",
          agent: "Company Research",
          detail: "?",
          status: "exploded",
          score: "high",
        },
      ]),
      sink.updateLast,
    );
    expect(sink.current().progress?.[0]).toMatchObject({
      status: undefined,
      score: undefined,
    });
  });

  it("ignores an event type the client does not know", async () => {
    const sink = collector();
    await consumeStream(
      sseBody([{ type: "telemetry", value: 1 }]),
      sink.updateLast,
    );
    expect(sink.current().content).toBe("");
    expect(sink.current().progress).toEqual([]);
  });

  it("starts a progress list on a message that has none", async () => {
    let message: ChatMessage = { role: "assistant", content: "" };
    await consumeStream(
      sseBody([{ type: "phase", phase: "discovery", detail: "Fetching" }]),
      (patch) => {
        message = patch(message);
      },
    );
    expect(message.progress).toEqual([
      { kind: "phase", label: "discovery", detail: "Fetching" },
    ]);
  });

  it("starts a progress list for an agent event on a bare message", async () => {
    let message: ChatMessage = { role: "assistant", content: "" };
    await consumeStream(
      sseBody([
        { type: "agent", agent: "Outreach Strategy", detail: "running", status: "running" },
      ]),
      (patch) => {
        message = patch(message);
      },
    );
    expect(message.progress).toEqual([
      {
        kind: "agent",
        label: "Outreach Strategy",
        detail: "running",
        status: "running",
        score: undefined,
      },
    ]);
  });

  it("raises the server's error event to the caller", async () => {
    const sink = collector();
    await expect(
      consumeStream(
        sseBody([{ type: "error", message: "upstream failed" }]),
        sink.updateLast,
      ),
    ).rejects.toThrow(/upstream failed/);
  });
});
