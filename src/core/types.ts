// Shared data model types (plan §6.3).

export type SourceKind = "demo" | "file" | "serial";

export type ConnectionState = "idle" | "requesting" | "connecting" | "streaming" | "reconnecting" | "error";

export interface Sample {
  sid: number;
  seq: number;
  x: number; // m/s²
  y: number;
  z: number;
  t: number; // performance.now() at ingest (ms)
}

export interface Settings {
  imuHz: number; // 800 | 1000 | 1600 | 2000 | 3200 | 4000 (time charts + snapshot)
  fftMaxHz: number; // live FFT Nyquist; live FFT runs at 2 × fftMaxHz (desktop rule)
  fftRefreshHz: number; // 0.5 .. 60, applied floor 1.0
  lsbPerG: number; // 256 | 2048
  windowSeconds: number; // 2.0 | 0.2
  autoReconnect: boolean;
  saveMode: "download" | "folder";
  escMotorChannel: number; // 1..16
  autoplayDemo: boolean;
  // FETtec OneWire over Betaflight passthrough.
  fettecEscCount: number; // 1..8
  fettecIdBase: number; // first OneWire ID (1..24)
  fettecPoles: number; // motor poles (2..64)
  fettecEscBaud: number; // 115200 | 500000 | 2000000
  fettecCliLine: string; // "" = generated from the baud rate
  fettecAutoReboot: boolean; // drop DTR on disconnect (FC reboot)
  fettecCheckPower: number; // % used by the signal check
  fettecRpmMotor: number; // 0 = mean of all ESCs, 1..8 = one motor
  fettecScaleTemp: number;
  fettecScaleVoltage: number;
  fettecScaleCurrent: number;
  fettecScaleErpm: number;
  fettecScaleConsumption: number;
}

export interface Burst {
  version: number;
  axes: number;
  sampleRate: number;
  sampleCount: number;
  timestampNs: bigint;
  sequence: bigint;
  samples: Float32Array; // interleaved x,y,z, m/s² (length = count * 3)
}

export interface Peak {
  frequency: number;
  amplitude: number;
}

export interface RmsStats {
  current: number;
  avg: number;
  min: number;
  max: number;
}

export interface EscState {
  connected: boolean;
  running: boolean;
  power: number; // %
  rpm: number;
  motorCount: number;
  lastDiagnostic: string;
  error: string | null;
}

export interface SourceStatus {
  state: ConnectionState;
  deviceLabel: string;
  message: string;
}

// A batch of raw (gravity-included) m/s² samples produced by a source.
// The buffers are reused per batch by the producer; the store copies out.
export interface SampleBatch {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  seqs: Int32Array;
  count: number;
  tMs: number; // performance.now() at receive
}

export interface Diagnostics {
  packetRate: number; // packets/s over the 1 s window
  measuredHz: number; // sid==0 samples/s, smoothed
  lostPackets: number;
  seqResets: number;
  malformedLines: number;
  lastMalformed: string;
  wireBytesPerSecond: number; // measured payload throughput (bytes/s)
  avgLineBytes: number;
  bufferOverruns: number;
  renderMs: number;
  fps: number;
}

// === FFT worker protocol (plan §6.8) ===
export type FftRequest = {
  type: "fft";
  id: number;
  axis: 0 | 1 | 2;
  samples: Float32Array; // transferable
  sampleRate: number;
  full: boolean;
};

export type FftResponse = {
  type: "result";
  id: number;
  axis: 0 | 1 | 2;
  freqs: Float64Array;
  amps: Float64Array;
  computeMs: number;
};

export type FftError = {
  type: "error";
  id: number;
  axis: 0 | 1 | 2;
  message: string;
};

// === DVB1 worker protocol ===
export type Dvb1ParseRequest = { type: "parse"; buffer: ArrayBuffer };
export type Dvb1ParseResponse = { type: "bursts"; bursts: Burst[] } | { type: "error"; message: string };
