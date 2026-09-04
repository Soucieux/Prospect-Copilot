import { expect, test } from "@playwright/test";
import {
  ACTIVE_CONVERSATION_KEY,
  completeExchange,
  seedApiKey,
  stubChat,
} from "./support/harness";

test("saves an exchange to the sidebar and restores it after a reload", async ({
  page,
}) => {
  await seedApiKey(page);
  await stubChat(page, [{ type: "token", text: "first answer" }]);
  await page.goto("/");
  await completeExchange(page, "first question");

  const entry = page.locator(".conversation-item").first();
  await expect(entry).toContainText("first question");

  const activeId = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    ACTIVE_CONVERSATION_KEY,
  );
  expect(activeId).not.toBeNull();

  await page.reload();
  await expect(page.locator(".message.assistant")).toContainText(
    "first answer",
  );
});

test("switches between two stored conversations", async ({ page }) => {
  await seedApiKey(page);
  await stubChat(page, [{ type: "token", text: "first answer" }]);
  await page.goto("/");
  await completeExchange(page, "first question");
  await expect(page.locator(".conversation-item")).toHaveCount(1);

  await stubChat(page, [{ type: "token", text: "second answer" }]);
  await page.getByRole("button", { name: /New chat/ }).click();
  await completeExchange(page, "second question");
  await expect(page.locator(".conversation-item")).toHaveCount(2);

  await page
    .locator(".conversation-open", { hasText: "first question" })
    .click();
  await expect(page.locator(".message.assistant")).toContainText(
    "first answer",
  );
});

test("deletes a stored conversation and clears the chat log", async ({
  page,
}) => {
  await seedApiKey(page);
  await stubChat(page, [{ type: "token", text: "first answer" }]);
  await page.goto("/");
  await completeExchange(page, "first question");
  await expect(page.locator(".conversation-item")).toHaveCount(1);

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: /^Delete/ }).click();
  await expect(page.locator(".conversation-item")).toHaveCount(0);
  await expect(page.locator(".message.assistant")).toHaveCount(0);
});

test("starts a new chat without discarding the stored one", async ({
  page,
}) => {
  await seedApiKey(page);
  await stubChat(page, [{ type: "token", text: "first answer" }]);
  await page.goto("/");
  await completeExchange(page, "first question");

  await page.getByRole("button", { name: /New chat/ }).click();
  await expect(page.locator(".message.assistant")).toHaveCount(0);
  await expect(page.locator(".conversation-item")).toHaveCount(1);
});
