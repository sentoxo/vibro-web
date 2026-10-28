import { describe, expect, it } from "vitest";
import {
  buildConfigFrame,
  consumeFastReply,
  crc8Dvb,
  crc8Fettec,
  decodeFastTelemetry,
  DEFAULT_TLM_SCALES,
  extractFrames,
  fastThrottleCommandLen,
  fastThrottleLen,
  fettecDeviceName,
  fettecProblemInfo,
  frameMessage,
  framePayload,
  isFettecDiagnostic,
  MSG,
  packFastThrottle,
  SRC_BOOTLOADER,
  SRC_ESC,
  TLM_DIAGNOSTIC_MARKER,
  unpackFastThrottle,
} from "../../src/core/fettec/protocol";

function bytes(values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function hex(values: ArrayLike<number>): string {
  return Array.from(values)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join(" ");
}

/** Build an ESC reply frame (source 0x03) with a valid CRC. */
function reply(src: number, id: number, body: number[]): Uint8Array {
  const head = [src, id, 0, 0, 6 + body.length];
  const frame = bytes([...head, ...body]);
  const out = new Uint8Array(frame.length + 1);
  out.set(frame);
  out[frame.length] = crc8Fettec(frame);
  return out;
}

describe("FETtec CRC-8", () => {
  it("uses the configurator/ArduPilot polynomial 0x07 (not 0xD5)", () => {
    // Standard CRC-8/ATM check value for "123456789".
    expect(crc8Fettec(new TextEncoder().encode("123456789"))).toBe(0xf4);
    expect(crc8Dvb(new TextEncoder().encode("123456789"))).toBe(0xf4);
  });

  it("matches the real OK frame sent to ESC 1 (CRC 0x20)", () => {
    expect(hex(buildConfigFrame(1, MSG.OK))).toBe("01 01 00 00 07 00 20");
  });
});

describe("config frames", () => {
  it("builds SET_FAST_COM_LENGTH with the full frame length, min ID and count", () => {
    expect(hex(buildConfigFrame(1, MSG.SET_FAST_COM_LENGTH, [14, 1, 8]))).toBe("01 01 00 00 0a 1a 0e 01 08 4d");
  });

  it("builds SET_TLM_TYPE 0 (fast-slot telemetry)", () => {
    expect(hex(buildConfigFrame(3, MSG.SET_TLM_TYPE, [0]))).toBe("01 03 00 00 08 1b 00 35");
  });

  it("extracts replies, skips echo/garbage and keeps a truncated tail", () => {
    const ack = reply(SRC_ESC, 2, [MSG.OK]);
    const type = reply(SRC_ESC, 2, [MSG.REQ_TYPE, 10]);
    const truncated = reply(SRC_ESC, 2, [MSG.REQ_SW_VER, 1, 2]).subarray(0, 6);
    const echo = buildConfigFrame(2, MSG.REQ_TYPE);
    const buffer = bytes([0xff, 0x00, ...echo, ...ack, 0x42, ...type, ...truncated]);

    const result = extractFrames(buffer);
    expect(result.frames.map((frame) => frame.id)).toEqual([2, 2]);
    expect(result.frames.map((frame) => frameMessage(frame))).toEqual([MSG.OK, MSG.REQ_TYPE]);
    expect(result.frames.map((frame) => [...framePayload(frame)])).toEqual([[], [10]]);
    expect(result.leftover).toEqual(truncated);
  });

  it("counts a bad CRC as an error and resyncs on the next frame", () => {
    const good = reply(SRC_ESC, 1, [MSG.OK]);
    const bad = reply(SRC_ESC, 1, [MSG.OK]);
    bad[bad.length - 1] ^= 0xff;
    const result = extractFrames(bytes([...bad, ...good]));
    expect(result.frames).toHaveLength(1);
    expect(result.crcErrors).toBe(1);
  });

  it("recognises bootloader (0x02) and firmware (0x03) sources", () => {
    const result = extractFrames(bytes([...reply(SRC_BOOTLOADER, 1, [0]), ...reply(SRC_ESC, 1, [0])]));
    expect(result.frames.map((frame) => frame.src)).toEqual([SRC_BOOTLOADER, SRC_ESC]);
  });
});

describe("fast throttle", () => {
  it("uses the full frame length (incl. CRC) for SET_FAST_COM_LENGTH", () => {
    expect(Array.from({ length: 8 }, (_, index) => fastThrottleLen(index + 1))).toEqual([4, 6, 7, 8, 10, 11, 13, 14]);
    expect(Array.from({ length: 8 }, (_, index) => fastThrottleCommandLen(index + 1))).toEqual([
      3, 5, 6, 7, 9, 10, 12, 13,
    ]);
    expect(() => fastThrottleLen(0)).toThrow(RangeError);
  });

  it("packs byte-exact goldens incl. the slot bit and ALL_ID", () => {
    expect(hex(packFastThrottle([1000], 7).frame)).toBe("f1 ff d0 ee");
    expect(hex(packFastThrottle([1500, 1600], 3).frame)).toBe("b9 7f b9 90 00 6b");
    expect(hex(packFastThrottle([1000, 1100, 1200, 1300], 0).frame)).toBe("81 ff d1 13 25 85 14 b0");
    expect(hex(packFastThrottle([1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070], 5).frame)).toBe(
      "d1 ff d0 fc 9f e4 06 82 10 6a 12 42 e0 c7",
    );
  });

  it("sets bit 7 in byte 0 (configurator fast-slot mode) and the source nibble", () => {
    const frame = packFastThrottle([1000, 1000], 0).frame;
    expect(frame[0] & 0x80).toBe(0x80);
    expect(frame[0] & 0x0f).toBe(0x01);
    expect(frame[1] & 0x1f).toBe(0x1f);
  });

  it("unpacks every golden back to the input values and slot", () => {
    const cases: [number[], number][] = [
      [[1000], 7],
      [[1500, 1600], 3],
      [[1000, 1100, 1200, 1300], 0],
      [[1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070], 5],
    ];
    for (const [values, slot] of cases) {
      const packed = packFastThrottle(values, slot);
      expect(unpackFastThrottle(packed.frame)).toEqual({ values, tlmSlot: slot });
    }
  });

  it("clamps out-of-range and non-finite raw values", () => {
    expect(unpackFastThrottle(packFastThrottle([-10, 9999], 0).frame).values).toEqual([0, 2000]);
    expect(unpackFastThrottle(packFastThrottle([Number.NaN], 0).frame).values).toEqual([1000]);
  });
});

describe("fast telemetry", () => {
  it("decodes big-endian u16 values per ESC with the slot scale", () => {
    const temp = decodeFastTelemetry(bytes([0xff, 0xfe, 0x00, 0x2a]), 2, 0, DEFAULT_TLM_SCALES, 14);
    expect(temp.map((entry) => entry.tempC)).toEqual([-2, 42]);

    const volt = decodeFastTelemetry(bytes([0x06, 0x8a]), 1, 1);
    expect(volt[0].volt).toBeCloseTo(16.74, 6);

    const current = decodeFastTelemetry(bytes([0xff, 0x9c]), 1, 2);
    expect(current[0].amps).toBeCloseTo(-1, 6);

    const erpm = decodeFastTelemetry(bytes([0x01, 0x00]), 1, 3, DEFAULT_TLM_SCALES, 14);
    expect(erpm[0].erpm).toBe(25600);
    // ArduPilot: eRPM (raw × 100) divided by poles (×2 was the doubled-RPM bug).
    expect(erpm[0].rpm).toBeCloseTo(25600 / 14, 6);

    const mah = decodeFastTelemetry(bytes([0x00, 0xc8]), 1, 4);
    expect(mah[0].mah).toBe(200);

    const debug = decodeFastTelemetry(bytes([0x12, 0x34]), 1, 5);
    expect(debug[0].debug).toBe(0x1234);
  });

  it("applies scale overrides", () => {
    const reading = decodeFastTelemetry(bytes([0x00, 0x64]), 1, 1, {
      temp: 1,
      voltage: 0.001,
      current: 1,
      erpm: 1,
      consumption: 1,
    });
    expect(reading[0].volt).toBeCloseTo(0.1, 6);
  });

  it("returns nothing for a short block", () => {
    expect(decodeFastTelemetry(bytes([0x00]), 1, 0)).toEqual([]);
  });
});

describe("consumeFastReply", () => {
  const echo = packFastThrottle([1000, 1000], 0).frame;
  const telemetry = bytes([0x00, 0x10, 0x00, 0x20]);

  it("skips the half-duplex echo and takes count*2 telemetry bytes", () => {
    const buffer = bytes([0xaa, ...echo, ...telemetry, 0xbb]);
    const result = consumeFastReply(buffer, echo, 2);
    expect(result.telemetry).toEqual(telemetry);
    expect(result.leftover).toEqual(bytes([0xbb]));
    expect(result.fallback).toBe(false);
  });

  it("waits for the telemetry block when the reply is split", () => {
    const result = consumeFastReply(bytes([...echo, 0x00, 0x10]), echo, 2);
    expect(result.telemetry).toBeNull();
    expect(result.fallback).toBe(false);
  });

  it("prefix-skips a full-length echo that is not byte-identical (real-hardware ESC echo)", () => {
    // Field capture: byte 3 flips FA→F8 under the 2 Mbit half-duplex
    // turnaround; exact match fails, the configurator/ArduPilot convention
    // (skip sentLen, parse the rest) recovers every frame.
    const corrupt = bytes([...echo, ...telemetry]);
    corrupt[3] ^= 0x02;
    const result = consumeFastReply(corrupt, echo, 2);
    expect(result.telemetry).toEqual(telemetry);
    expect(result.fallback).toBe(true);
  });

  it("prefix-skips even when echo byte 0 flips its slot bit or the 0x80 marker", () => {
    // The field log's remaining timeouts: expected 0x91 echoed as 0x81
    // (slot bit) and 0x11 (bit 7). Validating byte 0 rejects exactly the
    // corrupted frames, so the fallback is length-gated only.
    for (const flip of [0x10, 0x80]) {
      const corrupt = bytes([...echo, ...telemetry]);
      corrupt[0] ^= flip;
      const result = consumeFastReply(corrupt, echo, 2);
      expect(result.telemetry).toEqual(telemetry);
      expect(result.fallback).toBe(true);
    }
  });
});

describe("ESC self-diagnosis (7357 frames)", () => {
  it("recognizes the configurator's consumption marker", () => {
    expect(TLM_DIAGNOSTIC_MARKER).toBe(7357);
    expect(isFettecDiagnostic(7357)).toBe(true);
    expect(isFettecDiagnostic(200)).toBe(false);
  });

  it("decodes the problem codes the configurator warns about", () => {
    expect(fettecProblemInfo(1000).message).toMatch(/LOW-side FETs/);
    expect(fettecProblemInfo(2000).message).toMatch(/No motor detected/);
    expect(fettecProblemInfo(3000).message).toMatch(/Firmware mismatch/);
    expect(fettecProblemInfo(4242)).toEqual({ code: 4242, message: "ESC self-diagnosis reported (code 4242)" });
  });

  it("the 'no motor' diagnostic frame is exactly the numbers users see as noise", () => {
    // Slots of an idle 4in1 channel (the user's "8.47 V, 20 A, 7357 mAh"):
    const voltage = decodeFastTelemetry(bytes([0x03, 0x4f]), 1, 1); // 847 → 8.47 "V"
    const current = decodeFastTelemetry(bytes([0x07, 0xd0]), 1, 2); // 2000 → 20 "A"
    const mah = decodeFastTelemetry(bytes([0x1c, 0xbd]), 1, 4); // 7357 → marker
    expect(voltage[0].volt).toBeCloseTo(8.47, 2);
    expect(current[0].amps).toBeCloseTo(20, 2);
    expect(isFettecDiagnostic(mah[0].raw)).toBe(true);
    expect(fettecProblemInfo(current[0].raw).message).toMatch(/No motor detected/);
  });
});

describe("device names", () => {
  it("maps known configurator device types and falls back", () => {
    expect(fettecDeviceName(1)).toBe("FETtec ESC 35A");
    expect(fettecDeviceName(4)).toBe("FETtec PRO ESC 80A");
    expect(fettecDeviceName(999)).toBe("ESC type 999");
  });
});
