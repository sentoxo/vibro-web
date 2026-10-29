// Central app store: reactive UI state in signals, sample buffers as plain
// typed arrays (plan §6.3). Owns the active source, the render loop, FFT
// scheduling and the RMS/peak pipeline.

import { batch, computed, signal, type Signal } from "@preact/signals";
import {
  DEFAULT_FFT_REFRESH_HZ,
  DEMO_LANDING_START_MS,
  MAX_FFT_POINTS,
  MIN_FFT_SAMPLES,
  MIN_SAMPLES_FOR_RENDER,
  PEAK_COUNT,
  RENDER_HZ,
  RMS_STATISTICS_WINDOW_SECONDS,
  SNAPSHOT_SECONDS,
  ZOOM_WINDOW_SECONDS,
} from "../core/constants";
import type { FettecBusStats, FettecCheckSummary, FettecDevice, FettecTelemetry } from "../core/fettec/types";
import type { MspAnalog } from "../core/msp";
import { findPeaks } from "../core/peaks";
import { RingBuffer } from "../core/ring-buffer";
import { meanOf, RmsHistory, rmsZeroCentered, vectorRms } from "../core/stats";
import type {
  Burst,
  ConnectionState,
  Diagnostics,
  Peak,
  RmsStats,
  SampleBatch,
  Settings,
  SourceKind,
  SourceStatus,
} from "../core/types";
import { generateDemoBursts, DemoSource } from "../sources/demo";
import { FileSource, type LoadedFile } from "../sources/file";
import { SerialSource, serialSupported, type SerialSourceHandlers } from "../sources/serial";
import type { DataSource, SourceHandlers } from "../sources/source";
import { FftClient } from "../workers/fft-client";
import { loadSettings, saveSettings, validateSettings } from "./settings";
import { logInfo, logWarn } from "./debugLog";
import { pushToast } from "./toasts";

export interface TimeFrame {
  mode: "live" | "file";
  t: Float64Array; // seconds: oldest sample at t = 0 (desktop rule)
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  n: number;
  imuHz: number;
  axisRms: [number, number, number];
  durationSeconds: number;
}

export interface FftFrame {
  axis: 0 | 1 | 2;
  freqs: Float64Array;
  amps: Float64Array;
  peaks: Peak[];
  yMax: number;
  minHz: number;
  maxHz: number;
  mode: "live" | "file";
}

export type EscMode = "msp" | "fettec";

export interface EscStateSignal {
  connected: boolean;
  running: boolean;
  ramping: boolean;
  power: number;
  rpm: number;
  motorCount: number;
  warningAcknowledged: boolean;
  diagnostic: string;
  error: string | null;
  /** Which ESC path owns the FC port. MSP and passthrough are exclusive. */
  mode: EscMode;
  // FETtec OneWire state (empty in MSP mode).
  devices: FettecDevice[];
  telemetry: FettecTelemetry[];
  /** Per-motor commanded percentages (0-based). */
  targets: number[];
  busStats: FettecBusStats;
  check: FettecCheckSummary | null;
  checkRunning: boolean;
  /** Last MSP_ANALOG snapshot (captured while MSP mode was live). */
  mspAnalog: MspAnalog | null;
  /** True after a background-tab/port watchdog stopped the FETtec link. */
  paused: boolean;
}

const EMPTY_DIAGNOSTICS: Diagnostics = {
  packetRate: 0,
  measuredHz: 0,
  lostPackets: 0,
  seqResets: 0,
  malformedLines: 0,
  lastMalformed: "",
  wireBytesPerSecond: 0,
  avgLineBytes: 0,
  bufferOverruns: 0,
  renderMs: 0,
  fps: 0,
};

const EMPTY_RMS: RmsStats = { current: 0, avg: 0, min: 0, max: 0 };

type TimeFrameListener = (frame: TimeFrame) => void;
type FftFrameListener = (frame: FftFrame) => void;

