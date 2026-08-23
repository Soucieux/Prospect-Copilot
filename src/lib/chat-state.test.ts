import { describe, expect, it } from "vitest";
import type { ChatMessage, ReportState } from "@/lib/chat-types";
import {
  replaceMessageSnapshot,
  updateLastMessageSnapshot,
  type MessageSnapshot,
} from "@/lib/chat-state";

describe("message snapshots", () => {
  it("publishes completed match cards synchronously for persistence", () => {
    const snapshot: MessageSnapshot = { current: [] };
    replaceMessageSnapshot(snapshot, [
      { role: "user", content: "we sell toys" },
      { role: "assistant", content: "", progress: [] },
    ]);
    const report: ReportState = {
      kind: "match",
      companyName: "Toy prospect matches",
      url: null,
      score: null,
      grade: null,
      confidence: null,
      categories: null,
      matches: [
        {
          url: "https://example.com/",
          companyName: "Example Industries, Inc.",
          score: 72,
          description: "A candidate company.",
          fitReason: "A plausible fit.",
          location: null,
          founded: null,
        },
      ],
      matchLabels: {
        founded: "Founded",
        fit: "Fit",
        auditHint: "Run full audit",
        auditRequestTemplate: "Analyze {url} as a prospect",
      },
      scoreLabels: {
        grade: "Grade",
        confidence: "Confidence",
        confidenceValue: "",
        report: "Match report",
      },
      markdown: "# Toy prospect matches",
    };

    const rendered = updateLastMessageSnapshot(snapshot, (message) => ({
      ...message,
      report,
    }));
    const persisted = structuredClone(snapshot.current) as ChatMessage[];

    expect(rendered).toBe(snapshot.current);
    expect(persisted[1].report?.matches?.[0].companyName).toBe(
      "Example Industries, Inc.",
    );
  });
});
