// Snapshot filename convention (plan §6.14), matching the desktop
// `_output_path`: `{base}{index:02d}_{power}` with `_02` collision suffixes.

import { roundHalfToEven } from "./units";

export const EXPORT_EXTENSIONS = [".png", ".bin"] as const;

/** Trim, strip path separators/control chars and a known extension. */
export function sanitizeBase(name: string): string {
  // Strip Windows/Unix path components, then control characters.
  const leaf = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\.(png|bin)$/i, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "snapshot";
}

function pad2(n: number): string {
  return String(Math.trunc(n)).padStart(2, "0");
}

/** `{base}{index:02d}_{power}` — index 1..99, power 0..100 (rounded). */
export function stemFor(base: string, index: number, power: number): string {
  const safeIndex = Math.min(99, Math.max(1, Math.trunc(index)));
  // Desktop: int(round(power)) — banker's rounding (12.5 → 12).
  const safePower = Math.min(100, Math.max(0, roundHalfToEven(power)));
  return `${sanitizeBase(base)}${pad2(safeIndex)}_${safePower}`;
}

/** First free stem: `stem`, `stem_02`, `stem_03`, ... against `taken`. */
export function resolveStem(stem: string, taken: Set<string>): string {
  if (!taken.has(stem)) return stem;
  let counter = 2;
  while (taken.has(`${stem}_${pad2(counter)}`)) counter += 1;
  return `${stem}_${pad2(counter)}`;
}

export interface ResolvedName {
  stem: string;
  filename: string;
}

/** Resolve a collision-free stem for the paired export set. */
export function resolveNames(base: string, index: number, power: number, taken: Set<string>): ResolvedName {
  const stem = resolveStem(stemFor(base, index, power), taken);
  return { stem, filename: `${stem}.png` };
}
