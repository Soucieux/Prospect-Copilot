import { describe, expect, it } from "vitest";
import { emitAgentProgress } from "@/lib/agent/progress";
import { RUNTIME_LABEL_DEFAULTS } from "@/lib/localization";
import type { ChatEvent } from "@/lib/agent/schemas";

describe("emitAgentProgress", () => {
  it("formats the detail line from the matching template", () => {
    const events: ChatEvent[] = [];
    emitAgentProgress(
      (event) => events.push(event),
      RUNTIME_LABEL_DEFAULTS,
      "Company Research",
      "running",
    );
    expect(events[0]).toEqual({
      type: "agent",
      agent: "Company Research",
      detail: "Company Research: running",
      status: "running",
    });
  });

  it("includes a score only when one is given", () => {
    const events: ChatEvent[] = [];
    const emit = (event: ChatEvent): number => events.push(event);
    emitAgentProgress(emit, RUNTIME_LABEL_DEFAULTS, "a", "done", 82);
    emitAgentProgress(emit, RUNTIME_LABEL_DEFAULTS, "b", "failed");
    expect(events[0]).toMatchObject({ status: "done", score: 82 });
    expect(events[1]).not.toHaveProperty("score");
  });

  it("uses the translated template for each status", () => {
    const events: ChatEvent[] = [];
    emitAgentProgress(
      (event) => events.push(event),
      { ...RUNTIME_LABEL_DEFAULTS, agentFailedTemplate: "{agent}: échec" },
      "Recherche",
      "failed",
    );
    expect(events[0]).toMatchObject({ detail: "Recherche: échec" });
  });
});
