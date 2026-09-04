import { expect, test } from "@playwright/test";
import { API_KEY, API_KEY_KEY, SETTINGS_KEY } from "./support/harness";

/**
 * Open the settings dialog and fill every field.
 * @param page the page to drive
 */
async function openAndFillSettings(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.getByRole("button", { name: /Settings/ }).click();
  await page.locator("#setting-api-key").fill(API_KEY);
  await page.locator("#setting-model").fill("deepseek-reasoner");
  await page.getByRole("button", { name: "Done" }).click();
}

test("keeps the API key out of the settings record", async ({ page }) => {
  await page.goto("/");
  await openAndFillSettings(page);

  const stored = await page.evaluate(
    ([settingsKey, keyKey]) => ({
      settings: window.localStorage.getItem(settingsKey),
      apiKey: window.localStorage.getItem(keyKey),
    }),
    [SETTINGS_KEY, API_KEY_KEY] as const,
  );
  expect(stored.apiKey).toBe(API_KEY);
  expect(stored.settings).not.toContain(API_KEY);
  expect(stored.settings).not.toContain("apiKey");
});

test("restores saved settings after a reload instead of clearing them", async ({
  page,
}) => {
  await page.goto("/");
  await openAndFillSettings(page);

  await page.reload();
  await page.getByRole("button", { name: /Settings/ }).click();
  await expect(page.locator("#setting-api-key")).toHaveValue(API_KEY);
  await expect(page.locator("#setting-model")).toHaveValue("deepseek-reasoner");

  const survivingKey = await page.evaluate(
    (keyKey) => window.localStorage.getItem(keyKey),
    API_KEY_KEY,
  );
  expect(survivingKey).toBe(API_KEY);
});

test("does not write any settings record before the user edits one", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
  const stored = await page.evaluate(
    ([settingsKey, keyKey]) => ({
      settings: window.localStorage.getItem(settingsKey),
      apiKey: window.localStorage.getItem(keyKey),
    }),
    [SETTINGS_KEY, API_KEY_KEY] as const,
  );
  expect(stored.settings).toBeNull();
  expect(stored.apiKey).toBeNull();
});

test("hides the API key from view and blocks copying it out", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Settings/ }).click();
  await expect(page.locator("#setting-api-key")).toHaveAttribute(
    "type",
    "password",
  );
});
