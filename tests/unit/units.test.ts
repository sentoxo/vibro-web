import { describe, expect, it } from "vitest";
import {
  clamp,
  dvb1RawToMs2,
  formatDataRate,
  formatUsbIds,
  ms2PerLsb,
  ms2ToDvb1Raw,
  roundHalfToEven,
} from "../../src/core/units";
import { DVB1_LSB_TO_MS2 } from "../../src/core/constants";

describe("roundHalfToEven (np.rint parity)", () => {
  it("rounds .5 ties to the even integer", () => {
    const cases: [number, number][] = [
      [0.5, 0],
      [1.5, 2],
      [2.5, 2],
      [3.5, 4],
      [12.5, 12],
      [13.5, 14],
      [-0.5, 0],
      [-1.5, -2],
      [-2.5, -2],
    ];
    for (const [value, expected] of cases) {
      expect(roundHalfToEven(value)).toBe(expected);
    }
  });

  it("passes through non-ties", () => {
    expect(roundHalfToEven(2.4)).toBe(2);
    expect(roundHalfToEven(2.6)).toBe(3);
    expect(roundHalfToEven(-2.6)).toBe(-3);
    expect(roundHalfToEven(7)).toBe(7);
  });
});

describe("unit conversion", () => {
  it("ms2PerLsb = 9.80665 / lsb_per_g (desktop serial_io)", () => {
    expect(ms2PerLsb(256)).toBeCloseTo(9.80665 / 256, 12);
    expect(ms2PerLsb(2048)).toBeCloseTo(9.80665 / 2048, 12);
  });

  it("DVB1 LSB constant matches config.DVB1_LSB_TO_MS2", () => {
    expect(DVB1_LSB_TO_MS2).toBeCloseTo(0.0039 * 9.80665, 15);
    expect(dvb1RawToMs2(1)).toBeCloseTo(DVB1_LSB_TO_MS2, 15);
    expect(ms2ToDvb1Raw(DVB1_LSB_TO_MS2 * 12345)).toBeCloseTo(12345, 9);
  });

  it("formatUsbIds renders 1a86:7523", () => {
    expect(formatUsbIds(0x1a86, 0x7523)).toBe("1a86:7523");
    expect(formatUsbIds(undefined, undefined)).toBe("");
  });

  it("formatDataRate reports measured KB/s, not a baud percentage", () => {
    expect(formatDataRate(0)).toBe("0.0 KB/s");
    expect(formatDataRate(4260)).toBe("4.3 KB/s");
    expect(formatDataRate(96_000)).toBe("96.0 KB/s");
    expect(formatDataRate(1_234_567)).toBe("1235 KB/s");
    expect(formatDataRate(Number.NaN)).toBe("--");
  });

  it("clamp", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});
