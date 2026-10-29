// Settings drawer: controls, persistence across reload, localStorage schema.

import { expect, test } from "@playwright/test";
import { openControls } from "./support/ui";

const KEY = "vibro.settings.v1";

test.describe("settings persistence", () => {
  test("keeps changes across a reload", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Explore demo" }).click();
    await openControls(page);

    await page.getByLabel("IMU Hz").selectOption("3200");
    await page.getByLabel("FFT max").selectOption("1600");
    await page.getByLabel("Auto-reconnect sensor").uncheck();

    await expect
      .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").imuHz, KEY))
      .toBe(3200);

    await page.reload();
    await page.getByRole("button", { name: "Explore demo" }).click();
    await openControls(page);
    await expect(page.getByLabel("IMU Hz")).toHaveValue("3200");
    await expect(page.getByLabel("FFT max")).toHaveValue("1600");
    await expect(page.getByLabel("Auto-reconnect sensor")).not.toBeChecked();
  });

  test("time window toggle switches 2 s / 0.2 s and persists", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Explore demo" }).click();
    await openControls(page);
    const windowButton = page.getByLabel("Time window");
    await expect(windowButton).toContainText("2 s");
    await windowButton.click();
    await expect(windowButton).toContainText("0.2 s");
    await page.reload();
    await page.getByRole("button", { name: "Explore demo" }).click();
    await openControls(page);
    await expect(page.getByLabel("Time window")).toContainText("0.2 s");
  });

  test("corrupt storage falls back to defaults without crashing", async ({ page }) => {
    await page.addInitScript((key) => {
      localStorage.setItem(key, "{not json!!");
    }, KEY);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "VIBRO" })).toBeVisible();
    // The app must treat the corrupt payload as defaults; changing a setting
    // rewrites valid JSON on top of the garbage.
    await page.getByRole("button", { name: "Explore demo" }).click();
    await openControls(page);
    await expect(page.getByLabel("IMU Hz")).toHaveValue("2000");
    await page.getByLabel("IMU Hz").selectOption("800");
    await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").imuHz, KEY)).toBe(800);
  });
});
