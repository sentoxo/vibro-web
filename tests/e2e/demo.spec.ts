// Landing page + demo mode: autoplay stream, charts, burst mode, snapshot parity.

import { expect, test } from "@playwright/test";

test.describe("landing and demo", () => {
  test("autoplays the landing demo with six live charts and hero stats", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "VIBRO" })).toBeVisible();
    await expect(page.getByText("Demo data — not a real device").first()).toBeVisible();

    await expect(page.locator("canvas")).toHaveCount(6);

    await expect
      .poll(() => page.evaluate(() => (window as any).__store.rms.value.current), { timeout: 10_000 })
      .toBeGreaterThan(0.1);
    await expect(page.getByLabel("Vibration statistics")).toContainText("avg");
    await expect(page.getByLabel("Vibration statistics")).toContainText("min");
    await expect(page.getByLabel("Vibration statistics")).toContainText("max");

    await expect(page.getByLabel("Dominant FFT peaks")).toBeVisible();
  });

  test("burst mode: four demo bursts, selectable, with peak cards", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Explore demo" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("group", { name: "Source mode" }).getByRole("button", { name: "Bursts" }).click();

    const burstSelect = page.getByLabel("Select burst");
    await expect(burstSelect.locator("option")).toHaveCount(4);
    await burstSelect.selectOption("1");

    await expect(page.getByLabel("Vibration statistics")).toContainText("Burst RMS");
    await expect(page.getByLabel("Dominant FFT peaks")).toBeVisible();

    // Desktop parity: a demo burst snapshot always reports the 2 s shortfall.
    await page.getByRole("button", { name: "Save snapshot" }).click();
    await expect(page.getByText("Waiting for 2 seconds of data (0.0 seconds available)").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("about dialog opens and closes", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("About Vibro").click();
    await expect(page.getByRole("dialog", { name: "About Vibro" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "About Vibro" })).toHaveCount(0);
  });
});
