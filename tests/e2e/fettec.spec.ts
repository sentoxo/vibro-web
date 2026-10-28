// FETtec OneWire over Betaflight passthrough, end-to-end against the third
// fake serial port: CLI banner, OneWire scan, fast-throttle echo + telemetry,
// signal-check verdicts, per-motor ramp and the DTR reboot on disconnect.

import { expect, test, type Page } from "@playwright/test";
import { installFakeSerial } from "./support/fake-serial";

async function fettecFrames(page: Page): Promise<{ values: number[]; slot: number }[]> {
  return page.evaluate(() => window.__fakeSerial?.fettecFrames(400) ?? []);
}

async function hasMotorValue(page: Page, motor: number, value: number): Promise<boolean> {
  const frames = await fettecFrames(page);
  return frames.some((frame) => frame.values[motor] === value);
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}

test("FETtec passthrough: scan, signal check, per-motor ramp and DTR reboot", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(installFakeSerial, { simulateLoss: false });
  await page.goto("/");
  await page.getByRole("button", { name: "Explore demo" }).click();
  await openSettings(page);

  // Capture an MSP_ANALOG snapshot first: it is the cross-check source for the
  // ESC voltage/current scale factors.
  await page.evaluate(() => window.__fakeSerial?.setNextPort("fc"));
  await page.getByRole("button", { name: "Connect FC (115200)" }).click();
  await expect(page.locator(".esc-status b")).toHaveText("connected", { timeout: 10_000 });
  await expect
    .poll(() => page.evaluate(() => (window as any).__store.esc.value.mspAnalog?.voltage ?? 0), { timeout: 10_000 })
    .toBeCloseTo(16.8, 5);

  // Switch to passthrough (mutually exclusive with MSP) and connect the bus.
  await page.evaluate(() => window.__fakeSerial?.setNextPort("fettec"));
  await page.getByRole("button", { name: "FETtec passthrough" }).click();
  await page.getByRole("button", { name: "Connect FETtec", exact: true }).click();
  await expect(page.locator(".esc-status b")).toHaveText("connected", { timeout: 25_000 });

  // CLI handshake: '#' then the serialpassthrough line.
  const texts = (await page.evaluate(() => window.__fakeSerial?.lastWrites("fettec") ?? []))
    .map((bytes) => String.fromCharCode(...bytes))
    .join("");
  expect(texts).toContain("#");
  expect(texts).toContain("serialpassthrough esc_sensor 2000000 rxtx reset");

  // All eight IDs answered and the device table is populated.
  await expect(page.locator(".fettec-table tbody tr")).toHaveCount(8);
  await expect(page.locator(".fettec-table tbody tr").first()).toContainText("FETtec ESC 35A");
  await expect(page.locator(".fettec-table tbody tr").first()).toContainText("1.2");
  await expect(page.locator(".fettec-table tbody tr").first()).toContainText("AB01CDEF");

  // Fast-throttle frames are flowing and telemetry is decoding.
  await expect
    .poll(() => page.evaluate(() => (window as any).__store.esc.value.busStats.framesSent), { timeout: 10_000 })
    .toBeGreaterThan(10);
  await expect
    .poll(() => page.evaluate(() => (window as any).__store.esc.value.telemetry[0]?.volt ?? 0), { timeout: 10_000 })
    .toBeCloseTo(16.8, 5);
  await expect(page.locator(".fettec-stats")).toContainText("loop");

  // MSP cross-check: fake MSP says 16.8 V / 21.5 A, ESC telemetry matches.
  await expect(page.locator(".fettec-msp-check")).toContainText("MSP cross-check");
  await expect(page.locator(".fettec-msp-check")).toContainText("match");

  // Signal check: motor 5 answers on the bus but ignores bus throttle (the
  // fake models an ESC fed from the FC pins), the other seven follow OneWire.
  await page.getByRole("button", { name: "Run signal check" }).click();
  const safety = page.getByRole("dialog", { name: "ESC safety warning" });
  await expect(safety).toBeVisible();
  await safety.getByRole("checkbox", { name: /Props are removed/ }).check();
  await safety.getByRole("button", { name: "I understand — enable FETtec control" }).click();

  await expect(page.locator(".fettec-summary")).toContainText("Mixed wiring", { timeout: 30_000 });
  await expect(page.locator(".fettec-summary")).toContainText("7 on OneWire");
  await expect(page.locator(".fettec-summary")).toContainText("1 on FC pins (inferred)");
  await expect(page.locator(".fettec-verdict-fc-pin").first()).toBeVisible();

  // START (the safety acknowledgment from the check carries over).
  await page.getByRole("button", { name: "START", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__store.esc.value.running), { timeout: 5_000 })
    .toBe(true);

  // Motor 1 → 30 % ramps to raw 1300 (1000 + 30×10).
  const motor1 = page.getByLabel("Motor 1 percent");
  await motor1.press("Control+a");
  await motor1.pressSequentially("30", { delay: 30 });
  await motor1.press("Enter");
  await expect.poll(() => hasMotorValue(page, 0, 1300), { timeout: 10_000 }).toBe(true);
  await expect
    .poll(() => page.evaluate(() => (window as any).__store.esc.value.targets[0]), { timeout: 5_000 })
    .toBe(30);

  // Apply-to-all drives every ESC in the next frame.
  await page.getByLabel("Apply percent to all motors").press("Control+a");
  await page.getByLabel("Apply percent to all motors").pressSequentially("20", { delay: 30 });
  await page.getByRole("button", { name: "Apply to all", exact: true }).click();
  await expect
    .poll(
      async () => {
        const frames = await fettecFrames(page);
        return frames.some((frame) => frame.values.every((value) => value === 1200));
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  // Stat hero: the RPM readout in front of the RMS value (same source as the
  // FFT marker lines) shows up once the ESCs spin.
  await expect
    .poll(() => page.evaluate(() => (window as any).__store.motorRpmHz), { timeout: 10_000 })
    .toBeGreaterThan(0);
  await expect(page.locator(".stat-rpm")).toContainText("rpm");

  // STOP ramps all motors back to the 1000 stop value.
  await page.getByRole("button", { name: "STOP", exact: true }).click();
  await expect
    .poll(
      async () => {
        const frames = await fettecFrames(page);
        return frames.some((frame) => frame.values.every((value) => value === 1000));
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => (window as any).__store.esc.value.running), { timeout: 5_000 })
    .toBe(false);
  await expect(page.locator(".esc-running")).toHaveCount(0);

  // Disconnect: zero frames, DTR drop (FC reboot) and the port closes.
  await page.getByRole("button", { name: "Disconnect FETtec" }).click();
  await expect(page.locator(".esc-status b")).toHaveText("disconnected", { timeout: 10_000 });
  await expect
    .poll(() => page.evaluate(() => window.__fakeSerial?.fettecSignals() ?? []), { timeout: 5_000 })
    .toContainEqual({ dataTerminalReady: false });
});
