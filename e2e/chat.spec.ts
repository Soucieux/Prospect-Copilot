import { expect, test } from "@playwright/test";
import {
  PROSPECT_REPORT,
  seedApiKey,
  sendMessage,
  stubChat,
  stubHangingChat,
} from "./support/harness";

test("shows the empty state and fills the composer from a suggestion", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
  await page.getByRole("button", { name: /Prospect audit/ }).click();
  await expect(page.locator("input.chat-input")).toHaveValue(
    /analyze https:\/\/stripe\.com/,
  );
});

test("refuses to send without an API key", async ({ page }) => {
  await page.goto("/");
  await sendMessage(page, "hello");
  await expect(page.locator(".error-banner")).toContainText(/API key/i);
});

test("streams assistant tokens into the conversation", async ({ page }) => {
  await seedApiKey(page);
  await stubChat(page, [
    { type: "token", text: "Hel" },
    { type: "token", text: "lo there" },
  ]);
  await page.goto("/");
  await sendMessage(page, "hi");
  await expect(page.locator(".message.assistant")).toContainText("Hello there");
});

test("renders progress and a report scorecard", async ({ page }) => {
  await seedApiKey(page);
  await stubChat(page, [
    { type: "phase", phase: "discovery", detail: "Fetching acme.example.com" },
    { type: "report", report: PROSPECT_REPORT },
  ]);
  await page.goto("/");
  await sendMessage(page, "analyze acme");

  await expect(page.locator(".progress")).toContainText("Fetching");
  await expect(page.locator(".scorecard")).toContainText("Acme Corp");
  await expect(page.locator(".scorecard")).toContainText("72/100");
  await expect(page.locator(".scorecard-row")).toContainText("Company Fit");
});

test("surfaces a server error without leaving the page broken", async ({
  page,
}) => {
  await seedApiKey(page);
  await stubChat(page, [{ type: "error", message: "upstream failed" }]);
  await page.goto("/");
  await sendMessage(page, "analyze acme");
  await expect(page.locator(".error-banner")).toContainText("upstream failed");
  await expect(page.locator("input.chat-input")).toBeEnabled();
});

test("offers a stop control while streaming and recovers after stopping", async ({
  page,
}) => {
  await seedApiKey(page);
  const release = await stubHangingChat(page, [
    { type: "token", text: "too late" },
  ]);
  await page.goto("/");
  await sendMessage(page, "analyze acme");

  const stop = page.getByRole("button", { name: "Stop processing" });
  await expect(stop).toBeVisible();
  await stop.click();

  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeVisible();
  await expect(page.locator("input.chat-input")).toBeEnabled();
  release();
});
