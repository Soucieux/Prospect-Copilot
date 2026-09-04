import { afterEach, describe, expect, it, vi } from "vitest";
import { runStandaloneSkill } from "@/lib/skills/standalone";
import { RUNTIME_LABEL_DEFAULTS } from "@/lib/localization";
import type { ChatEvent } from "@/lib/agent/schemas";
import type { LlmConfig } from "@/lib/llm";

vi.mock("@/lib/extract/fetch-page", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/extract/fetch-page")>();
  return {
    ...actual,
    fetchWithVariants: vi.fn(async (url: string) => ({
      url,
      status: 200,
      html: `<html><head><title>Acme</title>
<meta property="og:site_name" content="Acme Corp">
<script type="application/ld+json">{"@type":"Organization","name":"Acme Corp","numberOfEmployees":120}</script>
</head><body><a href="/pricing">Pricing</a>
<div><h3>Jane Doe</h3><p>Chief Executive Officer</p></div></body></html>`,
    })),
  };
});

import { fetchWithVariants } from "@/lib/extract/fetch-page";

const CONFIG: LlmConfig = {
  baseUrl: "https://api.example.com",
  apiKey: "test-key",
  model: "test-model",
};

/**
 * Stub the provider with one streamed reply.
 * @param text the assistant text to stream back
 */
function stubStream(text: string): void {
  const payload = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(payload)));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(fetchWithVariants).mockClear();
});

/**
 * Read the grounding briefing the skill sent to the provider.
 * @returns the user message carrying the discovery briefing
 */
function groundingSentToProvider(): string {
  const body = JSON.parse(
    String(vi.mocked(fetch).mock.calls[0]?.[1]?.body),
  ) as { messages: { content: string }[] };
  return body.messages[1].content;
}

/**
 * Serve one page for the next fetch instead of the shared rich fixture.
 * @param html the page body to return
 * @param url the URL the fetch resolves to
 */
function servePage(html: string, url = "https://sparse.example.com"): void {
  vi.mocked(fetchWithVariants).mockResolvedValueOnce({
    url,
    status: 200,
    html,
  });
}

describe("runStandaloneSkill", () => {
  it("grounds a research deliverable in the fetched page", async () => {
    stubStream("# Research");
    const events: ChatEvent[] = [];
    const { markdown, title } = await runStandaloneSkill(
      CONFIG,
      "research",
      "https://acme.example.com",
      null,
      (event) => events.push(event),
    );
    expect(title).toBe("Acme Corp");
    expect(markdown).toContain("# Research");
    const body = JSON.parse(
      String(vi.mocked(fetch).mock.calls[0]?.[1]?.body),
    ) as { messages: { content: string }[] };
    expect(body.messages[1].content).toContain("Acme Corp");
    expect(body.messages[1].content).toContain("Jane Doe");
  });

  it("appends the selling-context nudge to research only when none was given", async () => {
    stubStream("# Research");
    const withoutContext = await runStandaloneSkill(
      CONFIG,
      "research",
      "https://acme.example.com",
      null,
      () => {},
    );
    expect(withoutContext.markdown).toContain(
      RUNTIME_LABEL_DEFAULTS.researchNudge,
    );

    stubStream("# Research");
    const withContext = await runStandaloneSkill(
      CONFIG,
      "research",
      "https://acme.example.com",
      null,
      () => {},
      "payroll software",
    );
    expect(withContext.markdown).not.toContain(
      RUNTIME_LABEL_DEFAULTS.researchNudge,
    );
  });

  it("includes a deterministic BANT pre-score only for qualify", async () => {
    stubStream("# Qualification");
    await runStandaloneSkill(
      CONFIG,
      "qualify",
      "https://acme.example.com",
      null,
      () => {},
    );
    const qualifyBody = JSON.parse(
      String(vi.mocked(fetch).mock.calls[0]?.[1]?.body),
    ) as { messages: { content: string }[] };
    expect(qualifyBody.messages[1].content).toContain("BANT pre-score");

    stubStream("# Contacts");
    await runStandaloneSkill(
      CONFIG,
      "contacts",
      "https://acme.example.com",
      null,
      () => {},
    );
    const contactsBody = JSON.parse(
      String(vi.mocked(fetch).mock.calls[0]?.[1]?.body),
    ) as { messages: { content: string }[] };
    expect(contactsBody.messages[1].content).not.toContain("BANT pre-score");
  });

  it("skips discovery for outreach and works from the entity name", async () => {
    stubStream("# Outreach");
    const { title } = await runStandaloneSkill(
      CONFIG,
      "outreach",
      "https://acme.example.com",
      "Acme Analytics",
      () => {},
    );
    expect(fetchWithVariants).not.toHaveBeenCalled();
    expect(title).toBe("Acme Analytics");
  });

  it("emits the localized skill lifecycle", async () => {
    stubStream("# Research");
    const events: ChatEvent[] = [];
    await runStandaloneSkill(
      CONFIG,
      "research",
      "https://acme.example.com",
      null,
      (event) => events.push(event),
    );
    const phases = events
      .filter((event) => event.type === "phase")
      .map((event) => (event as { phase: string }).phase);
    expect(phases).toEqual(["discovery", "analysis", "done"]);
  });

  it("marks every unpublished field rather than sending the model a blank", async () => {
    stubStream("# Research");
    servePage("<html><body><p>We do things.</p></body></html>");
    await runStandaloneSkill(
      CONFIG,
      "research",
      "https://sparse.example.com",
      null,
      () => {},
    );

    const grounding = groundingSentToProvider();
    expect(grounding).toContain("- Company: Not publicly available");
    expect(grounding).toContain("- Title/description: - / -");
    expect(grounding).toContain("- Tech stack: none detected");
    expect(grounding).toContain("- Emails: none found");
    expect(grounding).toContain("- Pricing page: none found");
    expect(grounding).toContain("- Employees (JSON-LD): Not publicly available");
    expect(grounding).not.toMatch(/undefined|null/);
  });

  it("falls back to the page URL when the site never names the company", async () => {
    stubStream("# Research");
    servePage("<html><body><p>We do things.</p></body></html>");
    const { title } = await runStandaloneSkill(
      CONFIG,
      "research",
      "https://sparse.example.com",
      null,
      () => {},
    );
    expect(title).toBe("https://sparse.example.com");
  });

  it("keeps a contact whose title is unpublished and carries their LinkedIn", async () => {
    stubStream("# Contacts");
    servePage(
      `<html><head><script type="application/ld+json">{"@type":"Person","name":"Dana Lee","sameAs":["https://www.linkedin.com/in/danalee"]}</script></head><body><p>Team</p></body></html>`,
    );
    await runStandaloneSkill(
      CONFIG,
      "contacts",
      "https://sparse.example.com",
      null,
      () => {},
    );

    const grounding = groundingSentToProvider();
    expect(grounding).toContain("Dana Lee, title unknown");
    expect(grounding).toContain("https://www.linkedin.com/in/danalee");
  });

  it("rejects an unknown skill name", async () => {
    await expect(
      runStandaloneSkill(
        CONFIG,
        "unknown" as "research",
        null,
        null,
        () => {},
      ),
    ).rejects.toThrow(/Unknown standalone skill/);
  });
});
