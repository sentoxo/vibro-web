// File mode: parse the 6-burst test dataset, select bursts, export a DVB1
// snapshot (validated against the Python parser by scripts/validate_export.py).

import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { openControls } from "./support/ui";

const FIXTURE = fileURLToPath(new URL("../fixtures/test_data.bin", import.meta.url));

test.describe("file mode", () => {
  test("loads all six bursts and exports a valid DVB1 snapshot", async ({ page }) => {
    await page.goto("/");
    await page.locator('input[type="file"]').first().setInputFiles(FIXTURE);

    await expect(page.getByText("File loaded")).toBeVisible({ timeout: 15_000 });

    const bursts = await page.evaluate(() => (window as any).__store.bursts.value.length);
    expect(bursts).toBe(6);

    // Burst selector lists every burst with its sequence.
    await openControls(page);
    const burstSelect = page.getByLabel("Select burst");
    await expect(burstSelect.locator("option")).toHaveCount(6);
    await expect(burstSelect.locator("option").first()).toContainText("Burst 1 (seq");

    await burstSelect.selectOption("5");
    await expect(page.getByLabel("Vibration statistics")).toContainText("Burst RMS");
    await expect(page.getByLabel("Dominant FFT peaks")).toBeVisible();

    // The hero caption for a 6400-sample burst at 3200 Hz = 2 s of data, so
    // the snapshot export (last 2 s) succeeds and downloads a .bin file.
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save snapshot" }).click();
    const file = await download;
    const suggested = file.suggestedFilename();
    expect(suggested).toMatch(/\.bin$/);
    await file.saveAs(fileURLToPath(new URL("../.artifacts/exported.bin", import.meta.url)));
  });

  test("rejects non-DVB1 files with a toast", async ({ page }) => {
    await page.goto("/");
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "junk.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("this is not a DVB1 file at all, not even close"),
      });
    await expect(page.getByText("No bursts found in file")).toBeVisible({ timeout: 10_000 });
  });
});
