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
// After a (re)connect the USB CDC link can still be draining its backlog and
// dropping samples while the host catches up. Sequence gaps seen during this
// window start a fresh baseline instead of being reported as packet loss, so a
// manual reconnect never raises the lost-packet warning.
export const LOSS_SETTLE_MS = 1500;

// USB identity filters for requestPort(): the sensor is an STM32 virtual COM
// port (0x0483:0x5740), while older units used a CH340 bridge. Unknown clones
// still need the unfiltered "show all" fallback.
export const SENSOR_FILTERS: SerialPortRequestOptions["filters"] = [
  { usbVendorId: 0x0483, usbProductId: 0x5740 },
  { usbVendorId: 0x1a86, usbProductId: 0x7523 },
  { usbVendorId: 0x1a86, usbProductId: 0x5523 },
  { usbVendorId: 0x1a86, usbProductId: 0x7522 },
];
export const CH340_VENDOR_ID = 0x1a86;
export const STM32_VENDOR_ID = 0x0483;

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
// imuHz is the real acquisition rate: it drives the time-domain charts, the
// snapshot rate and the live FFT frequency axis. `fftMaxHz` is only the FFT
// chart's display band (a zoom), not a sample rate.
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
export const MSP_ANALOG = 110;
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

// === FETtec OneWire over Betaflight passthrough ===
export const FETTEC_CLI_BAUD = 115200; // host/USB side; the FC VCP line coding
export const FETTEC_BAUD_CHOICES = [115200, 500000, 2000000] as const;
export const FETTEC_DEFAULT_ESC_BAUD = 2000000;
export const FETTEC_DEFAULT_CLI_LINE = "serialpassthrough esc_sensor 2000000 rxtx reset";
export const FETTEC_CLI_BANNER_TIMEOUT_MS = 1500;
export const FETTEC_CLI_SETTLE_MS = 1500;
export const FETTEC_MAX_ESCS = 8;
export const FETTEC_DEFAULT_ESC_COUNT = 8;
export const FETTEC_DEFAULT_ID_BASE = 1;
export const FETTEC_MIN_ID_BASE = 1;
export const FETTEC_MAX_ID_BASE = 24;
export const FETTEC_DEFAULT_POLES = 12;
export const FETTEC_MIN_POLES = 2;
export const FETTEC_MAX_POLES = 64;
export const FETTEC_LOOP_HZ = 100;
export const FETTEC_LOOP_INTERVAL_MS = 1000 / FETTEC_LOOP_HZ;
// Fast-telemetry reply window. Linux polls the FC's USB CDC interface on
// 16 ms frames; a reply split across two polls lands at ~32 ms, so a 20 ms
// window sits exactly on the boundary and clips those replies (field log:
// timeouts with "8 B rx +16 ms" = complete echo, telemetry in the next poll).
// 40 ms covers two polls plus jitter; the rare truly-lost frame just costs
// the loop one 40 ms beat (the 250 ms ESC failsafe stays far away).
export const FETTEC_REPLY_TIMEOUT_MS = 40;
export const FETTEC_REPLY_TIMEOUT_MIN_MS = 5;
export const FETTEC_REPLY_TIMEOUT_MAX_MS = 250;
export const FETTEC_CONFIG_TIMEOUT_MS = 120;
export const FETTEC_CONFIG_RETRIES = 2;
export const FETTEC_BOOTLOADER_SETTLE_MS = 200;
export const FETTEC_TELEMETRY_PATCH_MS = 50;
export const FETTEC_STATS_INTERVAL_MS = 500;
export const FETTEC_TLM_STALE_MS = 1500;
export const FETTEC_ZERO_FRAMES = 3;
export const FETTEC_RX_MAX_BYTES = 4096;
export const FETTEC_DEFAULT_CHECK_POWER = 10;
export const FETTEC_CHECK_BASELINE_MS = 500;
export const FETTEC_CHECK_PULSE_MS = 400;
export const FETTEC_CHECK_SETTLE_MS = 300;
export const FETTEC_CHECK_ERPM_THRESHOLD = 500; // centi-eRPM
export const FETTEC_CHECK_AMPS_THRESHOLD = 0.3; // A
export const FETTEC_RPM_SOURCE_MEAN = 0;

// === Persistence ===
export const SETTINGS_STORAGE_KEY = "vibro.settings.v1";

// === Render ===
export const RENDER_HZ = 10;
export const PACKET_STATS_INTERVAL_MS = 1000;
