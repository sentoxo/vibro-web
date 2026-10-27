// Shared FETtec state types (used by the bus, the session and the store).

export type FettecStep = "idle" | "cli" | "passthrough" | "scan" | "init" | "ready" | "error" | "stopped";

export interface FettecDevice {
  /** OneWire ID (1-based, contiguous from the configured base). */
  id: number;
  /** 0-based motor index (id - base). */
  index: number;
  present: boolean;
  source: "bootloader" | "firmware" | "unknown";
  /** Raw DEVICE_types id. */
  type: number;
  typeName: string;
  /** "major.minor" or "" when unknown. */
  firmware: string;
  /** 12-byte serial number as uppercase hex. */
  serial: string;
  /** Per-ESC setup error (bootloader stuck, missing ack, …). */
  error: string | null;
  /** performance.now() of the last fast-telemetry update, or null. */
  lastTelemetryMs: number | null;
}

export interface FettecTelemetry {
  escIndex: number;
  tempC: number | null;
  volt: number | null;
  amps: number | null;
  /** Electrical RPM (raw × scale). */
  erpm: number | null;
  /** Mechanical RPM = erpm × 2 / poles. */
  rpm: number | null;
  mah: number | null;
  /** Debug slots 5..7 (last received value each). */
  debug: (number | null)[];
  lastTelemetryMs: number | null;
}

export interface FettecBusStats {
  state: FettecStep;
  /** Number of fast-throttle frames written since connect. */
  framesSent: number;
  /** Frames that produced a complete fast-telemetry reply. */
  replies: number;
  crcErrors: number;
  timeouts: number;
  /** Measured loop rate over the last stats window. */
  loopHz: number;
  /** Measured bus throughput (RX bytes/s). */
  rxBytesPerSecond: number;
  /** Human-readable state / last error. */
  message: string;
  updatedAt: number;
}

export type FettecVerdict = "onewire" | "fc-pin" | "no-onewire" | "unknown";

export interface FettecCheckResult {
  escIndex: number;
  verdict: FettecVerdict;
  /** Electrical RPM before / during the test pulse. */
  baselineErpm: number | null;
  pulseErpm: number | null;
  baselineAmps: number | null;
  pulseAmps: number | null;
  note: string;
}

export interface FettecCheckSummary {
  results: FettecCheckResult[];
  summary: string;
  ranAt: number;
  /** True when every present ESC answered the bus throttle. */
  allOneWire: boolean;
}
