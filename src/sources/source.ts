// Source abstraction (plan §6.5). The store owns exactly one active source;
// sources push sample batches and status changes through handlers.

import type { SampleBatch, SourceKind, SourceStatus } from "../core/types";

export interface SourceHandlers {
  onSamples(batch: SampleBatch): void;
  onStatus(status: SourceStatus): void;
}

export interface DataSource {
  readonly kind: SourceKind;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Scratch-buffer batch producer shared by streaming sources. */
export class BatchEmitter {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly seqs: Int32Array;
  count = 0;
  private readonly handlers: SourceHandlers;

  constructor(capacity: number, handlers: SourceHandlers) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.seqs = new Int32Array(capacity);
    this.handlers = handlers;
  }

  add(x: number, y: number, z: number, seq: number): boolean {
    if (this.count >= this.x.length) {
      this.flush();
      return false;
    }
    this.x[this.count] = x;
    this.y[this.count] = y;
    this.z[this.count] = z;
    this.seqs[this.count] = seq;
    this.count += 1;
    return true;
  }

  flush(nowMs = performance.now()): void {
    if (this.count === 0) return;
    this.handlers.onSamples({
      x: this.x,
      y: this.y,
      z: this.z,
      seqs: this.seqs,
      count: this.count,
      tMs: nowMs,
    });
    this.count = 0;
  }
}
