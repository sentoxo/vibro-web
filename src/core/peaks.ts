// Dominant FFT peaks, desktop `app.find_fft_peaks` parity: the top 3 raw
// bins by amplitude over indices 1..N-1 (DC excluded), returned strongest
// first. No minimum amplitude and no bin-separation rule — adjacent bins of
// one spectral lobe may appear as separate peaks, exactly like the desktop.

import { PEAK_COUNT } from "./constants";
import type { Peak } from "./types";

export function findPeaks(freqs: ArrayLike<number>, amps: ArrayLike<number>, maxPeaks = PEAK_COUNT): Peak[] {
  const n = amps.length;
  if (n < 2) return [];

  // Stable ascending sort by amplitude (ties by ascending index, matching
  // np.argsort(kind="stable")), take the last `maxPeaks`, reverse: strongest
  // first, ties by descending index — byte-for-byte the desktop selection.
  const indices: number[] = [];
  for (let k = 1; k < n; k++) indices.push(k);
  indices.sort((a, b) => amps[a] - amps[b] || a - b);

  const peaks: Peak[] = [];
  for (let i = indices.length - 1; i >= 0 && peaks.length < maxPeaks; i--) {
    const k = indices[i];
    peaks.push({ frequency: freqs[k], amplitude: amps[k] });
  }
  return peaks;
}
