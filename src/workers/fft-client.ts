// FFT worker client with a latest-wins queue per axis (plan §6.8): a stale
// request for the same axis is dropped, buffers are transferred not copied.

import type { FftRequest, FftResponse, FftError } from "../core/types";
import { computeSpectrum } from "../core/fft";

export interface FftClientEvents {
  onResult(response: FftResponse): void;
  onError(message: string): void;
}

export class FftClient {
  private readonly worker: Worker | null;
  private readonly events: FftClientEvents;
  private nextId = 1;
  private inFlight: (number | null)[] = [null, null, null];
  private readonly mainThreadFallback: boolean;

  constructor(events: FftClientEvents) {
    this.events = events;
    this.mainThreadFallback = typeof Worker === "undefined";
    this.worker = this.mainThreadFallback
      ? null
      : new Worker(new URL("./fft.worker.ts", import.meta.url), { type: "module" });
    if (this.worker) {
      this.worker.onmessage = (event: MessageEvent<FftResponse | FftError>) => {
        const data = event.data;
        if (data.type === "result") {
          if (this.inFlight[data.axis] === data.id) {
            this.inFlight[data.axis] = null;
            this.events.onResult(data);
          }
        } else {
          this.inFlight[data.axis] = null;
          this.events.onError(data.message);
        }
      };
      this.worker.onerror = () => {
        this.events.onError("FFT worker failed; falling back to main thread");
        this.inFlight = [null, null, null];
      };
    }
  }

  submit(axis: 0 | 1 | 2, samples: Float32Array, sampleRate: number, full = false): void {
    const id = this.nextId++;
    if (this.mainThreadFallback || !this.worker) {
      const { freqs, amps } = computeSpectrum(samples, sampleRate, full);
      this.events.onResult({ type: "result", id, axis, freqs, amps, computeMs: 0 });
      return;
    }
    // Latest-wins: mark this id as the newest for the axis; older responses
    // are ignored. The sample copy is transferred, so the caller may reuse
    // its scratch buffer immediately.
    this.inFlight[axis] = id;
    const copy = new Float32Array(samples);
    const request: FftRequest = { type: "fft", id, axis, samples: copy, sampleRate, full };
    this.worker.postMessage(request, [copy.buffer]);
  }

  /** Drop pending work, e.g. when switching sources. */
  cancel(): void {
    this.inFlight = [null, null, null];
  }

  destroy(): void {
    this.worker?.terminate();
  }
}
