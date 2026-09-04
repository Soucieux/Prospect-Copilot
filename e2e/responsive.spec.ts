import { expect, test } from "@playwright/test";
import { completeExchange, seedApiKey, stubChat } from "./support/harness";

test.use({ viewport: { width: 390, height: 844 } });

test("opens and closes the conversation menu on a phone viewport", async ({
  page,
}) => {
  await seedApiKey(page);
  await stubChat(page, [{ type: "token", text: "first answer" }]);
  await page.goto("/");
  await completeExchange(page, "first question");

  await page.getByRole("button", { name: "Open conversation menu" }).click();
  await expect(page.locator(".sidebar")).toHaveClass(/open/);
  await expect(page.locator(".conversation-item")).toContainText(
    "first question",
  );

  // The backdrop covers the whole viewport, so its centre sits under the
  // 260px sidebar. Click where the overlay is actually visible, as a user does.
  await page
    .getByRole("button", { name: "Close conversation menu" })
    .click({ position: { x: 330, y: 400 } });
  await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
});

test("keeps the composer usable at phone width", async ({ page }) => {
  await page.goto("/");
  const composer = page.locator("input.chat-input");
  await expect(composer).toBeVisible();
  const box = await composer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(150);
  expect(box!.width).toBeLessThanOrEqual(390);
});
