// FFT math matching the desktop `fft_worker.compute_fft` exactly:
//   n = full length, or the LAST MAX_FFT_POINTS samples in live mode
//   sig = x - mean; window = hann(n); scale = sum(w)/n
//   amp = |rfft(sig*w)| / n / scale, interior bins doubled
// Frequencies are k*fs/n over n/2+1 bins. n = 512 (live) is a power of two
// (radix-2); full-burst lengths like 6400 = 2^8·5^2 are NOT powers of two,
// so they go through Bluestein's chirp-z transform, which evaluates the
// exact DFT at n bins via a power-of-two convolution (matches np.fft.rfft
// to ~1e-12 relative; plan golden tolerance is 1e-6).

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Iterative in-place Cooley–Tukey radix-2 FFT. `re.length` must be a power of two. */
export function fftInPlace(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n <= 1) return; // n = 1: forward and inverse are both the identity
  if (!isPowerOfTwo(n)) throw new RangeError("FFT length must be a power of two");

  // Inverse via the conjugate trick: IFFT(Y) = conj(FFT(conj(Y)))/n.
  if (inverse) for (let i = 0; i < n; i++) im[i] = -im[i];

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const aIdx = i + k;
        const bIdx = i + k + half;
        const uRe = re[aIdx];
        const uIm = im[aIdx];
        const vRe = re[bIdx] * curRe - im[bIdx] * curIm;
        const vIm = re[bIdx] * curIm + im[bIdx] * curRe;
        re[aIdx] = uRe + vRe;
        im[aIdx] = uIm + vIm;
        re[bIdx] = uRe - vRe;
        im[bIdx] = uIm - vIm;
        const nextRe = curRe * wlenRe - curIm * wlenIm;
        curIm = curRe * wlenIm + curIm * wlenRe;
        curRe = nextRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= -n; // conj of the result
    }
  }
}

/** Hann window matching `np.hanning(n)`: 0.5 - 0.5·cos(2πi/(n-1)). */
export function hanning(n: number): Float64Array {
  const w = new Float64Array(n);
  if (n === 1) {
    w[0] = 1;
    return w;
  }
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

export interface Spectrum {
  freqs: Float64Array;
  amps: Float64Array;
}

const EMPTY_SPECTRUM: Spectrum = { freqs: new Float64Array(0), amps: new Float64Array(0) };

/** exp(-i·π·m²/n) computed with the phase reduced mod 2n (keeps precision). */
function chirp(m: number, n: number): [number, number] {
  // m² mod 2n, done in integer-safe steps for m,n ≤ 2^26.
  const twoN = 2 * n;
  const mMod = m % twoN;
  const m2 = (mMod * mMod) % twoN;
  const phase = (-Math.PI * m2) / n;
  return [Math.cos(phase), Math.sin(phase)];
}

/**
 * Complex DFT of `re`/`im` (length n, not a power of two) at the first
 * `bins` frequency bins, via Bluestein chirp-z. Writes into `outRe`/`outIm`.
 */
function dftBinsBluestein(
  re: Float64Array,
  im: Float64Array,
  n: number,
  bins: number,
  outRe: Float64Array,
  outIm: Float64Array,
): void {
  const size = nextPowerOfTwo(2 * n - 1);
  const aRe = new Float64Array(size);
  const aIm = new Float64Array(size);
  const bRe = new Float64Array(size);
  const bIm = new Float64Array(size);

  for (let m = 0; m < n; m++) {
    const [wRe, wIm] = chirp(m, n); // e^{-iπm²/n}
    aRe[m] = re[m] * wRe - im[m] * wIm;
    aIm[m] = re[m] * wIm + im[m] * wRe;
    // b[m] = e^{+iπm²/n}; symmetric: b[m] = b[size-m] (h[-m] = h[m]).
    bRe[m] = wRe;
    bIm[m] = -wIm;
    if (m > 0) {
      bRe[size - m] = wRe;
      bIm[size - m] = -wIm;
    }
  }

  fftInPlace(aRe, aIm);
  fftInPlace(bRe, bIm);
  for (let i = 0; i < size; i++) {
    const tRe = aRe[i] * bRe[i] - aIm[i] * bIm[i];
    const tIm = aRe[i] * bIm[i] + aIm[i] * bRe[i];
    aRe[i] = tRe;
    aIm[i] = tIm;
  }
  fftInPlace(aRe, aIm, true); // inverse (fftInPlace divides by n and conjugates)

  for (let k = 0; k < bins; k++) {
    const [wRe, wIm] = chirp(k, n);
    outRe[k] = aRe[k] * wRe - aIm[k] * wIm;
    outIm[k] = aRe[k] * wIm + aIm[k] * wRe;
  }
}

/**
 * Amplitude spectrum in m/s², desktop `compute_fft` parity.
 *
 * @param samples signal samples (m/s²); live mode uses the last `maxLen`
 * @param sampleRate data rate for the frequency axis: live mode uses the
 *   desktop `live_sample_rate` = 2 × fftMaxHz; file mode uses the burst rate
 * @param full keep the whole signal (file mode); otherwise cap at `maxLen`
 */
export function computeSpectrum(samples: ArrayLike<number>, sampleRate: number, full = false, maxLen = 512): Spectrum {
  const total = samples.length;
  let offset = 0;
  let n = total;
  if (!full && n > maxLen) {
    offset = total - maxLen;
    n = maxLen;
  }
  if (n < 64 || sampleRate <= 0) return EMPTY_SPECTRUM;

  // Remove the DC/gravity component.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[offset + i];
  mean /= n;

  const window = hanning(n);
  let windowSum = 0;
  for (let i = 0; i < n; i++) windowSum += window[i];
  const scale = windowSum / n;

  const bins = (n >> 1) + 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (samples[offset + i] - mean) * window[i];

  const specRe = new Float64Array(bins);
  const specIm = new Float64Array(bins);
  if (isPowerOfTwo(n)) {
    // Radix-2 is in-place, so transform copies of the windowed signal.
    const fullRe = new Float64Array(re);
    const fullIm = new Float64Array(im);
    fftInPlace(fullRe, fullIm);
    specRe.set(fullRe.subarray(0, bins));
    specIm.set(fullIm.subarray(0, bins));
  } else {
    dftBinsBluestein(re, im, n, bins, specRe, specIm);
  }

  const freqs = new Float64Array(bins);
  const amps = new Float64Array(bins);
  const freqStep = sampleRate / n;
  for (let k = 0; k < bins; k++) {
    freqs[k] = k * freqStep;
    amps[k] = Math.hypot(specRe[k], specIm[k]) / n / scale;
  }
  // Double interior bins (single-sided → peak amplitude); DC and Nyquist stay.
  for (let k = 1; k < bins - 1; k++) amps[k] *= 2;
  return { freqs, amps };
}
