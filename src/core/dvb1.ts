// DVB1 recorder/parser, byte-compatible with the Python writer/reader
// (vibro/utils.py): magic "DVB1" + struct "<HHIIQQ" (28-byte header) per
// burst, then sampleCount * axes little-endian int16 samples, quantized
// with np.rint (ties-to-even) and clipped to int16. A file is a container
// of concatenated bursts; garbage between magic markers is skipped and a
// truncated trailing burst is dropped (both like the Python parser).

import { DVB1_AXES, DVB1_HEADER_SIZE, DVB1_LSB_TO_MS2, DVB1_MAGIC } from "./constants";
import { clamp, roundHalfToEven } from "./units";
import type { Burst } from "./types";

const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export interface ParsedFile {
  bursts: Burst[];
  /** Garbage/resync events skipped between bursts (web-side diagnostic). */
  skipped: number;
}

export interface WriteOptions {
  sampleRate: number;
  timestampNs: bigint;
  sequence: bigint;
  /** Axis count written to the header; the writer emits xyz triples. */
  axes?: number;
}

/** np.rint (round half to even) + int16 saturation for one ms/s² value. */
export function quantizeLsb(ms2: number): number {
  return clamp(roundHalfToEven(ms2 / DVB1_LSB_TO_MS2), -32768, 32767);
}

/**
 * Serialize one DVB1 burst. `samples` are interleaved xyz in ms/s².
 */
export function writeDvb1(samples: Float64Array | Float32Array | Int16Array, options: WriteOptions): Uint8Array {
  const axes = Math.max(1, Math.min(DVB1_AXES, options.axes ?? 3));
  const sampleCount = Math.floor(samples.length / 3);
  const bytes = new Uint8Array(DVB1_HEADER_SIZE + sampleCount * axes * 2);
  const view = viewOf(bytes);
  for (let i = 0; i < DVB1_MAGIC.length; i++) bytes[i] = DVB1_MAGIC.charCodeAt(i);
  view.setUint16(4, 1, true); // version
  view.setUint16(6, axes, true);
  view.setUint32(8, Math.round(options.sampleRate) >>> 0, true);
  view.setUint32(12, sampleCount, true);
  view.setBigUint64(16, options.timestampNs, true);
  view.setBigUint64(24, options.sequence, true);

  const isInt = samples instanceof Int16Array;
  for (let s = 0; s < sampleCount; s++) {
    for (let a = 0; a < axes; a++) {
      const v = isInt ? (samples as Int16Array)[s * 3 + a] : quantizeLsb(samples[s * 3 + a]);
      view.setInt16(DVB1_HEADER_SIZE + (s * axes + a) * 2, v, true);
    }
  }
  return bytes;
}

/** Concatenate serialized bursts into a multi-burst container. */
export function writeDvb1Container(bursts: Uint8Array[]): Uint8Array {
  const size = bursts.reduce((sum, b) => sum + b.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const b of bursts) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

/**
 * Parse a DVB1 container into bursts. Garbage bytes between magic markers
 * are skipped (resync); a trailing burst whose payload is truncated is
 * dropped — both mirror utils.parse_dvb1_file.
 */
export function parseDvb1(input: ArrayBuffer | Uint8Array): ParsedFile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const magic = (0x44 << 24) | (0x56 << 16) | (0x42 << 8) | 0x31; // "DVB1"
  const bursts: Burst[] = [];
  let skipped = 0;
  let offset = 0;
  const view = viewOf(bytes);

  const indexOfMagic = (from: number): number => {
    // bytes.indexOf on a Buffer is O(n); manual 4-byte scan is fine for ≤100 MB
    for (let i = from; i + 4 <= bytes.length; i++) {
      if (view.getUint32(i, false) === magic) return i;
    }
    return -1;
  };

  while (offset + DVB1_HEADER_SIZE <= bytes.length) {
    if (view.getUint32(offset, false) !== magic) {
      const next = indexOfMagic(offset + 1);
      if (next < 0) break;
      skipped++;
      offset = next;
      continue;
    }
    const version = view.getUint16(offset + 4, true);
    const axes = view.getUint16(offset + 6, true);
    const sampleRate = view.getUint32(offset + 8, true);
    const sampleCount = view.getUint32(offset + 12, true);
    const timestampNs = view.getBigUint64(offset + 16, true);
    const sequence = view.getBigUint64(offset + 24, true);
    if (axes === 0 || sampleCount > (bytes.length - offset - DVB1_HEADER_SIZE) / (axes * 2)) {
      // Truncated (or nonsensical) trailing burst: Python breaks out.
      break;
    }
    const channels = Math.max(1, Math.min(3, axes));
    const samples = new Float32Array(sampleCount * 3);
    for (let s = 0; s < sampleCount; s++) {
      for (let a = 0; a < channels; a++) {
        const raw = view.getInt16(offset + DVB1_HEADER_SIZE + (s * axes + a) * 2, true);
        samples[s * 3 + a] = raw * DVB1_LSB_TO_MS2;
      }
    }
    bursts.push({
      version,
      axes,
      sampleRate,
      sampleCount,
      timestampNs,
      sequence,
      samples,
    });
    offset += DVB1_HEADER_SIZE + sampleCount * axes * 2;
  }
  return { bursts, skipped };
}

export { DVB1_HEADER_SIZE, DVB1_LSB_TO_MS2 };
