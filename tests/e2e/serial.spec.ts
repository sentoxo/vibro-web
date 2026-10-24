// Mock Web Serial end-to-end: handshake, streaming, loss counting, MSP FC
// telemetry, motor commands and the stop ramp — all against fake ports.

import { expect, test, type Page } from "@playwright/test";
import { installFakeSerial } from "./support/fake-serial";

async function sensorTexts(page: Page): Promise<string> {
  const writes = await page.evaluate(() => window.__fakeSerial?.lastWrites("sensor") ?? []);
  return writes.map((bytes) => String.fromCharCode(...bytes)).join("");
}

async function fcWrites(page: Page): Promise<number[][]> {
  return page.evaluate(() => window.__fakeSerial?.lastWrites("fc") ?? []);
}

function findSetMotor(bytes: number[], throttle: number): boolean {
  const lo = throttle & 0xff;
  const hi = (throttle >> 8) & 0xff;
  for (let i = 0; i + 13 <= bytes.length; i++) {
    if (
      bytes[i] === 0x24 &&
      bytes[i + 1] === 0x4d &&
      bytes[i + 2] === 0x3c &&
      bytes[i + 3] === 0x08 &&
      bytes[i + 4] === 0xd6 &&
      bytes[i + 5] === lo &&
      bytes[i + 6] === hi
    ) {
      return true;
    }
  }
  return false;
}

async function connectSensor(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect sensor" }).click();
  await page.getByRole("button", { name: "Select sensor port" }).click();
}

