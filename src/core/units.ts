// Unit conversion and number formatting helpers.

import { DVB1_LSB_TO_MS2, G } from "./constants";

/** m/s² per raw LSB for a sensor with `lsbPerG` LSB/g sensitivity. */
export function ms2PerLsb(lsbPerG: number): number {
  return G / lsbPerG;
}

export function rawToMs2(raw: number, ms2PerLsbFactor: number): number {
  return raw * ms2PerLsbFactor;
}

export function dvb1RawToMs2(raw: number): number {
  return raw * DVB1_LSB_TO_MS2;
}

export function ms2ToDvb1Raw(ms2: number): number {
  return ms2 / DVB1_LSB_TO_MS2;
}

/**
 * Round half to even (banker's rounding), matching numpy `np.rint`, so DVB1
 * exports are bit-identical to the Python writer. `Math.round` ties toward
 * +Infinity, so ties need an explicit even adjustment.
 */
export function roundHalfToEven(value: number): number {
  const rounded = Math.round(value);
  const result = Math.abs(value % 1) === 0.5 ? (rounded % 2 === 0 ? rounded : rounded - 1) : rounded;
  return result === 0 ? 0 : result; // normalize -0 (np.rint(-0.5) prints as 0)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return "--";
  return value.toFixed(digits);
}

export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return "--";
  return Math.round(value).toLocaleString("en-US");
}

export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return "--";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** `1a86:7523` style USB id string for serial device labels. */
export function formatUsbIds(vendorId?: number, productId?: number): string {
  if (vendorId === undefined || productId === undefined) return "";
  const hex = (n: number) => n.toString(16).padStart(4, "0");
  return `${hex(vendorId)}:${hex(productId)}`;
}

/** Format a nanosecond Unix timestamp for the burst metadata panel. */
export function formatTimestampNs(timestampNs: bigint): string {
  const ms = Number(timestampNs / 1_000_000n);
  const subMs = Number(timestampNs % 1_000_000n);
  const date = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${datePart} ${timePart}.${pad(Math.floor(subMs / 1000), 3)}`;
}
