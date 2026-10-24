// Browsers without Web Serial: the live path is disabled, demo/file work.

import { expect, test } from "@playwright/test";

test.describe("without Web Serial", () => {
  test("disables the connect button and keeps the demo usable", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "serial", { get: () => undefined });
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Connect sensor" })).toBeDisabled();
    await expect(page.getByText("Live hardware requires Chrome or Edge")).toBeVisible();

    // Landing demo still runs.
    await expect(page.locator("canvas")).toHaveCount(6, { timeout: 10_000 });
  });
});
