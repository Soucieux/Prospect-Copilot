import { describe, expect, it, vi } from "vitest";
import { resolveRoutedTarget } from "@/lib/workflow/target";
import type { ResolvedRouterResult } from "@/lib/agent/router";
import type { WorkflowRuntimeContext } from "@/lib/workflow/context";
import { RUNTIME_LABEL_DEFAULTS } from "@/lib/localization";

const CONTEXT: WorkflowRuntimeContext = {
  config: {
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    model: "test-model",
  },
  signal: new AbortController().signal,
  emit: () => undefined,
};

/**
 * Build routing with only the fields this helper reads.
 * @param url the routed URL, when the router extracted one
 * @param entity the routed company name, when it did not
 * @returns a complete routing result
 */
function routing(
  url: string | null,
  entity: string | null,
): ResolvedRouterResult {
  return {
    skill: "prospect",
    url,
    entity,
    sellingContext: null,
    matchDirection: "sell",
    matchLocation: null,
    candidates: null,
    language: "English",
    runtimeLabels: RUNTIME_LABEL_DEFAULTS,
  };
}

describe("resolveRoutedTarget", () => {
  it("uses the routed URL without asking the model", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await resolveRoutedTarget(routing("https://acme.example.com", null), CONTEXT),
    ).toBe("https://acme.example.com");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("returns null when neither a URL nor an entity was routed", async () => {
    expect(await resolveRoutedTarget(routing(null, null), CONTEXT)).toBeNull();
  });

  it("resolves an entity through the model when no URL was routed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "https://acme.example.com" } }],
            }),
          ),
      ),
    );
    expect(await resolveRoutedTarget(routing(null, "Acme Corp"), CONTEXT)).toBe(
      "https://acme.example.com/",
    );
    vi.unstubAllGlobals();
  });
});
