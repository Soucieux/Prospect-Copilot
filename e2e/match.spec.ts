import { expect, test } from "@playwright/test";
import {
  MATCH_REPORT,
  PROSPECT_REPORT,
  seedApiKey,
  sendMessage,
  stubChat,
} from "./support/harness";

test("ranks match candidates as cards in score order", async ({ page }) => {
  await seedApiKey(page);
  await stubChat(page, [{ type: "report", report: MATCH_REPORT }]);
  await page.goto("/");
  await sendMessage(page, "we sell payroll software");

  const cards = page.locator(".match-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Northwind Trading");
  await expect(cards.first().locator(".match-card-score")).toHaveText("88/100");
  await expect(cards.first().locator(".match-card-meta")).toContainText(
    "Founded 1998",
  );
  await expect(cards.nth(1)).toContainText("Initech");
});

test("omits the meta row for a candidate with no location or founding date", async ({
  page,
}) => {
  await seedApiKey(page);
  await stubChat(page, [{ type: "report", report: MATCH_REPORT }]);
  await page.goto("/");
  await sendMessage(page, "we sell payroll software");

  await expect(
    page.locator(".match-card").nth(1).locator(".match-card-meta"),
  ).toHaveCount(0);
});

test("turns a candidate card into a follow-up audit request", async ({
  page,
}) => {
  await seedApiKey(page);
  await stubChat(page, [{ type: "report", report: MATCH_REPORT }]);
  await page.goto("/");
  await sendMessage(page, "we sell payroll software");

  const sent: string[] = [];
  await page.route("**/api/chat", async (route) => {
    sent.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: `data: ${JSON.stringify({ type: "report", report: PROSPECT_REPORT })}\n\n`,
    });
  });

  await page.locator(".match-card").first().getByRole("button").click();

  await expect(page.locator(".scorecard").last()).toContainText("Acme Corp");
  expect(sent.join("")).toContain("https://northwind.example.com");
});
