// DVB1 byte-compatibility with the Python writer/reader (vibro/utils.py).
// Fixtures in tests/fixtures/py_dvb1_*.bin were produced by the real
// utils.write_dvb1_file on this machine (npm run golden regenerates sources).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDvb1, quantizeLsb, writeDvb1, writeDvb1Container } from "../../src/core/dvb1";
import { DVB1_HEADER_SIZE, DVB1_LSB_TO_MS2 } from "../../src/core/constants";

const LSB = DVB1_LSB_TO_MS2;

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("quantizeLsb (np.rint parity)", () => {
  it("rounds halves to even, including negatives", () => {
    const ties = [0.5, 1.5, 2.5, 3.5, -0.5, -1.5, -2.5, -3.5];
    expect(ties.map((v) => quantizeLsb(v * LSB))).toEqual([0, 2, 2, 4, 0, -2, -2, -4]);
  });

  it("rounds non-halves normally", () => {
    expect(quantizeLsb(0.4 * LSB)).toBe(0);
    expect(quantizeLsb(0.6 * LSB)).toBe(1);
    expect(quantizeLsb(-0.6 * LSB)).toBe(-1);
    expect(quantizeLsb(1.2 * LSB)).toBe(1);
    expect(quantizeLsb(-1.2 * LSB)).toBe(-1);
  });

  it("clamps to int16 range", () => {
    expect(quantizeLsb(40000)).toBe(32767);
    expect(quantizeLsb(-40000)).toBe(-32768);
  });
});

describe("parseDvb1 (Python fixtures)", () => {
  it("parses a single burst written by utils.write_dvb1_file", () => {
    const { bursts, skipped } = parseDvb1(fixture("py_dvb1_single.bin"));
    expect(skipped).toBe(0);
    expect(bursts.length).toBe(1);
    const b = bursts[0];
    expect(b.version).toBe(1);
    expect(b.axes).toBe(3);
    expect(b.sampleRate).toBe(3200);
    expect(b.sampleCount).toBe(13);
    expect(b.timestampNs).toBe(123456789012345678n);
    expect(b.sequence).toBe(7n);
    const x = Array.from({ length: 13 }, (_, i) => b.samples[i * 3] / LSB);
    expect(x.map((v) => Math.round(v))).toEqual([0, 2, 2, 4, 0, -2, -2, -4, 32767, -32768, 1, -1, 0]);
  });

  it("parses a multi-burst container", () => {
    const { bursts } = parseDvb1(fixture("py_dvb1_container.bin"));
    expect(bursts.map((b) => [b.sampleCount, Number(b.sequence)])).toEqual([
      [13, 7],
      [128, 8],
    ]);
  });

  it("resyncs over garbage bytes (magic scan)", () => {
    const { bursts, skipped } = parseDvb1(fixture("py_dvb1_garbage.bin"));
    expect(bursts.map((b) => Number(b.sequence))).toEqual([7, 8]);
    expect(skipped).toBeGreaterThan(0);
  });

  it("drops a truncated trailing burst", () => {
    const { bursts } = parseDvb1(fixture("py_dvb1_truncated.bin"));
    expect(bursts.map((b) => Number(b.sequence))).toEqual([7]);
  });

  it("parses the 6-burst test dataset (6400 samples @ 3200 Hz)", () => {
    const { bursts, skipped } = parseDvb1(fixture("test_data.bin"));
    expect(skipped).toBe(0);
    expect(bursts.length).toBe(6);
    for (const b of bursts) {
      expect(b.sampleCount).toBe(6400);
      expect(b.sampleRate).toBe(3200);
      expect(b.samples.length).toBe(6400 * 3);
    }
  });

  it("returns no bursts for non-DVB1 input", () => {
    expect(parseDvb1(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).bursts).toEqual([]);
    expect(parseDvb1(new Uint8Array(0)).bursts).toEqual([]);
  });
});

describe("writeDvb1 (byte-exact vs Python)", () => {
  const tieRows: number[] = [];
  for (const v of [0.5, 1.5, 2.5, 3.5, -0.5, -1.5, -2.5, -3.5, 40000, -40000, 1.2, -1.2, 0]) {
    tieRows.push(v * LSB, -v * LSB, v * LSB * 0.25);
  }

  it("produces the exact bytes utils.write_dvb1_file wrote", () => {
    const bytes = writeDvb1(Float64Array.from(tieRows), {
      sampleRate: 3200,
      timestampNs: 123456789012345678n,
      sequence: 7n,
    });
    expect(bytes.length).toBe(DVB1_HEADER_SIZE + 13 * 3 * 2);
    expect(bytesEqual(bytes, fixture("py_dvb1_single.bin"))).toBe(true);
  });

  it("round-trips through the parser", () => {
    const bytes = writeDvb1(Float64Array.from(tieRows), {
      sampleRate: 3200,
      timestampNs: 42n,
      sequence: 1n,
    });
    const { bursts } = parseDvb1(bytes);
    expect(bursts.length).toBe(1);
    expect(bursts[0].timestampNs).toBe(42n);
    expect(bursts[0].samples[0]).toBe(0);
  });

  it("concatenates bursts into a container the parser reads back", () => {
    const a = writeDvb1(Float64Array.from(tieRows), {
      sampleRate: 3200,
      timestampNs: 123456789012345678n,
      sequence: 7n,
    });
    const b = writeDvb1(new Float64Array(128 * 3), {
      sampleRate: 3200,
      timestampNs: 987654321098765432n,
      sequence: 8n,
    });
    const container = writeDvb1Container([a, b]);
    const { bursts } = parseDvb1(container);
    expect(bursts.map((x) => [x.sampleCount, Number(x.sequence)])).toEqual([
      [13, 7],
      [128, 8],
    ]);
  });
});
