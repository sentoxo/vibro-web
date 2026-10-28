// Bus-level regression for the "motor spins, no telemetry" bug.
//
// A 4in1 ESC (IDs 1..4 present) under a configured count of 8: the fast
// throttle frame and the telemetry reply window must be sized to the PRESENT
// contiguous range (4), like the configurator. When they were sized to the
// configured count (8), the loop asked for 8*2 telemetry bytes, only 4*2
// arrived, and every frame timed out -> replies 0, no RPM/temp/current.

import { describe, expect, it } from "vitest";
import { FettecBus, type FettecTransport } from "../../src/core/fettec/bus";
import {
  crc8Fettec,
  fastThrottleLen,
  MSG,
  SRC_MASTER,
  unpackFastThrottle,
} from "../../src/core/fettec/protocol";
import type { FettecBusStats, FettecDevice, FettecTelemetry } from "../../src/core/fettec/types";

const PRESENT_IDS = [1, 2, 3, 4]; // a 4in1 on IDs 1..4
const CONFIGURED_COUNT = 8; // default ESC count (larger than the bus)

function configReply(id: number, msg: number): Uint8Array {
  const payload: number[] = [];
  if (msg === MSG.REQ_TYPE) payload.push(4); // FETtec PRO ESC 80A
  else if (msg === MSG.REQ_SW_VER) payload.push(6, 1);
  else if (msg === MSG.REQ_SN) for (let i = 0; i < 12; i++) payload.push(0xa0 + i);
  else payload.push(0); // OK / SET_* ack
  const length = 6 + payload.length;
  const frame = new Uint8Array(length);
  frame[0] = 0x03; // firmware
  frame[1] = id;
  frame[3] = 0;
  frame[4] = length;
  frame.set(payload, 5);
  frame[length - 1] = crc8Fettec(frame.subarray(0, length - 1));
  return frame;
}

class FakeTransport implements FettecTransport {
  readonly label = "fake-fettec";
  readonly fastFrames: Uint8Array[] = [];
  readonly configFrames: Uint8Array[] = [];
  /** XOR mask applied to echoed byte 0: the field rig flips the 0x80 marker
   * (0x80) and the slot bits (0x10) under the 2 Mbit turnaround. */
  echoFlip = 0;
  private readonly queue: Uint8Array[] = [];
  private readonly waiters: (() => void)[] = [];

