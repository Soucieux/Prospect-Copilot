/**
 * Volcengine web search (联网搜索) client.
 * POST https://open.feedcoopapi.com/search_api/global_search with a Bearer
 * key. BYOK: the key arrives per request and is never persisted server-side.
 */

import { z } from "zod";
import { SEARCH_API_URL } from "@/lib/constants";

export interface SearchConfig {
  apiKey: string;
}

export interface SearchResult {
  title: string;
  url: string;
  /** Best available text: summary when present, else snippet. */
  summary: string;
  siteName: string | null;
  publishTime: string | null;
}

export class SearchError extends Error {}

const SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_RESULT_COUNT = 5;

/**
 * One result item. The Volcengine response uses PascalCase fields and may
 * carry either Summary or Snippet depending on the request - accept both.
 */
const RESULT_ITEM_SCHEMA = z
  .object({
    Title: z.string().optional(),
    Url: z.string().optional(),
    Summary: z.string().optional(),
    Snippet: z.string().optional(),
    SiteName: z.string().optional(),
    PublishTime: z.string().optional(),
  })
  .passthrough();

const RESPONSE_SCHEMA = z
  .object({
    Result: z
      .object({
        Data: z.array(RESULT_ITEM_SCHEMA).optional(),
      })
      .optional(),
    ResponseMetadata: z
      .object({
        Error: z
          .object({ Message: z.string().optional() })
          .nullable()
          .optional(),
      })
      .optional(),
  })
  .passthrough();

/**
 * Run one web search.
 * @param config search credentials
 * @param query the search query
 * @param count max results (default 5)
 * @returns normalized results, empty array when nothing matched
 * @throws SearchError on HTTP, API, or contract failures
 */
export async function searchWeb(
  config: SearchConfig,
  query: string,
  count: number = DEFAULT_RESULT_COUNT,
): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(SEARCH_API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        Query: query,
        SearchType: "web",
        Count: count,
        NeedSummary: true,
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new SearchError(
        `Search API failed (${response.status}): ${text.slice(0, 300)}`,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new SearchError("Search API returned non-JSON response");
    }
    const parsed = RESPONSE_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      throw new SearchError(
        `Search API response shape mismatch: ${text.slice(0, 300)}`,
      );
    }
    const apiError = parsed.data.ResponseMetadata?.Error;
    if (apiError?.Message) {
      throw new SearchError(`Search API error: ${apiError.Message}`);
    }
    return (parsed.data.Result?.Data ?? [])
      .filter((item) => item.Title && item.Url)
      .map((item) => ({
        title: item.Title as string,
        url: item.Url as string,
        summary: item.Summary ?? item.Snippet ?? "",
        siteName: item.SiteName ?? null,
        publishTime: item.PublishTime ?? null,
      }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gather third-party signals for a company: funding and news queries.
 * Failures degrade to an empty list - search must never break a run.
 * @param config search credentials
 * @param companyName the prospect's name
 * @returns up to 10 third-party results
 */
export async function searchCompanySignals(
  config: SearchConfig,
  companyName: string,
): Promise<SearchResult[]> {
  const queries = [`${companyName} funding round`, `${companyName} news`];
  const settled = await Promise.allSettled(
    queries.map((query) => searchWeb(config, query)),
  );
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    for (const item of outcome.value) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      results.push(item);
    }
  }
  return results;
}

/**
 * Render search results as a briefing block for LLM grounding.
 * @param results third-party search results
 * @returns markdown lines, or an empty string when there are none
 */
export function formatSignalsBriefing(results: SearchResult[]): string {
  if (results.length === 0) return "";
  const lines = results.map(
    (item) =>
      `- ${item.title} (${item.siteName ?? "unknown site"}${item.publishTime ? `, ${item.publishTime}` : ""}) - ${item.summary}\n  Source: ${item.url}`,
  );
  return `\nThird-party web signals (cite the Source URL when you use one):\n${lines.join("\n")}`;
}
