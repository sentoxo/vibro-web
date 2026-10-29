// Landing page + demo mode: autoplay stream, charts, burst mode, snapshot parity.

import { expect, test } from "@playwright/test";
import { openControls } from "./support/ui";

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
    await openControls(page);
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

  test("FFT max only zooms the spectrum; it never moves the peaks", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Explore demo" }).click();
    await openControls(page);

    // Demo axis 0 carries a 48 Hz tone. The FFT runs at the real IMU rate, so
    // the reported peak must stay at ~48 Hz for every "FFT max" setting. The
    // old bug labelled the axis with 2 × fftMaxHz, which scaled the peak.
    const peakNear48 = async () => {
      const hz = await page.evaluate(() => {
        const peaks = (window as any).__store.peaks.value[0];
        return peaks.length > 0 ? peaks[0].frequency : null;
      });
      return hz !== null && Math.abs(hz - 48) < 6;
    };
    await expect.poll(peakNear48, { timeout: 10_000 }).toBe(true);

    const fftMax = page.getByLabel("FFT max");
    for (const hz of ["200", "400", "600", "800", "1000", "1600"]) {
      await fftMax.selectOption(hz);
      await expect.poll(peakNear48, { timeout: 10_000 }).toBe(true);
    }
  });

  test("about dialog opens and closes", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("About Vibro").click();
    await expect(page.getByRole("dialog", { name: "About Vibro" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "About Vibro" })).toHaveCount(0);
  });

  test("freeze/resume lives in the header and toggles pause", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Explore demo" }).click();

    // The old location (chart-grid toolbar) must no longer hold the control.
    const grid = page.locator(".chart-grid-wrap");
    await expect(grid.getByRole("button", { name: "Freeze" })).toHaveCount(0);

    await page.getByRole("button", { name: "Freeze", exact: true }).click();
    expect(await page.evaluate(() => (window as any).__store.paused.value)).toBe(true);
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    expect(await page.evaluate(() => (window as any).__store.paused.value)).toBe(false);
  });
});
