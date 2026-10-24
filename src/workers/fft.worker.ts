/// <reference lib="webworker" />
// FFT worker: computes spectra off the main thread. Buffers arrive and
// results leave as transferables (no SharedArrayBuffer, plan §3.2).

import { computeSpectrum } from "../core/fft";
import type { FftError, FftRequest, FftResponse } from "../core/types";

self.onmessage = (event: MessageEvent<FftRequest>) => {
  const request = event.data;
  if (request?.type !== "fft") return;
  const started = performance.now();
  try {
    const { freqs, amps } = computeSpectrum(request.samples, request.sampleRate, request.full);
    const response: FftResponse = {
      type: "result",
      id: request.id,
      axis: request.axis,
      freqs,
      amps,
      computeMs: performance.now() - started,
    };
    (self as unknown as Worker).postMessage(response, [freqs.buffer, amps.buffer]);
  } catch (error) {
    const failure: FftError = {
      type: "error",
      id: request.id,
      axis: request.axis,
      message: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(failure);
  }
};
