// FFT math tests: desktop compute_fft parity (tail cap, mean removal, Hann,
// normalization), Bluestein true-n correctness vs a naive DFT, and the
// 6400-sample file-mode contract.

import { describe, expect, it } from "vitest";
import { computeSpectrum, hanning, isPowerOfTwo, nextPowerOfTwo } from "../../src/core/fft";
import { MAX_FFT_POINTS, MIN_FFT_SAMPLES } from "../../src/core/constants";

function sine(n: number, sampleRate: number, freq: number, amplitude = 1, phase = 0): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate + phase);
  return out;
}

/** O(n²) DFT with the exact desktop pipeline (mean removal, Hann, scaling). */
function naiveSpectrum(x: Float64Array, sampleRate: number): { freqs: Float64Array; amps: Float64Array } {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  const w = hanning(n);
  let windowSum = 0;
  for (let i = 0; i < n; i++) windowSum += w[i];
  const scale = windowSum / n;
  const bins = (n >> 1) + 1;
  const amps = new Float64Array(bins);
  const freqs = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      const v = (x[t] - mean) * w[t];
      const phi = (2 * Math.PI * k * t) / n;
      re += v * Math.cos(phi);
      im -= v * Math.sin(phi);
    }
    amps[k] = Math.hypot(re, im) / n / scale;
    freqs[k] = (k * sampleRate) / n;
  }
  for (let k = 1; k < bins - 1; k++) amps[k] *= 2;
  return { freqs, amps };
}

describe("helpers", () => {
  it("nextPowerOfTwo / isPowerOfTwo", () => {
    expect(nextPowerOfTwo(1)).toBe(1);
    expect(nextPowerOfTwo(5)).toBe(8);
    expect(nextPowerOfTwo(6400)).toBe(8192);
    expect(isPowerOfTwo(512)).toBe(true);
    expect(isPowerOfTwo(6400)).toBe(false);
  });

  it("hanning matches np.hanning endpoints", () => {
    const w = hanning(5);
    expect(w[0]).toBeCloseTo(0, 15);
    expect(w[4]).toBeCloseTo(0, 15);
    expect(w[2]).toBeCloseTo(1, 15);
    expect(w[1]).toBeCloseTo(0.5, 15);
    expect(hanning(1)[0]).toBe(1);
  });
});

describe("computeSpectrum (radix-2 path)", () => {
  it("sine peak lands on the right bin at the right amplitude", () => {
    const n = 512;
    const fs = 1600;
    const { freqs, amps } = computeSpectrum(sine(n, fs, 100, 2), fs);
    const bin = Math.round(100 / (fs / n));
    expect(freqs[bin]).toBeCloseTo(100, 10);
    expect(amps[bin]).toBeCloseTo(2, 4);
    let peak = 0;
    for (let k = 1; k < amps.length; k++) if (amps[k] > amps[peak]) peak = k;
    expect(peak).toBe(bin);
  });

  it("windowed sine amplitude is normalized by the Hann sum", () => {
    const n = 512;
    const { amps } = computeSpectrum(sine(n, 1600, 100, 1), 1600);
    const bin = Math.round(100 / (1600 / n));
    expect(amps[bin]).toBeCloseTo(1, 4);
  });

  it("removes the DC component (constant signal → all zeros)", () => {
    const x = new Float64Array(64).fill(3);
    const { amps } = computeSpectrum(x, 800);
    for (const a of amps) expect(a).toBeLessThan(1e-12);
  });

  it("live mode tail-caps inputs longer than maxLen (desktop tail-512)", () => {
    const long = sine(1024, 1600, 100, 1);
    const capped = computeSpectrum(long, 1600, false, MAX_FFT_POINTS);
    expect(capped.amps.length).toBe(MAX_FFT_POINTS / 2 + 1);
    const bin = Math.round(100 / (1600 / MAX_FFT_POINTS));
    expect(capped.amps[bin]).toBeCloseTo(1, 4);
    const full = computeSpectrum(long, 1600, true);
    expect(full.amps.length).toBe(1024 / 2 + 1);
  });

  it("returns empty spectra below MIN_FFT_SAMPLES or for bad rates", () => {
    const tiny = computeSpectrum(new Float64Array(MIN_FFT_SAMPLES - 1), 800);
    expect(tiny.freqs.length).toBe(0);
    expect(tiny.amps.length).toBe(0);
    expect(computeSpectrum(new Float64Array(64), 0).amps.length).toBe(0);
  });

  it("frequencies span 0..nyquist in fs/n steps", () => {
    const { freqs } = computeSpectrum(sine(512, 1600, 100), 1600);
    expect(freqs[0]).toBe(0);
    expect(freqs[256]).toBeCloseTo(800, 10);
    expect(freqs.length).toBe(257);
  });

  it("accepts Float32Array input (worker transfer path)", () => {
    const x = new Float32Array(sine(512, 1600, 100, 1));
    const { amps } = computeSpectrum(x, 1600);
    const bin = Math.round(100 / (1600 / 512));
    expect(amps[bin]).toBeCloseTo(1, 3);
  });
});

describe("computeSpectrum (Bluestein true-n path)", () => {
  it("matches the naive DFT for a prime length (641)", () => {
    const x = sine(641, 3200, 333.5, 1.7, 0.9);
    const got = computeSpectrum(x, 3200, true);
    const ref = naiveSpectrum(x, 3200);
    for (let k = 0; k < got.amps.length; k++) {
      expect(got.amps[k]).toBeCloseTo(ref.amps[k], 8);
      expect(got.freqs[k]).toBeCloseTo(ref.freqs[k], 10);
    }
  });

  it("matches the naive DFT for the file length 6400 (= 2^8·5^2)", () => {
    const x = sine(6400, 3200, 100, 1);
    const got = computeSpectrum(x, 3200, true);
    const ref = naiveSpectrum(x, 3200);
    for (let k = 0; k <= 400; k++) {
      expect(got.amps[k]).toBeCloseTo(ref.amps[k], 8);
    }
  });

  it("6400 samples at 3200 Hz resolve 0.5 Hz bins with a 100 Hz peak", () => {
    const got = computeSpectrum(sine(6400, 3200, 100, 1), 3200, true);
    expect(got.amps.length).toBe(3201);
    expect(got.freqs[200]).toBeCloseTo(100, 10);
    expect(got.amps[200]).toBeCloseTo(1, 3);
  });

  it("full=false on 6400 samples caps to the tail 512 (live rule)", () => {
    const got = computeSpectrum(sine(6400, 3200, 100, 1), 3200, false, MAX_FFT_POINTS);
    expect(got.amps.length).toBe(257);
  });
});
