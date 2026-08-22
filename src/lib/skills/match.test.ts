import { afterEach, describe, expect, it, vi } from "vitest";
import {
  quickScoreCandidate,
  rankCandidates,
  renderMatchReport,
  resolveCandidates,
  runMatchSkill,
  type CandidateScore,
} from "./match";
import type { LlmConfig } from "@/lib/llm";

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

const DEFAULT_SCORE_JSON = {
  score: 70,
  description: "Sells payroll and HR software to mid-market companies.",
  fitReason: "Decent fit for the described offering.",
};

/**
 * Stub the single chat-completions endpoint, branching the canned response
 * by which system prompt the call used (quick-score, candidate suggestion,
 * or name-to-URL resolution) since all three now hit the same LLM.
 */
function stubNetwork(options: {
  suggestJson?: Record<string, unknown>;
  urlGuess?: string;
  scoreJson?: Record<string, unknown>;
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as {
            messages?: { content?: string }[];
          })
        : {};
      const systemContent = body.messages?.[0]?.content ?? "";
      const content = systemContent.includes("discover real companies")
        ? JSON.stringify(options.suggestJson ?? { candidates: [] })
        : systemContent.includes("resolve a company or person's name")
          ? (options.urlGuess ?? "unknown")
          : JSON.stringify(options.scoreJson ?? DEFAULT_SCORE_JSON);
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
      );
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(fetchWithVariants).mockClear();
});