class Store {
  // === Reactive UI state ===
  readonly screen = signal<"landing" | "dashboard">("landing");
  readonly sourceKind = signal<SourceKind>("demo");
  readonly connection = signal<ConnectionState>("idle");
  readonly deviceLabel = signal("");
  readonly sourceMessage = signal("");
  readonly settings: Signal<Settings> = signal(loadSettings());
  readonly bursts = signal<Burst[]>([]);
  readonly selectedBurst = signal(-1);
  readonly staticMode = signal(false); // file mode or demo-burst mode
  readonly rms = signal<RmsStats>({ ...EMPTY_RMS });
  readonly axisRms = signal<[number, number, number]>([0, 0, 0]);
  readonly peaks = signal<Peak[][]>([[], [], []]);
  readonly diagnostics = signal<Diagnostics>({ ...EMPTY_DIAGNOSTICS });
  readonly esc = signal<EscStateSignal>({
    connected: false,
    running: false,
    ramping: false,
    power: 0,
    rpm: 0,
    motorCount: 0,
    warningAcknowledged: false,
    diagnostic: "FC not connected",
    error: null,
    mode: "msp",
    devices: [],
    telemetry: [],
    targets: [],
    busStats: {
      state: "idle",
      framesSent: 0,
      replies: 0,
      crcErrors: 0,
      timeouts: 0,
      echoFallbacks: 0,
      rxDebug: "",
      loopHz: 0,
      rxBytesPerSecond: 0,
      message: "Not connected",
      updatedAt: 0,
    },
    check: null,
    checkRunning: false,
    mspAnalog: null,
    paused: false,
  });
  readonly spark = signal<number[]>([]);
  readonly paused = signal(false);
  readonly followTime = signal(true);
  readonly followFft = signal(true);
  readonly busy = signal(false);
  // One-time modal warning on the first packet loss (desktop parity).
  readonly lostPacketWarning = signal(false);
  readonly serialSupported = serialSupported();
  readonly isDemo = computed(() => this.sourceKind.peek() === "demo");
  // Live FFT analyses samples acquired at the IMU rate. `fftMaxHz` is only the
  // display band (the chart x-range), never the FFT sample rate.
  readonly liveFftSampleRate = computed(() => this.settings.peek().imuHz);

  // === Non-reactive data plane ===
  private rings: RingBuffer[] = [];
  private snapshotRings: RingBuffer[] = [];
  private readonly scratch = [new Float64Array(8192), new Float64Array(8192), new Float64Array(8192)];
  private readonly scratchT = new Float64Array(8192);
  private readonly fftScratch: Float32Array[] = [
    new Float32Array(1024),
    new Float32Array(1024),
    new Float32Array(1024),
  ];
  private readonly rmsHistory = new RmsHistory(RMS_STATISTICS_WINDOW_SECONDS);
  private lastSeq: number | null = null;
  private source: DataSource | null = null;
  readonly serialSource: SerialSource;
  private readonly fft: FftClient;
  private rafHandle = 0;
  private lastRenderAt = 0;
  private lastFftAt = 0;
  private lastSparkAt = 0;
  private frameCount = 0;
  private fpsWindowStart = 0;
  private renderMsEma = 0;
  private lossToastShown = false;
  private frameListeners: TimeFrameListener[] = [];
  private fftListeners: FftFrameListener[] = [];
  private readonly spectra: { freqs: Float64Array; amps: Float64Array }[] = [
    { freqs: new Float64Array(0), amps: new Float64Array(0) },
    { freqs: new Float64Array(0), amps: new Float64Array(0) },
    { freqs: new Float64Array(0), amps: new Float64Array(0) },
  ];
  private readonly fftYMaxes = [2, 2, 2];
  private burstCache = new Map<number, { frame: TimeFrame }>();
  private latestTimeFrame: TimeFrame | null = null;

