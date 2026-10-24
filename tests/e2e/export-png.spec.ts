// PNG snapshot regression: the exported dashboard must contain drawn curves.
// A previous bug used the obsolete -window..0 x-range for live time charts, so
// the curves were clipped off the right edge (the file was "blank" dark panels).

import { expect, test } from "@playwright/test";

test.describe("dashboard PNG export", () => {
  test("renders time and FFT curves into the snapshot", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__store.rms.value.current), { timeout: 10_000 })
      .toBeGreaterThan(0.1);
    await page.waitForTimeout(1500);

    const result = await page.evaluate(async () => {
      const compose = (window as any).__composeDashboardPng as () => Promise<Blob>;
      const blob = await compose();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);

      // Count cyan (X-axis curve) pixels in a region.
      const countCyan = (x: number, y: number, w: number, h: number): number => {
        const data = ctx.getImageData(x, y, w, h).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] < 90 && data[i + 1] > 170 && data[i + 1] < 245 && data[i + 2] > 200) count += 1;
        }
        return count;
      };

      return {
        width: bitmap.width,
        height: bitmap.height,
        // Left column, first row: live X time chart plot area.
        timeCurve: countCyan(90, 245, 845, 195),
        // Right column, first row: X FFT plot area.
        fftCurve: countCyan(1030, 245, 840, 195),
        bytes: blob.size,
      };
    });

    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.bytes).toBeGreaterThan(20_000);
    expect(result.timeCurve).toBeGreaterThan(200);
    expect(result.fftCurve).toBeGreaterThan(100);
  });
});