describe("rankCandidates", () => {
  const make = (name: string, score: number): CandidateScore => ({
    url: `https://${name}.example.com`,
    companyName: name,
    score,
    description: `${name} description`,
    fitReason: `${name} fit`,
    location: null,
    founded: null,
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
  const acme: CandidateScore = {
    url: "https://acme.example.com",
    companyName: "Acme Corp",
    score: 82,
    description: "Acme Corp sells arts and crafts supplies online.",
    fitReason: "Strong fit: growing headcount and no existing payroll vendor.",
    location: "San Francisco, CA",
    founded: "1998",
  };

  it("lists ranked candidates with score, description, location, and founded", () => {
    const { markdown, title, matches } = renderMatchReport(
      "payroll software",
      [acme],
      1,
    );
    expect(markdown).toContain("Acme Corp");
    expect(markdown).toContain("82");
    expect(markdown).toContain("https://acme.example.com");
    expect(markdown).toContain("Acme Corp sells arts and crafts supplies online.");
    expect(markdown).toContain(
      "Strong fit: growing headcount and no existing payroll vendor.",
    );
    expect(markdown).toContain("San Francisco, CA");
    expect(markdown).toContain("1998");
    expect(matches).toEqual([acme]);
    expect(title.length).toBeGreaterThan(0);
  });

  it("omits the location/founded line when neither is known", () => {
    const { markdown } = renderMatchReport(
      "payroll software",
      [{ ...acme, location: null, founded: null }],
      1,
    );
    expect(markdown).not.toContain("Not publicly available");
  });

  it("notes when candidates were dropped from a larger pool", () => {
    const { markdown } = renderMatchReport("payroll software", [acme], 5);
    expect(markdown).toMatch(/5/);
  });

  it("renders a clear message when no candidates could be scored", () => {
    const { markdown, matches } = renderMatchReport("payroll software", [], 0);
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).not.toContain("undefined");
    expect(matches).toEqual([]);
  });
});

describe("resolveCandidates", () => {
  it("uses supplied URLs as-is without any LLM call", async () => {
    stubNetwork({});
    const urls = await resolveCandidates(
      CONFIG,
      ["https://acme.example.com"],
      "payroll software",
    );
    expect(urls).toEqual(["https://acme.example.com/"]);
  });

  it("resolves a supplied company name via an LLM guess", async () => {
    stubNetwork({ urlGuess: "https://acme.example.com" });
    const urls = await resolveCandidates(CONFIG, ["Acme Corp"], "payroll software");
    expect(urls).toEqual(["https://acme.example.com/"]);
  });

  it("drops a guessed URL that isn't a real company site", async () => {
    stubNetwork({ urlGuess: "https://linkedin.com/company/acme" });
    const urls = await resolveCandidates(CONFIG, ["Acme Corp"], "payroll software");
    expect(urls).toEqual([]);
  });

  it("returns an empty list when there is nothing to work with", async () => {
    const urls = await resolveCandidates(CONFIG, null, null);
    expect(urls).toEqual([]);
  });

  it("asks the LLM to suggest candidates in discovery mode and resolves each", async () => {
    stubNetwork({
      suggestJson: {
        candidates: [
          { name: "Acme Corp", url: "https://acme.example.com" },
          { name: "Globex Inc", url: null },
        ],
      },
      urlGuess: "https://globex.example.com",
    });
    const urls = await resolveCandidates(CONFIG, null, "payroll software");
    expect(urls).toEqual([
      "https://acme.example.com/",
      "https://globex.example.com/",
    ]);
  });
});

describe("quickScoreCandidate", () => {
  it("scores a candidate and fills description/fitReason from the LLM", async () => {
    stubNetwork({
      scoreJson: {
        score: 82,
        description: "Acme Corp is a payroll software vendor.",
        fitReason: "Strong fit for the described offering.",
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
    expect(result?.description).toBe("Acme Corp is a payroll software vendor.");
    expect(result?.fitReason).toBe("Strong fit for the described offering.");
  });

  it("fills location and founded from the page's own structured data", async () => {
    vi.mocked(fetchWithVariants).mockResolvedValueOnce({
      url: "https://acme.example.com",
      status: 200,
      html: `<html><head><title>Acme</title>
<script type="application/ld+json">{"@type":"Organization","name":"Acme Corp","foundingDate":"1998","address":"San Francisco, CA"}</script>
</head><body>Payroll for growing teams</body></html>`,
    });
    stubNetwork({});
    const result = await quickScoreCandidate(
      CONFIG,
      "payroll software",
      "https://acme.example.com",
    );
    expect(result?.location).toBe("San Francisco, CA");
    expect(result?.founded).toBe("1998");
  });

  it("leaves location and founded null when the page has no structured data", async () => {
    stubNetwork({});
    const result = await quickScoreCandidate(
      CONFIG,
      "payroll software",
      "https://acme.example.com",
    );
    expect(result?.location).toBeNull();
    expect(result?.founded).toBeNull();
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
        description: "A candidate company.",
        fitReason: "Fine.",
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
        description: "A payroll and HR software vendor.",
        fitReason: "Good fit.",
      },
    });
    const events: unknown[] = [];
    const { markdown, title, matches } = await runMatchSkill(
      CONFIG,
      "payroll software",
      ["https://acme.example.com", "https://globex.example.com"],
      (event) => events.push(event),
    );
    expect(markdown).toContain("Acme Corp");
    expect(markdown).toContain("75");
    expect(title.length).toBeGreaterThan(0);
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.score === 75)).toBe(true);
    const agentEvents = events.filter(
      (e): e is { type: string; status: string } =>
        typeof e === "object" && e !== null && (e as { type?: string }).type === "agent",
    );
    const doneEvents = agentEvents.filter((e) => e.status === "done");
    expect(agentEvents).toHaveLength(4); // running + done per candidate
    expect(doneEvents).toHaveLength(2);
  });

  it("suggests and scores candidates via the LLM when none are named", async () => {
    stubNetwork({
      suggestJson: {
        candidates: [
          { name: "Acme Corp", url: "https://acme.example.com" },
          { name: "Globex Inc", url: "https://globex.example.com" },
        ],
      },
      scoreJson: {
        score: 60,
        description: "A payroll and HR software vendor.",
        fitReason: "Decent fit.",
      },
    });
    const { markdown } = await runMatchSkill(
      CONFIG,
      "payroll software",
      null,
      () => {},
    );
    expect(markdown).toContain("Acme Corp");
    expect(markdown).toContain("60");
  });

  it("renders a no-candidates report instead of throwing when nothing resolves", async () => {
    stubNetwork({ suggestJson: { candidates: [] } });
    const { markdown } = await runMatchSkill(
      CONFIG,
      "payroll software",
      null,
      () => {},
    );
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).not.toContain("undefined");
  });
});
