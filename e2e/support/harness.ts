import { expect, type Page } from "@playwright/test";
import {
  ACTIVE_CONVERSATION_STORAGE_KEY as ACTIVE_CONVERSATION_KEY,
  API_KEY_STORAGE_KEY as API_KEY_KEY,
  SETTINGS_STORAGE_KEY as SETTINGS_KEY,
} from "@/lib/constants";

export { ACTIVE_CONVERSATION_KEY, API_KEY_KEY, SETTINGS_KEY };

/** Placeholder credential; no spec ever reaches a real provider. */
export const API_KEY = "sk-e2e-test-key";

/** One SSE frame as the page's reader expects to receive it. */
export type ChatFrame = Record<string, unknown>;

/**
 * Serve one canned SSE stream for /api/chat so no provider is contacted.
 * @param page the page to intercept on
 * @param frames event objects to deliver, in order
 */
export async function stubChat(
  page: Page,
  frames: ChatFrame[],
): Promise<void> {
  await page.route("**/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    });
  });
}

/**
 * Serve a stream that stays open until the returned release function runs,
 * so a spec can observe the page while a request is still in flight.
 * @param page the page to intercept on
 * @param frames event objects delivered before the stream parks
 * @returns a function that closes the parked stream
 */
export async function stubHangingChat(
  page: Page,
  frames: ChatFrame[],
): Promise<() => void> {
  let release = (): void => {};
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/chat", async (route) => {
    await parked;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    });
  });
  return () => release();
}

/**
 * Put an API key in place before the page loads so the composer will send.
 * @param page the page to seed
 */
export async function seedApiKey(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [API_KEY_KEY, API_KEY] as const,
  );
}

/**
 * Type a message and send it.
 * @param page the page to drive
 * @param text the message to send
 */
export async function sendMessage(page: Page, text: string): Promise<void> {
  await page.locator("input.chat-input").fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

/**
 * Run one complete exchange and wait for the composer to accept input again,
 * which is the page's own signal that the stream closed and was persisted.
 * @param page the page to drive
 * @param text the message to send
 */
export async function completeExchange(page: Page, text: string): Promise<void> {
  await sendMessage(page, text);
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeVisible();
}

/** A minimal prospect report payload for stubbing the report event. */
export const PROSPECT_REPORT = {
  kind: "prospect",
  companyName: "Acme Corp",
  url: "https://acme.example.com",
  score: 72,
  grade: "B",
  confidence: "High",
  categories: [{ category: "Company Fit", score: 80, weight: 0.25 }],
  matches: null,
  matchLabels: null,
  scoreLabels: {
    grade: "Grade",
    confidence: "confidence",
    confidenceValue: "High",
    report: "prospect report",
  },
  markdown: "# Acme Corp\n\nA strong prospect.",
} as const;

/** A minimal match report payload carrying two ranked candidates. */
export const MATCH_REPORT = {
  kind: "match",
  companyName: "payroll software",
  url: null,
  score: null,
  grade: null,
  confidence: null,
  categories: null,
  matches: [
    {
      url: "https://northwind.example.com",
      companyName: "Northwind Trading",
      score: 88,
      description: "Mid-market distributor with 400 staff.",
      fitReason: "Headcount sits in the target band.",
      location: "Leeds, UK",
      founded: "1998",
    },
    {
      url: "https://initech.example.com",
      companyName: "Initech",
      score: 61,
      description: "Software firm with a small back office.",
      fitReason: "Below the target headcount band.",
      location: null,
      founded: null,
    },
  ],
  matchLabels: {
    founded: "Founded",
    fit: "Fit",
    auditHint: "Click for a full prospect audit →",
    auditRequestTemplate: "Analyze {url} as a prospect",
  },
  scoreLabels: {
    grade: "Grade",
    confidence: "confidence",
    confidenceValue: "High",
    report: "match report",
  },
  markdown: "# Best-fit companies\n\nTwo candidates ranked.",
} as const;