  constructor() {
    const settings = this.settings.peek();
    this.initBuffers(settings);
    const handlers: SerialSourceHandlers = {
      onSamples: (batchData) => this.ingest(batchData),
      onStatus: (status) => this.applyStatus(status),
      onDiagnostics: (patch) => {
        this.diagnostics.value = { ...this.diagnostics.peek(), ...patch };
      },
      onFirstPacketLoss: () => this.notifyPacketLoss(),
    };
    this.serialSource = new SerialSource(handlers, () => this.settings.peek());
    this.fft = new FftClient({
      onResult: (result) => this.handleFftResult(result),
      onError: (message) => {
        pushToast({ kind: "warn", title: "FFT", message, dedupeKey: "fft-worker" });
      },
    });
  }

  private initBuffers(settings: Settings): void {
    const ringSize = Math.max(64, Math.ceil(settings.imuHz * settings.windowSeconds));
    const snapshotSize = Math.max(64, Math.ceil(settings.imuHz * SNAPSHOT_SECONDS));
    this.rings = [new RingBuffer(ringSize), new RingBuffer(ringSize), new RingBuffer(ringSize)];
    this.snapshotRings = [new RingBuffer(snapshotSize), new RingBuffer(snapshotSize), new RingBuffer(snapshotSize)];
  }

  // === Source lifecycle ===

  private sourceHandlers(): SourceHandlers {
    return {
      onSamples: (batchData) => this.ingest(batchData),
      onStatus: (status) => this.applyStatus(status),
    };
  }

  private async stopCurrentSource(): Promise<void> {
    if (this.source) {
      await this.source.stop().catch(() => {});
      this.source = null;
    }
    this.fft.cancel();
    this.stopRenderLoop();
  }

  private clearData(resetStats: boolean): void {
    for (const ring of this.rings) ring.clear();
    for (const ring of this.snapshotRings) ring.clear();
    this.rmsHistory.clear();
    this.lastSeq = null;
    this.peaks.value = [[], [], []];
    this.axisRms.value = [0, 0, 0];
    this.rms.value = { ...EMPTY_RMS };
    this.spark.value = [];
    for (let axis = 0; axis < 3; axis++) {
      this.spectra[axis] = { freqs: new Float64Array(0), amps: new Float64Array(0) };
      this.fftYMaxes[axis] = 2;
    }
    this.burstCache.clear();
    this.latestTimeFrame = null;
    if (resetStats) {
      this.diagnostics.value = { ...EMPTY_DIAGNOSTICS };
      this.lossToastShown = false;
    }
  }

  async startDemo(seed?: number, navigate = true): Promise<void> {
    await this.stopCurrentSource();
    this.clearData(true);
    this.paused.value = false;
    this.staticMode.value = false;
    this.bursts.value = [];
    this.selectedBurst.value = -1;
    this.sourceKind.value = "demo";
    if (navigate) this.screen.value = "dashboard";
    const demo = new DemoSource(this.sourceHandlers(), {
      imuHz: this.settings.peek().imuHz,
      seed,
    });
    this.source = demo;
    this.startRenderLoop();
    logInfo("demo", `demo stream started${seed != null ? ` (seed ${seed})` : ""}`);
    await demo.start();
  }

  async showDemoBursts(): Promise<void> {
    await this.stopCurrentSource();
    logInfo("demo", "static demo bursts loaded");
    this.clearData(true);
    this.sourceKind.value = "demo";
    this.staticMode.value = true;
    this.screen.value = "dashboard";
    this.deviceLabel.value = "Demo bursts";
    this.sourceMessage.value = "Synthetic demo bursts";
    this.connection.value = "streaming";
    this.bursts.value = generateDemoBursts();
    this.selectedBurst.value = 0;
    this.selectBurst(0);
  }

