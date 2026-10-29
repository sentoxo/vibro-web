// FETtec ESC settings window: the header gear opens it on the dashboard and on
// the landing screen, the drawer's FETtec section opens the same window, and the
// fields persist to localStorage.

import { expect, test, type Page } from "@playwright/test";
import { openControls, openEscSettings } from "./support/ui";

const KEY = "vibro.settings.v1";

const dialog = (page: Page) => page.getByRole("dialog", { name: "FETtec ESC settings" });

test("the header gear opens a centered FETtec ESC settings window", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore demo" }).click();
  await openEscSettings(page);

  const modal = dialog(page);
  await expect(modal).toBeVisible();
  await expect(modal.getByLabel("ESC count")).toHaveValue("8");
  await expect(modal.getByLabel("Motor poles")).toHaveValue("12");
  // Auto is the default RPM marker source.
  await expect(modal.getByLabel("RPM source motor")).toHaveValue("0");

  // Centered in the viewport on both axes (it is a window, not a drawer).
  const box = await modal.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(Math.abs(box!.x + box!.width / 2 - viewport!.width / 2)).toBeLessThan(2);
  expect(Math.abs(box!.y + box!.height / 2 - viewport!.height / 2)).toBeLessThan(2);

  // Escape closes it.
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
});

test("FETtec fields persist, and Reset FETtec settings restores the defaults", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore demo" }).click();
  await openEscSettings(page);

  const modal = dialog(page);
  // Preact's delegated onInput can swallow fill(), so type the value.
  const count = modal.getByLabel("ESC count");
  await count.press("Control+a");
  await count.pressSequentially("4", { delay: 30 });
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").fettecEscCount, KEY))
    .toBe(4);

  // The ESC count drives the per-motor options of the RPM source selector.
  await expect(modal.getByLabel("RPM source motor").locator("option")).toHaveCount(4 + 2);

  await modal.getByRole("button", { name: "Reset FETtec settings" }).click();
  await expect(count).toHaveValue("8");
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").fettecEscCount, KEY))
    .toBe(8);

  // Close button.
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(modal).toHaveCount(0);
});

test("the gear works on the landing screen, where the drawer is not mounted", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "VIBRO" })).toBeVisible();
  await openEscSettings(page);
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator(".settings-drawer")).toHaveCount(0);
});

test("the drawer summarises the bus and opens the same window (no duplicate fields)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore demo" }).click();
  await openControls(page);

  await expect(page.locator(".settings-drawer")).toContainText("8 ESC · IDs 1-8 · 12 poles · 2000000 · RPM Auto");
  await page.getByRole("button", { name: "Open FETtec ESC settings" }).click();

  await expect(dialog(page)).toBeVisible();
  // The fields moved out of the drawer: each label resolves to exactly one control.
  await expect(page.getByLabel("ESC count")).toHaveCount(1);
  await expect(page.getByLabel("RPM source motor")).toHaveCount(1);
});
