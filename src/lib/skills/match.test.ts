import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDiscoveryQuery,
  quickScoreCandidate,
  rankCandidates,
  renderMatchReport,
  resolveCandidates,
  runMatchSkill,
  type CandidateScore,
} from "./match";
import type { LlmConfig } from "@/lib/llm";
import type { SearchConfig } from "@/lib/search/volc-search";

vi.mock("@/lib/extract/fetch-page", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/extract/fetch-page")>();
  return {
    ...actual,
    fetchWithVariants: vi.fn(async (url: string) => ({
      url,
      status: 200,
      html: '<html><head><title>Acme</title><meta property="og:site_name" content="Acme Corp"></head><body>Payroll for growing teams</body></html>',
    })),
  };
});

import { fetchWithVariants } from "@/lib/extract/fetch-page";

const CONFIG: LlmConfig = {
  baseUrl: "https://api.example.com",
  apiKey: "test-key",
  model: "test-model",
};
const SEARCH_CONFIG: SearchConfig = { apiKey: "search-key" };

/** Stub global fetch to route search-API and chat-completions calls separately. */
function stubNetwork(options: {
  searchResults?: { title: string; url: string }[];
  scoreJson?: Record<string, unknown>;
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("global_search")) {
        return new Response(
          JSON.stringify({
            Result: {
              Data: (options.searchResults ?? []).map((r) => ({
                Title: r.title,
                Url: r.url,
              })),
            },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  options.scoreJson ?? {
                    score: 70,
                    summary: "Decent fit.",
                    findings: [],
                    recommendation: "Reach out.",
                  },
                ),
              },
            },
          ],
        }),
      );
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(fetchWithVariants).mockClear();
});

describe("buildDiscoveryQuery", () => {
  it("builds a search query from the selling context", () => {
    const query = buildDiscoveryQuery("payroll software for mid-market companies");
    expect(query).toContain("payroll software for mid-market companies");
  });
});

describe("rankCandidates", () => {
  const make = (name: string, score: number): CandidateScore => ({
    url: `https://${name}.example.com`,
    companyName: name,
    score,
    summary: `${name} summary`,
  });

  it("sorts by score descending", () => {
    const ranked = rankCandidates(
      [make("low", 20), make("high", 90), make("mid", 55)],
      5,
    );
    expect(ranked.map((c) => c.companyName)).toEqual(["high", "mid", "low"]);
  });

  it("truncates to the limit", () => {
    const candidates = [make("a", 10), make("b", 20), make("c", 30)];
    const ranked = rankCandidates(candidates, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((c) => c.companyName)).toEqual(["c", "b"]);
  });

  it("returns fewer than the limit when there aren't enough candidates", () => {
    const ranked = rankCandidates([make("only", 50)], 5);
    expect(ranked).toHaveLength(1);
  });
});

describe("renderMatchReport", () => {
  it("lists ranked candidates with score and a link", () => {
    const { markdown, title } = renderMatchReport(
      "payroll software",
      [
        {
          url: "https://acme.example.com",
          companyName: "Acme Corp",
          score: 82,
          summary: "Strong fit: growing headcount and no existing payroll vendor.",
        },
      ],
      1,
    );
    expect(markdown).toContain("Acme Corp");
    expect(markdown).toContain("82");
    expect(markdown).toContain("https://acme.example.com");
    expect(markdown).toContain(
      "Strong fit: growing headcount and no existing payroll vendor.",
    );
    expect(title.length).toBeGreaterThan(0);
  });

  it("notes when candidates were dropped from a larger pool", () => {
    const { markdown } = renderMatchReport(
      "payroll software",
      [
        {
          url: "https://acme.example.com",
          companyName: "Acme Corp",
          score: 82,
          summary: "Good fit.",
        },
      ],
      5,
    );
    expect(markdown).toMatch(/5/);
  });

  it("renders a clear message when no candidates could be scored", () => {
    const { markdown } = renderMatchReport("payroll software", [], 0);
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).not.toContain("undefined");
  });
});