  async openFile(file: File): Promise<LoadedFile> {
    this.busy.value = true;
    try {
      const source = new FileSource(this.sourceHandlers(), file);
      const loaded = await source.start();
      await this.stopCurrentSource();
      this.clearData(true);
      this.sourceKind.value = "file";
      this.staticMode.value = true;
      this.screen.value = "dashboard";
      this.bursts.value = loaded.bursts;
      this.selectedBurst.value = 0;
      if (loaded.skipped > 0) {
        pushToast({
          kind: "warn",
          title: "File parsed",
          message: `${loaded.skipped} invalid burst(s) skipped`,
        });
      }
      this.selectBurst(0);
      logInfo("file", `opened ${file.name} (${file.size} B): ${loaded.bursts.length} bursts, ${loaded.skipped} skipped`);
      return loaded;
    } finally {
      this.busy.value = false;
    }
  }

  async connectSerial(port: SerialPort): Promise<void> {
    if (this.source && this.sourceKind.peek() !== "serial") {
      await this.stopCurrentSource();
      this.clearData(true);
    }
    this.sourceKind.value = "serial";
    this.staticMode.value = false;
    this.screen.value = "dashboard";
    this.connection.value = "connecting";
    this.paused.value = false;
    // A new session must not inherit the previous session's loss warning.
    this.lostPacketWarning.value = false;
    logInfo("serial", "connecting sensor port (new session: counters reset, seq re-baselined)");
    this.clearData(true);
    this.source = this.serialSource;
    this.startRenderLoop();
    this.serialSource.usePort(port);
  }

  async disconnectSerial(): Promise<void> {
    logInfo("serial", "disconnect requested");
    await this.serialSource.stop();
    this.stopRenderLoop();
    this.source = null;
    this.paused.value = false;
    this.lostPacketWarning.value = false;
    this.connection.value = "idle";
    this.sourceMessage.value = "Disconnected";
  }

  async goLanding(): Promise<void> {
    await this.stopCurrentSource();
    this.clearData(true);
    this.paused.value = false;
    this.connection.value = "idle";
    this.staticMode.value = false;
    this.bursts.value = [];
    this.selectedBurst.value = -1;
    this.screen.value = "landing";
  }

  private applyStatus(status: SourceStatus): void {
    const previous = this.connection.peek();
    if (previous !== status.state) {
      logInfo("serial", `connection: ${previous} → ${status.state}${status.message ? ` (${status.message})` : ""}`);
    }
    this.connection.value = status.state;
    if (status.deviceLabel) this.deviceLabel.value = status.deviceLabel;
    this.sourceMessage.value = status.message;
    if (status.state === "error") {
      pushToast({ kind: "error", title: "Connection", message: status.message });
    }
  }

  // === Settings ===

  patchSettings(patch: Partial<Settings>): void {
    const merged = validateSettings({ ...this.settings.peek(), ...patch });
    const previous = this.settings.peek();
    this.settings.value = merged;
    saveSettings(merged);

    if (merged.imuHz !== previous.imuHz || merged.windowSeconds !== previous.windowSeconds) {
      const ringSize = Math.max(64, Math.ceil(merged.imuHz * merged.windowSeconds));
      const snapshotSize = Math.max(64, Math.ceil(merged.imuHz * SNAPSHOT_SECONDS));
      for (const ring of this.rings) ring.resize(ringSize);
      for (const ring of this.snapshotRings) ring.resize(snapshotSize);
      // The demo stream synthesizes at imuHz; restart to re-rate it.
      if (this.sourceKind.peek() === "demo" && !this.staticMode.peek()) {
        void this.startDemo();
      }
    }
  }

  resetSettings(): void {
    const defaults = validateSettings(null);
    this.settings.value = defaults;
    saveSettings(defaults);
  }

  // === Ingest ===

  ingest = (batchData: SampleBatch): void => {
    const { x, y, z, seqs, count } = batchData;
    for (let i = 0; i < count; i++) {
      this.rings[0].push(x[i]);
      this.rings[1].push(y[i]);
      this.rings[2].push(z[i]);
      this.snapshotRings[0].push(x[i]);
      this.snapshotRings[1].push(y[i]);
      this.snapshotRings[2].push(z[i]);
    }
    if (count > 0) this.lastSeq = seqs[count - 1];
  };

