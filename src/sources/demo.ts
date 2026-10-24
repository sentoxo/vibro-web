// Demo source: synthetic live stream (landing dashboard) plus the four
// desktop demo bursts (plan §6.12).

import { DEMO_BATCH_INTERVAL_MS, DEMO_BURST_FREQS, DVB1_SAMPLE_COUNT, DVB1_SAMPLE_RATE } from "../core/constants";
import type { Burst } from "../core/types";
import { BatchEmitter, type DataSource, type SourceHandlers } from "./source";

/** Seeded LCG so tests can reproduce a demo stream exactly. */
export function createLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/**
 * Synthetic stream: the four demo frequencies with slowly modulated
 * amplitudes, per-axis phase/amplitude differences and low-amplitude noise.
 */
export function demoSampleAt(t: number, axis: 0 | 1 | 2, noise: number): number {
  const [f1, f2, f3, f4] = DEMO_BURST_FREQS;
  const mod = (freq: number, phase: number) => 0.72 + 0.28 * Math.sin(2 * Math.PI * freq * t + phase);
  const TAU = 2 * Math.PI;
  switch (axis) {
    case 0:
      return (
        1.05 * mod(f1, 0.3) * Math.sin(TAU * f1 * t) +
        0.45 * mod(f3, 1.1) * Math.sin(TAU * f3 * t + 0.5) +
        0.04 * Math.sin(TAU * 0.05 * t) +
        noise
      );
    case 1:
      return (
        0.85 * mod(f2, 1.7) * Math.sin(TAU * f2 * t + 0.7) +
        0.35 * mod(f4, 2.3) * Math.sin(TAU * f4 * t + 1.2) +
        0.03 * Math.sin(TAU * 0.07 * t) +
        noise
      );
    default:
      return (
        0.6 * mod(f3, 0.9) * Math.sin(TAU * f3 * t + 1.4) +
        0.3 * mod(f1, 2.9) * Math.sin(TAU * f1 * t + 2.1) +
        0.02 * Math.sin(TAU * 0.09 * t) +
        noise
      );
  }
}

/** Demo bursts identical to the desktop `generate_demo_bursts` formulas. */
export function generateDemoBursts(): Burst[] {
  const baseTimestampNs = BigInt(Date.now()) * 1_000_000n;
  const t = new Float64Array(DVB1_SAMPLE_COUNT);
  for (let i = 0; i < DVB1_SAMPLE_COUNT; i++) t[i] = i / DVB1_SAMPLE_RATE;

  return DEMO_BURST_FREQS.map((hz, burstIndex) => {
    const samples = new Float32Array(DVB1_SAMPLE_COUNT * 3);
    for (let i = 0; i < DVB1_SAMPLE_COUNT; i++) {
      const time = t[i];
      samples[i * 3] = 1.1 * Math.sin(2 * Math.PI * hz * time);
      samples[i * 3 + 1] = 0.8 * Math.sin(2 * Math.PI * hz * 1.5 * time + 0.7);
      samples[i * 3 + 2] = 0.6 * Math.sin(2 * Math.PI * hz * 2.0 * time + 1.4);
    }
    return {
      version: 1,
      axes: 3,
      sampleRate: DVB1_SAMPLE_RATE,
      sampleCount: DVB1_SAMPLE_COUNT,
      timestampNs: baseTimestampNs + BigInt(burstIndex) * 1_000_000_000n,
      sequence: BigInt(burstIndex + 1),
      samples,
    };
  });
}

export interface DemoSourceOptions {
  imuHz: number;
  seed?: number;
}

/**
 * Live synthetic stream generated on an accumulator timer (batched every
 * 20 ms, plan §6.12). Generation pauses when the tab is hidden.
 */
export class DemoSource implements DataSource {
  readonly kind = "demo" as const;
  private readonly handlers: SourceHandlers;
  private readonly imuHz: number;
  private readonly rand: () => number;
  private emitter: BatchEmitter;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextSample = 0;
  private startedAt = 0;
  private seq = 0;
  private running = false;
  private readonly onVisibility = () => {
    if (document.hidden) this.stopTimer();
    else if (this.running) this.startTimer();
  };

  constructor(handlers: SourceHandlers, options: DemoSourceOptions) {
    this.handlers = handlers;
    this.imuHz = options.imuHz;
    this.rand = createLcg(options.seed ?? (Date.now() & 0x7fffffff) | 1);
    this.emitter = new BatchEmitter(Math.max(64, Math.ceil(this.imuHz * 0.05)), handlers);
  }

  async start(): Promise<void> {
    this.running = true;
    this.startedAt = performance.now();
    this.nextSample = 0;
    document.addEventListener("visibilitychange", this.onVisibility);
    this.startTimer();
    this.handlers.onStatus({
      state: "streaming",
      deviceLabel: "Synthetic stream",
      message: "Demo data — not a real device",
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.stopTimer();
    this.emitter.count = 0;
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), DEMO_BATCH_INTERVAL_MS);
    this.tick();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const nowMs = performance.now();
    const elapsed = (nowMs - this.startedAt) / 1000;
    // Accumulator: generate up to one batch interval of samples, catching up
    // after throttled timers without flooding the buffer.
    const target = Math.floor(elapsed * this.imuHz);
    const budget = Math.min(target - this.nextSample, Math.ceil(this.imuHz * 0.1));
    for (let i = 0; i < budget; i++) {
      const t = this.nextSample / this.imuHz;
      const noiseScale = 0.05;
      const x = demoSampleAt(t, 0, (this.rand() - 0.5) * 2 * noiseScale);
      const y = demoSampleAt(t, 1, (this.rand() - 0.5) * 2 * noiseScale);
      const z = demoSampleAt(t, 2, (this.rand() - 0.5) * 2 * noiseScale);
      this.emitter.add(x, y, z, this.seq++);
      this.nextSample += 1;
    }
    this.emitter.flush(nowMs);
  }
}
