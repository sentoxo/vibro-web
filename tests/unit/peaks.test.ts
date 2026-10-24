import { describe, expect, it } from "vitest";
import { findPeaks } from "../../src/core/peaks";

describe("findPeaks (desktop find_fft_peaks parity)", () => {
  const freqs = Array.from({ length: 10 }, (_, i) => i * 10); // 0..90 Hz
  const amps = [5, 0.1, 0.9, 0.5, 0.8, 0.2, 0.7, 0.3, 0.6, 0.4];

  it("returns the top 3 bins by amplitude, strongest first, DC excluded", () => {
    const peaks = findPeaks(freqs, amps);
    expect(peaks).toEqual([
      { frequency: 20, amplitude: 0.9 },
      { frequency: 40, amplitude: 0.8 },
      { frequency: 60, amplitude: 0.7 },
    ]);
  });

  it("excludes the DC bin even when it is the maximum", () => {
    const dcAmps = [100, 0.1, 0.2, 0.3];
    const peaks = findPeaks([0, 10, 20, 30], dcAmps);
    expect(peaks.map((p) => p.frequency)).toEqual([30, 20, 10]);
  });

  it("adjacent bins are not deduplicated (raw top-3 rule)", () => {
    const amps = [0, 1.0, 0.99, 0.98, 0.01];
    const peaks = findPeaks([0, 10, 11, 12, 13], amps);
    expect(peaks.map((p) => p.frequency)).toEqual([10, 11, 12]);
  });

  it("ties select the higher bin indices first (stable argsort + reverse)", () => {
    const amps = [0, 0.5, 0.5, 0.5, 0.5];
    const peaks = findPeaks([0, 10, 20, 30, 40], amps);
    expect(peaks.map((p) => p.frequency)).toEqual([40, 30, 20]);
  });

  it("handles short spectra", () => {
    expect(findPeaks([], [])).toEqual([]);
    expect(findPeaks([0, 1], [1, 2])).toEqual([{ frequency: 1, amplitude: 2 }]);
  });
});