  open(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  setDtr(): Promise<void> {
    return Promise.resolve();
  }

  read(): Promise<Uint8Array | null> {
    const next = this.queue.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => {
      this.waiters.push(() => {
        const value = this.queue.shift();
        resolve(value ?? null);
      });
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    if (bytes[0] === SRC_MASTER && bytes[2] === 0 && bytes[3] === 0 && bytes.length === bytes[4]) {
      const msg = bytes[5];
      this.configFrames.push(bytes.slice());
      const id = bytes[1];
      if (PRESENT_IDS.includes(id)) this.enqueue(configReply(id, msg));
      return Promise.resolve();
    }
    if (bytes[0] & 0x80) {
      this.fastFrames.push(bytes.slice());
      // Half-duplex echo + telemetry for the PRESENT ESCs only. ESC 1 carries
      // a motor; the other 4in1 channels have no motor and answer with the
      // FETtec self-diagnosis frame (consumption 7357, code 2000 = no motor).
      const slot = (bytes[0] >> 4) & 0x07;
      const reply = new Uint8Array(bytes.length + PRESENT_IDS.length * 2);
      reply.set(bytes, 0);
      if (this.echoFlip) reply[0] ^= this.echoFlip;
      for (let i = 0; i < PRESENT_IDS.length; i++) {
        const motorized = i === 0;
        let value = 0;
        if (motorized) {
          if (slot === 1) value = 1100; // 11.00 V
          else if (slot === 2) value = 150; // 1.50 A
          else if (slot === 3) value = 1000; // eRPM/100
          else if (slot === 4) value = 1234; // mAh
        } else if (slot === 1) value = 847; // coded "8.47 V"
        else if (slot === 2) value = 2000; // problem code → bogus "20 A"
        else if (slot === 4) value = 7357; // diagnostic marker
        reply[bytes.length + i * 2] = (value >> 8) & 0xff;
        reply[bytes.length + i * 2 + 1] = value & 0xff;
      }
      this.enqueue(reply);
      return Promise.resolve();
    }
    this.enqueue(new TextEncoder().encode("Betaflight CLI"));
    return Promise.resolve();
  }

  private enqueue(chunk: Uint8Array): void {
    this.queue.push(chunk);
    for (const wake of this.waiters.splice(0)) wake();
  }
}

async function connectFake(options: { echoFlip?: number; replyTimeoutMs?: number } = {}) {
  const transport = new FakeTransport();
  transport.echoFlip = options.echoFlip ?? 0;
  const telemetrySnap: FettecTelemetry[][] = [];
  const devicesSnap: FettecDevice[][] = [];
  const statsSnap: FettecBusStats[] = [];
  const bus = new FettecBus(transport, {
    count: CONFIGURED_COUNT,
    idBase: 1,
    baud: 2000000,
    cliLine: "",
    poles: 12,
    scales: { temp: 1, voltage: 0.01, current: 0.01, erpm: 100, consumption: 1 },
    autoReboot: false,
    replyTimeoutMs: options.replyTimeoutMs,
    getRawValues: () => new Array(CONFIGURED_COUNT).fill(1000),
    onState: () => {},
    onDevices: (devices) => devicesSnap.push(devices),
    onTelemetry: (telemetry) => telemetrySnap.push(telemetry),
    onStats: (stats) => statsSnap.push(stats),
    onLog: () => {},
    onEmergency: () => {},
  });
  await bus.connect();
  return { bus, transport, telemetrySnap, devicesSnap, statsSnap };
}

describe("FettecBus fast window sizes to the present ESC range", () => {
  it("scans 4 present IDs and configures the fast window for 4, not 8", async () => {
    const { bus, transport, devicesSnap } = await connectFake();

    const present = devicesSnap.at(-1)!.filter((device) => device.present).map((device) => device.id);
    expect(present).toEqual(PRESENT_IDS);

    // SET_FAST_COM_LENGTH carries [frameLen, idBase, count] for the present range.
    const fast = transport.configFrames.find((frame) => frame[5] === MSG.SET_FAST_COM_LENGTH)!;
    expect(fast[4]).toBe(10); // 6 overhead + 1 msg + 3 payload (len, idBase, count)
    expect(fast[6]).toBe(fastThrottleLen(4)); // frame length incl. CRC, sized to 4
    expect(fast[7]).toBe(1); // idBase
    expect(fast[8]).toBe(4); // count = present range, NOT the configured 8

    // Every fast-throttle frame is 4-ESC sized (8 bytes incl. CRC), so the ESCs
    // (configured for 4) stay byte-aligned.
    const firstFast = transport.fastFrames[0];
    expect(firstFast.length).toBe(fastThrottleLen(4));
    expect(unpackFastThrottle(firstFast).values).toHaveLength(4);

    await bus.stop();
  });

  it("decodes telemetry (RPM) for the present ESCs instead of timing out", async () => {
    const { bus, transport, telemetrySnap } = await connectFake();

    // Poll a few loop cycles so the slot rotation reaches eRPM (slot 3).
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && !telemetrySnap.some((t) => t[0]?.rpm != null)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(transport.fastFrames.length).toBeGreaterThan(0);
    const withRpm = telemetrySnap.find((t) => t[0]?.rpm != null);
    expect(withRpm, "no RPM decoded: telemetry window never filled").toBeTruthy();

    const first = withRpm![0];
    // Fake returns eRPM raw 1000 -> erpm = 1000*100, rpm = erpm / poles (ArduPilot).
    expect(first.erpm).toBeCloseTo(100000, 0);
    expect(first.rpm).toBeCloseTo(100000 / 12, 0);

    // The trailing IDs (5..8) are not on the bus -> no telemetry for them.
    expect(withRpm![7]?.rpm ?? null).toBeNull();

    await bus.stop();
  });

  it("flags no-motor channels by the 7357 self-diagnosis instead of showing codes", async () => {
    const { bus, devicesSnap } = await connectFake();

    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && !devicesSnap.some((devices) => devices[1]?.problem !== null)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const devices = devicesSnap.at(-1)!;
    // Channel 1 (motor attached): normal measurements, no self-diagnosis.
    expect(devices[0].problem).toBeNull();
    expect(devices[0].problemCode).toBeNull();
    // Channels 2..4 (no motor): raw 2000 = "No motor detected", not 20 A / 8.47 V.
    for (const idle of [devices[1], devices[2], devices[3]]) {
      expect(idle.problemCode).toBe(2000);
      expect(idle.problem).toMatch(/No motor detected/);
    }

    await bus.stop();
  });

  it.each([
    ["the 0x80 marker bit (0x91 → 0x11)", 0x80],
    ["a slot bit (0x91 → 0x81)", 0x10],
  ])("recovers telemetry by prefix-skip when the echo flips %s", async (_label, flip) => {
    // The field log's exact frames: the echo arrives complete (16 B at 4 ESCs)
    // with byte 0 bit-flipped under the 2 Mbit turnaround, so the exact echo
    // matcher never fires and the frame used to time out.
    const { bus } = await connectFake({ echoFlip: flip, replyTimeoutMs: 40 });

    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && bus.currentTelemetry[0].erpm === null) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // RPM for the motorized channel decoded despite the broken echo.
    expect(bus.currentTelemetry[0].erpm).toBeCloseTo(100000, 0);

    const stats = bus.currentStats;
    expect(stats.replies).toBeGreaterThan(0);
    expect(stats.echoFallbacks).toBeGreaterThan(0);
    expect(stats.timeouts).toBe(0);
    expect(stats.rxDebug).toContain("echo-miss");

    await bus.stop();
  });
});
