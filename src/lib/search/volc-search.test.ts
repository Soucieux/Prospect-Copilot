import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatSignalsBriefing,
  searchCompanySignals,
  searchWeb,
  SearchError,
} from "./volc-search";

const CONFIG = { apiKey: "test-key" };

/** Synthetic Volcengine response payload. */
const SAMPLE_RESPONSE = {
  ResponseMetadata: { RequestId: "req-1", Error: null },
  Result: {
    Data: [
      {
        Title: "Acme raises $10M Series A",
        Url: "https://techcrunch.example/acme",
        Summary: "Acme Analytics closed a $10M round.",
        SiteName: "TechCrunch",
        PublishTime: "2026-08-01",
      },
      {
        Title: "Acme Analytics launches v2",
        Url: "https://acme.example/blog/v2",
        Snippet: "Version 2 of the analytics platform.",
      },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchWeb", () => {
  it("parses the documented response shape into SearchResults", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(SAMPLE_RESPONSE))),
    );
    const results = await searchWeb(CONFIG, "acme analytics");
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Acme raises $10M Series A",
      url: "https://techcrunch.example/acme",
      summary: "Acme Analytics closed a $10M round.",
      siteName: "TechCrunch",
      publishTime: "2026-08-01",
    });
    // Snippet falls back when Summary is absent.
    expect(results[1]?.summary).toBe("Version 2 of the analytics platform.");
    expect(results[1]?.siteName).toBeNull();
  });

  it("sends the documented request contract", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(SAMPLE_RESPONSE)));
    vi.stubGlobal("fetch", spy);
    await searchWeb(CONFIG, "acme analytics", 3);
    const [url, init] = spy.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://open.feedcoopapi.com/search_api/global_search",
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.Query).toBe("acme analytics");
    expect(body.Count).toBe(3);
  });

  it("throws SearchError on HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    await expect(searchWeb(CONFIG, "x")).rejects.toThrow(SearchError);
  });

  it("drops results without a title or URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              Result: { Data: [{ Title: "no url here" }, SAMPLE_RESPONSE.Result.Data[0]] },
            }),
          ),
      ),
    );
    const results = await searchWeb(CONFIG, "x");
    expect(results).toHaveLength(1);
  });
});

describe("searchCompanySignals", () => {
  it("dedupes by URL and survives a failed query", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 2) return new Response("boom", { status: 500 });
        return new Response(JSON.stringify(SAMPLE_RESPONSE));
      }),
    );
    const results = await searchCompanySignals(CONFIG, "Acme Analytics");
    expect(results).toHaveLength(2);
  });
});

describe("formatSignalsBriefing", () => {
  it("renders source URLs for citation", async () => {
    const results = await searchWebWithStub();
    const briefing = formatSignalsBriefing(results);
    expect(briefing).toContain("Source: https://techcrunch.example/acme");
    expect(briefing).toContain("TechCrunch");
  });

  it("returns an empty string for no results", () => {
    expect(formatSignalsBriefing([])).toBe("");
  });
});

/** Helper: searchWeb against the stubbed sample response. */
async function searchWebWithStub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(SAMPLE_RESPONSE))),
  );
  return searchWeb(CONFIG, "acme");
}
