// RMS statistics: per-axis RMS, ISO-style vector resultant and the 10 s
// rolling history with avg/min/max (plan §6.10).

export function meanOf(values: ArrayLike<number>, n = values.length): number {
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  return sum / n;
}

/** RMS over the first `n` entries, after subtracting `mean` (gravity/DC). */
export function rmsZeroMean(values: ArrayLike<number>, n: number, mean: number): number {
  if (n === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i] - mean;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / n);
}

/** RMS of data that is already mean-removed. */
export function rmsZeroCentered(values: ArrayLike<number>, n = values.length): number {
  if (n === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += values[i] * values[i];
  return Math.sqrt(sumSq / n);
}

/** Vector resultant RMS: sqrt(rmsX² + rmsY² + rmsZ²). */
export function vectorRms(rmsX: number, rmsY: number, rmsZ: number): number {
  return Math.sqrt(rmsX * rmsX + rmsY * rmsY + rmsZ * rmsZ);
}

export interface RmsHistoryPoint {
  t: number;
  rms: number;
}

/** Rolling time-windowed RMS history (desktop `rms_history` deque). */
export class RmsHistory {
  private points: RmsHistoryPoint[] = [];
  private readonly windowMs: number;

  constructor(windowSeconds: number) {
    this.windowMs = windowSeconds * 1000;
  }

  clear(): void {
    this.points = [];
  }

  push(tMs: number, rms: number): void {
    this.points.push({ t: tMs, rms });
    this.prune(tMs);
  }

  prune(tMs: number): void {
    const cutoff = tMs - this.windowMs;
    let drop = 0;
    while (drop < this.points.length && this.points[drop].t < cutoff) drop += 1;
    if (drop > 0) this.points.splice(0, drop);
  }

  get size(): number {
    return this.points.length;
  }

  get values(): number[] {
    return this.points.map((p) => p.rms);
  }

  avgMinMax(): { avg: number; min: number; max: number } {
    if (this.points.length === 0) return { avg: 0, min: 0, max: 0 };
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const p of this.points) {
      sum += p.rms;
      if (p.rms < min) min = p.rms;
      if (p.rms > max) max = p.rms;
    }
    return { avg: sum / this.points.length, min, max };
  }

  /** Downsampled series for the sparkline, at most `maxPoints` samples. */
  series(maxPoints = 100): number[] {
    const n = this.points.length;
    if (n <= maxPoints) return this.values;
    const out: number[] = [];
    const stride = n / maxPoints;
    for (let i = 0; i < maxPoints; i++) out.push(this.points[Math.floor(i * stride)].rms);
    return out;
  }
}