  // === Render loop ===

  private renderHz(): number {
    const refresh = this.settings.peek().fftRefreshHz || DEFAULT_FFT_REFRESH_HZ;
    return Math.min(30, Math.max(1, refresh));
  }

  private startRenderLoop(): void {
    this.stopRenderLoop();
    this.fpsWindowStart = performance.now();
    this.frameCount = 0;
    const loop = (now: number) => {
      this.rafHandle = requestAnimationFrame(loop);
      const intervalMs = 1000 / this.renderHz();
      if (now - this.lastRenderAt >= intervalMs) {
        const started = performance.now();
        this.lastRenderAt = now;
        if (!this.paused.peek()) this.renderLive(now);
        this.renderMsEma = this.renderMsEma * 0.9 + (performance.now() - started) * 0.1;
        this.frameCount += 1;
        if (now - this.fpsWindowStart >= 1000) {
          const fps = (this.frameCount * 1000) / (now - this.fpsWindowStart);
          this.frameCount = 0;
          this.fpsWindowStart = now;
          this.diagnostics.value = {
            ...this.diagnostics.peek(),
            fps: Math.round(fps),
            renderMs: Math.round(this.renderMsEma * 100) / 100,
          };
        }
      }
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  private stopRenderLoop(): void {
    if (this.rafHandle !== 0) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private renderLive(now: number): void {
    const settings = this.settings.peek();
    const n = Math.min(this.rings[0].length, Math.ceil(settings.windowSeconds * settings.imuHz));
    if (n < MIN_SAMPLES_FOR_RENDER) return;

    const axisRms: [number, number, number] = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      const buf = this.scratch[axis];
      this.rings[axis].copyLast(n, buf);
      const mean = meanOf(buf, n);
      for (let i = 0; i < n; i++) buf[i] -= mean;
      axisRms[axis] = rmsZeroCentered(buf, n);
    }
    // Desktop time axis: oldest sample at t = 0, newest at (n-1)/imuHz; the
    // chart window is fixed at 0..windowSeconds and scrolls with the stream.
    const t = this.scratchT;
    for (let i = 0; i < n; i++) t[i] = i / settings.imuHz;

    const rmsTotal = vectorRms(axisRms[0], axisRms[1], axisRms[2]);
    this.rmsHistory.push(now, rmsTotal);
    const stats = this.rmsHistory.avgMinMax();

    // Throttled signal updates (10 Hz), not per sample.
    batch(() => {
      this.rms.value = { current: rmsTotal, avg: stats.avg, min: stats.min, max: stats.max };
      this.axisRms.value = axisRms;
    });

    if (now - this.lastSparkAt >= 250) {
      this.lastSparkAt = now;
      this.spark.value = this.rmsHistory.series(60);
    }

    const frame: TimeFrame = {
      mode: "live",
      t,
      x: this.scratch[0],
      y: this.scratch[1],
      z: this.scratch[2],
      n,
      imuHz: settings.imuHz,
      axisRms,
      durationSeconds: n / settings.imuHz,
    };
    this.latestTimeFrame = frame;
    for (const listener of this.frameListeners) listener(frame);

    // FFT scheduling at the configured refresh rate. The frequency axis must
    // use the rate the samples were actually acquired at (imuHz); `fftMaxHz`
    // only zooms the chart. Labelling the axis with 2 × fftMaxHz rescaled
    // every peak whenever the setting changed. The worker caps live FFTs at
    // the last 512 samples of the window (MAX_FFT_POINTS).
    const fftInterval = 1000 / Math.max(0.5, settings.fftRefreshHz);
    if (now - this.lastFftAt >= fftInterval) {
      this.lastFftAt = now;
      const fftN = Math.min(n, MAX_FFT_POINTS);
      if (fftN >= MIN_FFT_SAMPLES) {
        const liveFftRate = settings.imuHz;
        for (let axis = 0; axis < 3; axis++) {
          const out = this.fftScratch[axis];
          const src = this.scratch[axis];
          for (let i = 0; i < fftN; i++) out[i] = src[n - fftN + i];
          this.fft.submit(axis as 0 | 1 | 2, out.subarray(0, fftN), liveFftRate, false);
        }
      }
    }
  }

  // === Static (file / demo-burst) mode ===

  selectBurst(index: number): void {
    const bursts = this.bursts.peek();
    if (index < 0 || index >= bursts.length) return;
    this.selectedBurst.value = index;
    const burst = bursts[index];

    const cached = this.burstCache.get(index);
    if (cached) {
      this.latestTimeFrame = cached.frame;
      for (const listener of this.frameListeners) listener(cached.frame);
      // Desktop clears the FFT cache on burst display: peak labels read "--"
      // until the recomputed spectra arrive.
      this.peaks.value = [[], [], []];
      this.resetSpectra();
      const stats = this.rmsHistory.avgMinMax();
      const rmsTotal = cached.frame.axisRms;
      const vector = vectorRms(rmsTotal[0], rmsTotal[1], rmsTotal[2]);
      this.rms.value = {
        current: vector,
        avg: stats.avg || vector,
        min: stats.min || vector,
        max: stats.max || vector,
      };
      this.axisRms.value = rmsTotal;
      this.rmsHistory.clear();
      this.rmsHistory.push(performance.now(), vector);
      for (let axis = 0; axis < 3; axis++) {
        const samples = new Float32Array(cached.frame.n);
        samples.set(cached.frame.x.subarray(0, cached.frame.n));
        this.fft.submit(axis as 0 | 1 | 2, samples, cached.frame.imuHz, true);
      }
      return;
    }

    const count = burst.sampleCount;
    const rate = burst.sampleRate;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    const z = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      x[i] = burst.samples[i * 3];
      y[i] = burst.samples[i * 3 + 1];
      z[i] = burst.samples[i * 3 + 2];
    }
    // Remove gravity per axis (desktop `remove_gravity_component`).
    const axisArrays = [x, y, z];
    const axisRms: [number, number, number] = [0, 0, 0];
    const t = new Float64Array(count);
    for (let axis = 0; axis < 3; axis++) {
      const data = axisArrays[axis];
      const mean = meanOf(data, count);
      for (let i = 0; i < count; i++) data[i] -= mean;
      axisRms[axis] = rmsZeroCentered(data, count);
    }
    for (let i = 0; i < count; i++) t[i] = i / rate;

    const rmsTotal = vectorRms(axisRms[0], axisRms[1], axisRms[2]);
    this.rmsHistory.clear();
    this.rmsHistory.push(performance.now(), rmsTotal);
    this.rms.value = { current: rmsTotal, avg: rmsTotal, min: rmsTotal, max: rmsTotal };
    this.axisRms.value = axisRms;
    this.spark.value = [rmsTotal];

    const frame: TimeFrame = {
      mode: "file",
      t,
      x,
      y,
      z,
      n: count,
      imuHz: rate,
      axisRms,
      durationSeconds: count / rate,
    };
    this.latestTimeFrame = frame;
    for (const listener of this.frameListeners) listener(frame);

    // Full-burst FFT: complete length, burst sample rate (desktop `full=True`).
    this.fft.cancel();
    this.peaks.value = [[], [], []];
    this.resetSpectra();
    for (let axis = 0; axis < 3; axis++) {
      const samples = new Float32Array(count);
      samples.set(axisArrays[axis]);
      this.fft.submit(axis as 0 | 1 | 2, samples, rate, true);
    }
    // Cache the time frame; peaks arrive with the FFT results.
    this.burstCache.set(index, { frame });
  }

  /** Desktop parity: `fft_cache = [None, None, None]` on burst change. */
  private resetSpectra(): void {
    for (let axis = 0; axis < 3; axis++) {
      this.spectra[axis] = { freqs: new Float64Array(0), amps: new Float64Array(0) };
    }
  }

  // === FFT results ===

  private handleFftResult(result: { axis: 0 | 1 | 2; freqs: Float64Array; amps: Float64Array }): void {
    const { axis, freqs, amps } = result;
    this.spectra[axis] = { freqs, amps };
    this.fftYMaxes[axis] = computeFftYMax(amps);

    // Desktop `handle_fft_result`: all three peak labels recompute from the
    // FFT cache on every result; axes with no spectrum yet show "--".
    const peaksByAxis: Peak[][] = [[], [], []];
    for (let a = 0; a < 3; a++) {
      const s = this.spectra[a];
      peaksByAxis[a] = s.amps.length > 1 ? findPeaks(s.freqs, s.amps) : [];
    }
    this.peaks.value = peaksByAxis;

    const mode = this.staticMode.peek() ? "file" : "live";
    this.emitFftFrame(axis, mode);
  }

  private emitFftFrame(axis: 0 | 1 | 2, mode: "live" | "file"): void {
    const settings = this.settings.peek();
    const { freqs, amps } = this.spectra[axis];
    // The chart never shows more than the spectrum's real Nyquist
    // (imuHz / 2 live, burst rate / 2 for files): above it there are no bins,
    // and stretching the axis there was what mislabelled every peak.
    const nyquist = freqs.length > 0 ? freqs[freqs.length - 1] : settings.fftMaxHz;
    const frame: FftFrame = {
      axis,
      freqs,
      amps,
      peaks: this.peaks.peek()[axis],
      yMax: this.fftYMaxes[axis],
      minHz: 4,
      maxHz: Math.min(settings.fftMaxHz, nyquist),
      mode,
    };
    for (const listener of this.fftListeners) listener(frame);
  }

  // === Frame subscriptions (charts) ===

  onTimeFrame(listener: TimeFrameListener): () => void {
    this.frameListeners.push(listener);
    return () => {
      this.frameListeners = this.frameListeners.filter((l) => l !== listener);
    };
  }

  onFftFrame(listener: FftFrameListener): () => void {
    this.fftListeners.push(listener);
    return () => {
      this.fftListeners = this.fftListeners.filter((l) => l !== listener);
    };
  }

  /** Current data for PNG export and the "Live" snap-back. */
  getTimeFrame(): TimeFrame | null {
    return this.latestTimeFrame;
  }

  getSpectrum(axis: number): { freqs: Float64Array; amps: Float64Array } {
    return this.spectra[axis];
  }

  // === Warnings ===

  private notifyPacketLoss(): void {
    if (this.lossToastShown) return;
    this.lossToastShown = true;
    logWarn("serial", "packet loss: sequence gap detected (loss modal armed)");
    // Desktop shows a modal popup once per session and keeps running.
    this.lostPacketWarning.value = true;
  }

  // === Export data ===

  snapshotData(): {
    samples: Float32Array; // interleaved m/s²
    sampleRate: number;
    timestampNs: bigint;
    sequence: bigint;
  } {
    const settings = this.settings.peek();
    if (this.staticMode.peek()) {
      if (this.sourceKind.peek() === "demo") {
        // Desktop parity: demo mode has no live snapshot buffer, so saving a
        // snapshot always reports the "waiting for data" error there.
        throw new Error("Waiting for 2 seconds of data (0.0 seconds available)");
      }
      const burst = this.bursts.peek()[this.selectedBurst.value];
      if (!burst) throw new Error("No burst is loaded");
      const rate = burst.sampleRate;
      const sampleCount = Math.round(rate * SNAPSHOT_SECONDS);
      if (burst.sampleCount < sampleCount) {
        throw new Error("The selected burst contains less than 2 seconds of data");
      }
      const samples = new Float32Array(sampleCount * 3);
      const startSample = burst.sampleCount - sampleCount;
      samples.set(burst.samples.subarray(startSample * 3, burst.sampleCount * 3));
      const skipped = burst.sampleCount - sampleCount;
      const timestampNs = burst.timestampNs + BigInt(Math.round((skipped / rate) * 1e9));
      return { samples, sampleRate: rate, timestampNs, sequence: burst.sequence };
    }

    const sampleRate = settings.imuHz;
    const sampleCount = Math.round(sampleRate * SNAPSHOT_SECONDS);
    const available = this.snapshotRings[0].length;
    if (available < sampleCount) {
      throw new Error(`Waiting for 2 seconds of data (${(available / sampleRate).toFixed(1)} seconds available)`);
    }
    const samples = new Float32Array(sampleCount * 3);
    const out = new Float64Array(sampleCount);
    for (let axis = 0; axis < 3; axis++) {
      this.snapshotRings[axis].copyLast(sampleCount, out); // raw, gravity included
      for (let i = 0; i < sampleCount; i++) samples[i * 3 + axis] = out[i];
    }
    const timestampNs = BigInt(Date.now()) * 1_000_000n - BigInt(SNAPSHOT_SECONDS * 1e9);
    return {
      samples,
      sampleRate,
      timestampNs,
      sequence: BigInt(this.lastSeq ?? 0),
    };
  }

  // === ESC shared state ===

  patchEsc(patch: Partial<EscStateSignal>): void {
    this.esc.value = { ...this.esc.peek(), ...patch };
  }

  get motorRpmHz(): number {
    const esc = this.esc.peek();
    if (esc.mode !== "fettec") return esc.rpm / 60;
    // A self-diagnosing channel (no motor) has no real eRPM measurement (0 or
    // coded values), so it must not dilute the mean — with one 4450 rpm motor
    // on a 4-channel 4in1 the mean divided the marker frequency by 4
    // (4450/4/60 = 18.5 Hz lines instead of 74 Hz).
    const healthy = (index: number) => esc.devices.find((device) => device.index === index)?.problem == null;
    const source = this.settings.peek().fettecRpmMotor;
    if (source > 0) {
      return (healthy(source - 1) ? (esc.telemetry[source - 1]?.rpm ?? 0) : 0) / 60;
    }
    const rpms = esc.telemetry
      .map((entry) => (healthy(entry.escIndex) ? entry.rpm : null))
      .filter((rpm): rpm is number => rpm !== null);
    if (rpms.length === 0) return 0;
    return rpms.reduce((sum, rpm) => sum + rpm, 0) / rpms.length / 60;
  }

  // === Lifecycle ===

  scheduleLandingDemo(): void {
    if (!this.settings.peek().autoplayDemo) return;
    if (this.screen.peek() !== "landing") return;
    setTimeout(() => {
      if (this.screen.peek() === "landing") void this.startDemo(undefined, false);
    }, DEMO_LANDING_START_MS);
  }

  destroy(): void {
    this.stopRenderLoop();
    void this.source?.stop();
    this.fft.destroy();
  }
}

/** Dynamic FFT Y scaling: 1/2/3/4/5/6/8/10 × 10^n, minimum 2.0 (desktop rule). */
export function computeFftYMax(amps: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < amps.length; i++) if (amps[i] > peak) peak = amps[i];
  let yMax = 2.0;
  if (peak > yMax) {
    const magnitude = 10 ** Math.floor(Math.log10(peak));
    for (const step of [1, 2, 3, 4, 5, 6, 8, 10]) {
      if (step * magnitude >= peak) {
        yMax = step * magnitude;
        break;
      }
    }
  }
  return yMax;
}

export const store = new Store();

export { PEAK_COUNT, ZOOM_WINDOW_SECONDS, RENDER_HZ };
