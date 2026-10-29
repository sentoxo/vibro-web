// Shared UI helpers: the two top-bar panels (controls drawer, ESC settings).

import type { Page } from "@playwright/test";

/**
 * Open the controls drawer (source, analysis, export, ESC control). The header
 * gear is the FETtec ESC settings window, so the drawer opens from the panel
 * icon beside it.
 */
export async function openControls(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open controls panel", exact: true }).click();
}

/** Open the centered FETtec ESC settings window (header gear). */
export async function openEscSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "ESC settings", exact: true }).click();
}
