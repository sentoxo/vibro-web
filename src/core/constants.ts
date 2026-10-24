// All defaults and protocol constants for the web port.
// Mirrors the Python app's config.py plus the decisions in PLAN.md.

export const APP_TITLE = "Vibro";

// === Serial protocol ===
export const BAUD_RATE = 921600;
export const FC_BAUD_RATE = 115200;
// Desktop startup handshake: `call all` (motor query), ~3 s pause, then
// `start stream`. `stop stream` is written on a clean shutdown.
export const CALL_ALL = "call all\n";
export const START_STREAM = "start stream\n";
export const STOP_STREAM = "stop stream\n";
export const CALL_ALL_TO_STREAM_MS = 3000;
export const SERIAL_BUFFER_BYTES = 65536; // BYOB read buffer + port open buffer
export const ACCUMULATOR_MAX_BYTES = 4096; // cap for partial-line accumulator
export const NO_DATA_TIMEOUT_MS = 3000;
export const RECONNECT_INTERVAL_MS = 1000;
export const RECONNECT_GIVEUP_MS = 30000;
export const WIRE_BITS_PER_BYTE = 10; // 8N1: start + 8 data + stop
export const WIRE_WARN_UTILIZATION = 0.8;
export const WIRE_IMU_WARN_HZ = 2500; // text protocol may not fit above this

// CH340 USB identity filters for requestPort(); clones use other PIDs, so a
// "show all" fallback is required.
export const CH340_FILTERS: SerialPortRequestOptions["filters"] = [
  { usbVendorId: 0x1a86, usbProductId: 0x7523 },
  { usbVendorId: 0x1a86, usbProductId: 0x5523 },
  { usbVendorId: 0x1a86, usbProductId: 0x7522 },
];
export const CH340_VENDOR_ID = 0x1a86;

// === Physics / units ===
export const G = 9.80665;
export const MS2_PER_LSB_BASE = G; // multiplied by (1 / lsb_per_g)
export const DVB1_LSB_TO_MS2 = 0.0039 * 9.80665; // ADXL345 8 g mode: 3.9 mg/LSB

// === Display windows ===
export const WINDOW_SECONDS = 2.0;
export const ZOOM_WINDOW_SECONDS = 0.2;
export const RMS_STATISTICS_WINDOW_SECONDS = 10.0;
export const TIME_Y_MIN_RANGE = 2.0;
export const MIN_SAMPLES_FOR_RENDER = 64;

// === FFT ===
export const MAX_FFT_POINTS = 512; // live-mode FFT cap (desktop parity)
export const MIN_FFT_SAMPLES = 64;
export const DEFAULT_FFT_REFRESH_HZ = 10;
export const FFT_MIN_HZ = 4.0;
export const FFT_MAX_FREQ_CHOICES = [200, 400, 600, 800, 1000, 1200, 1600];
export const DEFAULT_FFT_MAX_FREQ = 800;
export const FFT_Y_MAX = 2.0;
export const FFT_Y_SCALE_STEPS = [1, 2, 3, 4, 5, 6, 8, 10];

// === IMU rates ===
// imuHz drives the time-domain charts and the snapshot rate; the live FFT
// runs at its own rate: live_sample_rate = 2 * fftMaxHz (desktop parity).
export const IMU_HZ_CHOICES = [800, 1000, 1600, 2000, 3200, 4000];
export const DEFAULT_IMU_HZ = 2000;

// === Sensitivity ===
export const LSB_PER_G_CHOICES = [256, 2048] as const;
export const DEFAULT_LSB_PER_G = 2048;

// === Peaks ===
export const PEAK_COUNT = 3;
// RPM marker lines on the FFT charts (desktop `update_fft_rpm_indicators`).
export const RPM_MARKER_MAX_HZ = 1600;

// === DVB1 format ===
export const DVB1_MAGIC = "DVB1";
export const DVB1_HEADER_SIZE = 32; // "DVB1" + struct "<HHIIQQ" (utils.py)
export const DVB1_VERSION = 1;
export const DVB1_AXES = 3;
export const DVB1_SAMPLE_RATE = 3200;
export const DVB1_SAMPLE_COUNT = 6400;
export const FILE_MAX_BYTES = 100 * 1024 * 1024; // 100 MB cap
export const FILE_WORKER_PARSE_THRESHOLD = 8 * 1024 * 1024;
export const SNAPSHOT_SECONDS = 2.0;

// === Demo ===
export const DEMO_BURST_FREQS = [48, 72, 110, 160];
export const DEMO_BATCH_INTERVAL_MS = 20; // emit samples in 20 ms batches
export const DEMO_LANDING_START_MS = 400; // auto-demo delay after first paint

// === MSP / ESC ===
export const MSP_SET_MOTOR = 214;
export const MSP_MOTOR_TELEMETRY = 139;
export const MOTOR_RECORD_SIZE = 13;
export const TELEMETRY_POLL_MS = 100;
export const ESC_MIN_THROTTLE = 1000;
export const ESC_MAX_THROTTLE = 2000;
export const ESC_RAMP_STEP = 5; // % power per stop-ramp step
export const ESC_RAMP_INTERVAL_MS = 50;
export const ESC_DEFAULT_CHANNEL = 3; // desktop default RPM motor channel
export const ESC_MAX_CHANNELS = 16;
// Keep at 0 per D13; enabling it adds a heartbeat without restructuring.
export const ESC_HEARTBEAT_HZ = 0;

// === Persistence ===
export const SETTINGS_STORAGE_KEY = "vibro.settings.v1";

// === Render ===
export const RENDER_HZ = 10;
export const PACKET_STATS_INTERVAL_MS = 1000;