test.describe("mock serial sensor", () => {
  test("handshakes, streams samples and counts sequence loss", async ({ page }) => {
    await page.addInitScript(installFakeSerial);
    await connectSensor(page);

    // Desktop handshake: `call all` immediately, `start stream` ~3 s later.
    await expect.poll(() => sensorTexts(page), { timeout: 15_000 }).toContain("start stream");
    expect(await sensorTexts(page)).toContain("call all");

    // Samples flow: packet rate > 0 and RMS > 0.
    await expect
      .poll(() => page.evaluate(() => (window as any).__store.diagnostics.value.packetRate), { timeout: 10_000 })
      .toBeGreaterThan(10);
    await expect
      .poll(() => page.evaluate(() => (window as any).__store.rms.value.current), { timeout: 10_000 })
      .toBeGreaterThan(0.1);
    await expect(page.locator("canvas")).toHaveCount(6);

    // The fake pump skips 3 packets at seq 500 → the loss counter sees them.
    await expect
      .poll(() => page.evaluate(() => (window as any).__store.diagnostics.value.lostPackets), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(3);

    // Desktop parity D4: first loss in a session raises a one-time modal.
    const lossDialog = page.getByRole("dialog", { name: "Lost packets detected" });
    await expect(lossDialog).toBeVisible({ timeout: 5_000 });
    await lossDialog.getByRole("button", { name: "OK" }).click();
    await expect(lossDialog).toHaveCount(0);

    // Malformed lines are counted, not fatal.
    await page.evaluate(() => window.__fakeSerial?.enqueueSensor("garbage-line\n"));
    await expect
      .poll(() => page.evaluate(() => (window as any).__store.diagnostics.value.malformedLines), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(1);

    // Status strip shows the measured payload rate for serial sources.
    await expect(page.getByLabel("Diagnostics")).toContainText("wire");
    await expect(page.getByLabel("Diagnostics")).toContainText("KB/s");
  });

  test("manual disconnect and reconnect does not count the outage as loss", async ({ page }) => {
    await page.addInitScript(installFakeSerial, { simulateLoss: false });
    await connectSensor(page);
    await expect
      .poll(() => page.evaluate(() => (window as any).__store.diagnostics.value.packetRate), { timeout: 10_000 })
      .toBeGreaterThan(10);

    // Let the sensor advance its sequence while streaming.
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__store.connection.value), { timeout: 5_000 })
      .toBe("idle");

    // The device keeps producing frames while detached; reconnecting must use
    // a fresh sequence baseline and a zero loss counter. The fake also drops a
    // few samples on the second chunk after reopening (USB CDC backlog drain),
    // which must not be reported as loss either.
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("button", { name: /STM32 VCP/ }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__store.connection.value), { timeout: 15_000 })
      .toBe("streaming");
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as any).__store.diagnostics.value.lostPackets)).toBe(0);
    await expect(page.getByRole("dialog", { name: "Lost packets detected" })).toHaveCount(0);
    expect(await page.evaluate(() => window.__fakeSerial?.sensor?.openCount ?? 0)).toBeGreaterThanOrEqual(2);
  });

  test("auto-reconnects after a device loss without a loss spike", async ({ page }) => {
    await page.addInitScript(installFakeSerial, { simulateLoss: false });
    await connectSensor(page);
    await expect
      .poll(() => page.evaluate(() => (window as any).__store.diagnostics.value.packetRate), { timeout: 10_000 })
      .toBeGreaterThan(10);

    await page.evaluate(() => window.__fakeSerial?.simulateSensorLoss());
    await expect
      .poll(() => page.evaluate(() => (window as any).__store.connection.value), { timeout: 20_000 })
      .toBe("streaming");
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as any).__store.diagnostics.value.lostPackets)).toBe(0);
    await expect(page.getByRole("dialog", { name: "Lost packets detected" })).toHaveCount(0);
    expect(await page.evaluate(() => window.__fakeSerial?.sensor?.openCount ?? 0)).toBeGreaterThanOrEqual(2);
  });

  test("FC telemetry, motor start, power change and stop ramp", async ({ page }) => {
    test.setTimeout(90_000); // the desktop handshake adds a 3 s pause up front
    await page.addInitScript(installFakeSerial, { simulateLoss: false });
    await connectSensor(page);
    await expect.poll(() => sensorTexts(page), { timeout: 15_000 }).toContain("start stream");

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Connect FC (115200)" }).click();
    await expect(page.locator(".esc-status b")).toHaveText("connected", { timeout: 10_000 });

    // Telemetry: fake FC answers MSP_MOTOR_TELEMETRY with 4 motors.
    await expect(page.locator(".esc-rpm")).toContainText("4 motors", { timeout: 10_000 });

    // The FC link polls telemetry every 100 ms.
    await expect.poll(async () => (await fcWrites(page)).flat().length, { timeout: 5_000 }).toBeGreaterThan(6);

    // START opens the safety dialog first (desktop parity); it requires the
    // props-off acknowledgment checkbox before enabling confirmation. A start
    // can be dropped if a telemetry poll holds the port writer (the desktop
    // "command dropped" race), so retry until the controller reports running.
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.getByRole("button", { name: "START", exact: true }).click();
      const ack = page.getByRole("checkbox", { name: /Props are removed/ });
      if (await ack.count()) {
        await ack.check();
        await page.getByRole("button", { name: "I understand — enable ESC control" }).click();
      }
      if (await page.evaluate(() => (window as any).__store.esc.value.running)) break;
    }
    await expect.poll(async () => findSetMotor((await fcWrites(page)).flat(), 1000), { timeout: 5_000 }).toBe(true);

    // Power 30 % → 1300 µs (1000 + 30×10). Keyboard events drive Preact's
    // delegated onInput; programmatic fill can be swallowed.
    await page.getByLabel("Power level").press("Control+a");
    await page.getByLabel("Power level").pressSequentially("30", { delay: 30 });
    await page.getByLabel("Power level").press("Enter");
    await expect.poll(async () => findSetMotor((await fcWrites(page)).flat(), 1300), { timeout: 5_000 }).toBe(true);

    // STOP ramps to zero throttle, then the controller returns to idle.
    await page.getByRole("button", { name: "STOP", exact: true }).click();
    await expect.poll(async () => findSetMotor((await fcWrites(page)).flat(), 1000), { timeout: 10_000 }).toBe(true);
    await expect(page.locator(".esc-status b")).toHaveText("connected");
    await expect(page.locator(".esc-running")).toHaveCount(0, { timeout: 5_000 });
  });
});