describe("resolveCandidates", () => {
  it("uses supplied URLs as-is without searching", async () => {
    stubNetwork({});
    const urls = await resolveCandidates(
      null,
      ["https://acme.example.com"],
      "payroll software",
    );
    expect(urls).toEqual(["https://acme.example.com/"]);
  });

  it("resolves a supplied company name via search", async () => {
    stubNetwork({
      searchResults: [{ title: "Acme", url: "https://acme.example.com" }],
    });
    const urls = await resolveCandidates(SEARCH_CONFIG, ["Acme Corp"], "payroll software");
    expect(urls).toEqual(["https://acme.example.com"]);
  });

  it("filters out non-company domains in discovery mode", async () => {
    stubNetwork({
      searchResults: [
        { title: "Acme", url: "https://acme.example.com" },
        { title: "Acme on LinkedIn", url: "https://linkedin.com/company/acme" },
      ],
    });
    const urls = await resolveCandidates(SEARCH_CONFIG, null, "payroll software");
    expect(urls).toEqual(["https://acme.example.com"]);
  });

  it("returns an empty list for discovery mode with no search config", async () => {
    const urls = await resolveCandidates(null, null, "payroll software");
    expect(urls).toEqual([]);
  });
});

describe("quickScoreCandidate", () => {
  it("scores a candidate from its homepage", async () => {
    stubNetwork({
      scoreJson: {
        score: 82,
        summary: "Strong fit.",
        findings: [],
        recommendation: "Reach out.",
      },
    });
    const result = await quickScoreCandidate(
      CONFIG,
      "payroll software",
      "https://acme.example.com",
    );
    expect(result).not.toBeNull();
    expect(result?.score).toBe(82);
    expect(result?.companyName).toBe("Acme Corp");
  });

  it("returns null when the candidate can't be fetched", async () => {
    stubNetwork({});
    vi.mocked(fetchWithVariants).mockRejectedValueOnce(new Error("unreachable"));
    const result = await quickScoreCandidate(
      CONFIG,
      "payroll software",
      "https://unreachable.example.com",
    );
    expect(result).toBeNull();
  });

  it("does not drop other candidates when one fails", async () => {
    stubNetwork({
      scoreJson: {
        score: 60,
        summary: "Fine.",
        findings: [],
        recommendation: "Consider.",
      },
    });
    vi.mocked(fetchWithVariants).mockRejectedValueOnce(new Error("unreachable"));
    const results = await Promise.all([
      quickScoreCandidate(CONFIG, "payroll software", "https://bad.example.com"),
      quickScoreCandidate(CONFIG, "payroll software", "https://good.example.com"),
    ]);
    expect(results[0]).toBeNull();
    expect(results[1]?.score).toBe(60);
  });
});

describe("runMatchSkill", () => {
  it("scores and ranks a user-supplied candidate list", async () => {
    stubNetwork({
      scoreJson: {
        score: 75,
        summary: "Good fit.",
        findings: [],
        recommendation: "Reach out.",
      },
    });
    const events: unknown[] = [];
    const { markdown, title } = await runMatchSkill(
      CONFIG,
      "payroll software",
      ["https://acme.example.com", "https://globex.example.com"],
      (event) => events.push(event),
      null,
    );
    expect(markdown).toContain("Acme Corp");
    expect(markdown).toContain("75");
    expect(title.length).toBeGreaterThan(0);
    const agentEvents = events.filter(
      (e): e is { type: string; status: string } =>
        typeof e === "object" && e !== null && (e as { type?: string }).type === "agent",
    );
    const doneEvents = agentEvents.filter((e) => e.status === "done");
    expect(agentEvents).toHaveLength(4); // running + done per candidate
    expect(doneEvents).toHaveLength(2);
  });

  it("discovers and scores candidates via web search when none are named", async () => {
    stubNetwork({
      searchResults: [
        { title: "Acme", url: "https://acme.example.com" },
        { title: "Globex", url: "https://globex.example.com" },
      ],
      scoreJson: {
        score: 60,
        summary: "Decent fit.",
        findings: [],
        recommendation: "Consider.",
      },
    });
    const { markdown } = await runMatchSkill(
      CONFIG,
      "payroll software",
      null,
      () => {},
      SEARCH_CONFIG,
    );
    expect(markdown).toContain("Acme Corp");
    expect(markdown).toContain("60");
  });

  it("renders a no-candidates report instead of throwing when nothing resolves", async () => {
    const { markdown } = await runMatchSkill(
      CONFIG,
      "payroll software",
      null,
      () => {},
      null,
    );
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).not.toContain("undefined");
  });
});
