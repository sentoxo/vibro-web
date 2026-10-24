# Vibro Web App — Port Plan

**Status:** Approved — implementation starts at Phase 0  
**Date:** 2026-10-24  
**Toolchain verified:** Node 26.11.1, npm 12.2.1, Chromium 154.0.8037.97 (Arch Linux)  
**Source:** `/home/kuba/VibroApp/vibro` (Python + PyQt6 + pyqtgraph)  
**Target:** `/home/kuba/VibroApp/VibroWebApp` (new static web app, local first, GitHub Pages-ready)  
**Working title:** Vibro  
**Plan owner:** You + implementation agent

---

## 1. Executive Summary

Vibro is a real-time vibration monitor. The desktop app reads `S<sid>,<seq>,<x>,<y>,<z>` lines from a CH340 serial device, plots time-domain and FFT data for X/Y/Z, computes RMS and dominant peaks, loads/saves DVB1 burst files, and optionally controls a Betaflight flight controller and ESCs over MSP.

This plan ports the app to a **static, serverless web app** built with **Vite + TypeScript + Preact + signals + uPlot**. It keeps the existing data formats and protocols, fixes the live FFT frequency-axis bug, replaces desktop-only capabilities with browser equivalents, and gives the UI a modern dark technical-dashboard look.

The web app is designed for:

- **Live hardware** in Chromium desktop browsers via Web Serial.
- **Demo mode** everywhere, including Firefox and Safari, with an auto-running synthetic stream.
- **File mode** everywhere, including DVB1 import, analysis and export.
- **Installable/offline PWA** for demo and file workflows.
- **Local development first** (`http://localhost:5173`), with a GitHub Pages deployment path added later.

### Locked decisions

| ID | Decision | Choice |
|---|---|---|
| D1 | Feature scope | Full parity, including ESC/FC control |
| D2 | Browser strategy | Chromium-only live; demo/file everywhere |
| D3 | Frontend stack | Preact + `@preact/signals` + uPlot |
| D4 | Visual direction | Dark technical dashboard |
| D5 | Landing/demo | Live simulated stream on landing + demo bursts |
| D6 | Auxiliary tools | Core app only; no `com_log`, `seq_analyzer`, `fettec_ctl` pages |
| D7 | Deployment | New project in `/home/kuba/VibroApp/VibroWebApp`; localhost now, Pages later |
| D8 | FFT frequency axis | Use the selected IMU Hz as the real sample rate; FFT max is display-only |
| D9 | FFT peaks | Local maxima, top 3 per axis |
| D10 | Time waveform | Scrolling `-2..0 s` window |
| D11 | Saving | Browser downloads by default; optional folder picker on Chromium |
| D12 | Calibration | Omit from the web UI |
| D13 | ESC safety | Basic warning, matching desktop behavior; no heartbeat or auto-stop in v1 |
| D14 | Sensor init | Write `start stream\n` only; no `call all` |
| D15 | Toolchain | Install Node.js and Chromium locally |
| D16 | PWA | Installable, offline app shell, update prompt |
| D17 | Language | English only |
| D18 | Hardware available | CH340 vibration sensor; no ESP32; no FC/ESC hardware |

### Why a static web app works

The only genuinely desktop-bound feature is hardware I/O. Everything else — parsing, DSP, charting, file formats, MSP packets — is plain computation and can run in the browser. Web Serial provides byte-level access to the CH340 device over HTTPS/localhost, with a permission prompt. GitHub Pages provides HTTPS, which is required by Web Serial.

The trade-offs are explicit:

- Live mode is **Chromium-only** (Chrome, Edge, Opera, Brave; Chrome Android 138+). Safari and stable Firefox have no Web Serial. Demo and file modes work in every modern browser.
- A page cannot enumerate or describe all serial ports. The user grants a port once; the app can reconnect to granted ports and filter by USB VID/PID.
- Desktop CPU usage cannot be read. It is replaced with render frame time, FPS and serial wire utilization.
- The Git-based updater is replaced with a service-worker update prompt.

---

## 2. Current App Analysis

### 2.1 Feature inventory

| # | Desktop feature | Source module | Web plan | Phase |
|---|---|---|---|---|
| 1 | Startup mode dialog: serial / demo / file | `dialogs.py`, `vibro.py` | Landing screen with Connect, Open file, Explore demo | 1 |
| 2 | Port discovery and refresh | `utils.find_preferred_port`, `dialogs.py` | `navigator.serial.getPorts()` + `requestPort()`; CH340 VID/PID filter; last-port reconnect | 3 |
| 3 | Serial streaming at 921600 | `serial_io.py` | Web Serial reader + byte-level line parser | 3 |
| 4 | Auto-reconnect | `serial_io.py` | `connect`/`disconnect` events + reopen with 1 s backoff | 3 |
| 5 | Sensitivity conversion | `serial_io.py` | Same formula, live setting | 3 |
| 6 | Packet count / lost packet detection | `app.py` | Same seq-gap logic; inline toast instead of modal | 3 |
| 7 | Live time plots | `app.py`, pyqtgraph | 3 × uPlot, scrolling window, dynamic Y | 1 |
| 8 | Live FFT plots | `fft_worker.py`, pyqtgraph | 3 × uPlot, FFT worker, Hann window, dynamic Y | 1 |
| 9 | Linked axes and zoom | `app.py` | uPlot sync + zoom/follow controls | 1 |
| 10 | RMS + 10 s avg/min/max | `app.py` | Same vector resultant and 10 s history | 1 |
| 11 | Dominant FFT peaks | `app.py` | Local maxima, top 3, per-axis cards | 1 |
| 12 | Dynamic FFT Y scaling | `app.py` | Same 1/2/3/4/5/6/8/10 × 10^n rule | 1 |
| 13 | Demo bursts 48/72/110/160 Hz | `app.py` | Keep four bursts; add live synthetic stream | 1 |
| 14 | DVB1 file mode + burst selector | `utils.py`, `app.py` | File input + drag/drop + burst list + metadata | 2 |
| 15 | Save PNG | `app.py`, pyqtgraph exporter | Compose a high-res PNG from chart data | 2 |
| 16 | Save DVB1 snapshot | `utils.py` | Exact DVB1 writer, download/folder picker | 2 |
| 17 | Save PNG + snapshot together | `app.py` | Same paired export | 2 |
| 18 | Settings: FFT refresh, FFT max, IMU Hz, sensitivity | `app.py` | Settings drawer, persisted in localStorage | 3 |
| 19 | ESC start/stop/power/ramp | `app.py` | MSP writer, warning, ramp timer | 4 |
| 20 | FC reconnect / disconnect | `app.py` | Second Web Serial port, 115200, MSP | 4 |
| 21 | Motor RPM telemetry | `esc_telemetry.py` | MSP 139 parser, 10 Hz polling, FFT markers | 4 |
| 22 | RPM motor channel | `app.py` | 1–16 selector | 4 |
| 23 | CPU usage | `psutil` | Render FPS, frame time, serial utilization, memory (Chromium) | 3 |
| 24 | Calibration | `serial_io.py` (no UI) | Omit per D12 | — |
| 25 | Git update check | `updater.py` | PWA update prompt + version/build hash | 5 |
| 26 | `com_log` / `seq_analyzer` / `fettec_ctl` | separate scripts | Out of scope per D6 | — |

### 2.2 Current data flow

```
CH340 sensor ──text lines──▶ SerialWorker (QThread)
                                  │  pyqtSignal(per sample)
                                  ▼
                         RealtimeVibeApp buffers
                           ├─ deque X/Y/Z (2 s)
                           ├─ snapshot deques (2 s)
                           └─ RMS history (10 s)
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
             update_plots() 10 Hz          FFTWorker (QThread)
             time curves + stats            Hann + rfft
                    │                           │
                    └──────────▶ pyqtgraph ◀────┘

DVB1 file ──utils.parse_dvb1_file──▶ bursts ──display_burst()──▶ plots + full FFT
Demo      ──generate_demo_bursts()──▶ same burst path
```

### 2.3 Wire formats and constants

**Serial line grammar** (`config.SEQ_LINE`):

```text
^S(\d),(\d+),(-?\d+),(-?\d+),(-?\d+)\s*$
S<sid>,<seq>,<x>,<y>,<z>\n
```

- `sid` is the sensor id. The desktop app only buffers `sid == 0`.
- `seq` increments by 1 per packet. A gap > 1 means lost packets; a gap <= 0 is treated as a reset and ignored.
- Raw values are accelerometer counts. Live conversion: `raw * 9.80665 / lsb_per_g`.
- Default sensitivity: `2048` LSB/g (new sensor). Old ADXL345 option: `256`.

**DVB1 binary burst format** (little-endian, 32-byte header):

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `DVB1` |
| 4 | 2 | version (`1`) |
| 6 | 2 | axes (`3`) |
| 8 | 4 | sample rate (u32) |
| 12 | 4 | sample count (u32) |
| 16 | 8 | timestamp ns (u64) |
| 24 | 8 | sequence (u64) |
| 32 | `count × axes × 2` | int16 interleaved samples |

DVB1 uses the fixed `DVB1_LSB_TO_MS2 = 0.0039 × 9.80665` conversion, independent of the live sensitivity setting. The writer must use the same constant so files round-trip.

**MSP v1 packets:**

```text
Request:   $M< <size> <cmd> <payload...> <xor>
Response:  $M> <size> <cmd> <payload...> <xor>
XOR is computed over size, cmd and payload (not the $M< / $M> prefix).
```

- `MSP_SET_MOTOR = 214`; payload is four little-endian u16 throttle values.
- `MSP_MOTOR_TELEMETRY = 139`; request is `$M<\x00\x8b\x8b`.
- Telemetry payload: `motor_count` byte, then 13-byte records per motor; RPM is a u32 LE at offset `1 + (channel - 1) * 13`.
- The 13-byte record was re-verified against Betaflight master `src/main/msp/msp.c` (MSP_MOTOR_TELEMETRY, added in MSP API 1.42). The desktop offsets are correct; the web port keeps them and additionally validates `payloadLen === 1 + motorCount * 13` before reading.
- ESC throttle: `1000 + power_percent * 10`; four channels are set together.
- FC baud: `115200`. Sensor baud: `921600`.

**Desktop defaults:**

| Setting | Default |
|---|---|
| IMU Hz | 2000 |
| FFT max display | 800 Hz |
| FFT refresh | 10 Hz |
| Sensitivity | 2048 LSB/g |
| Time window | 2.0 s (zoom 0.2 s) |
| RMS window | 10.0 s |
| FFT min | 4 Hz |
| Live FFT size | 512 samples |
| Demo burst rate | 3200 Hz, 6400 samples |
| DVB1 default rate | 3200 Hz |

### 2.4 Desktop quirks and decisions

| Quirk | Desktop behavior | Web decision |
|---|---|---|
| Live FFT sample rate | Data is sampled at `imu_hz`, but FFT frequency axis uses `2 × fft_max_freq`. At defaults this is 2000 vs 1600 Hz (25% error). | **Fix (D8):** use selected IMU Hz for the FFT axis. FFT max only clips the display. |
| FFT max above Nyquist | Allowed; produces invalid/empty bins. | Clamp FFT max choices to `imu_hz / 2`; notify on change. |
| Time plot X axis | Resets to 0..2 s on every refresh (scope sweep). | **Fix (D10):** scrolling `-window..0 s`; keep full 2 s history for snapshots. |
| Peak detection | Top 3 raw bins; adjacent bins can appear as separate peaks. | **Fix (D9):** local maxima with minimum bin separation. |
| Port auto-detection | Scans descriptions for “USB_SERIAL CH340”. | Use Web Serial grant + CH340 VID/PID filter; no descriptions. |
| Port reconnect | Re-scans preferred port every 1 s. | Reopen granted port on `connect`; 1 s backoff; explicit “Forget port”. |
| Save location | `./logs/` next to the app. | Downloads by default; optional folder picker; session collision tracking. |
| CPU usage | `psutil.Process.cpu_percent()`. | Render FPS, frame time, serial load; no process CPU. |
| Lost packet warning | Blocking one-time modal. | Non-blocking toast + persistent counter. |
| Calibration | Worker supports it; no UI. | Omit (D12). |
| Update check | GitHub Releases + `git pull --ff-only`. | Service-worker update prompt; no Git. |
| File mode snapshot | Last 2 s of selected burst; timestamp adjusted. | Same. |
| Filename convention | `{base}{index:02}_{power}`, collision suffix `_02`. | Same; folder picker can detect collisions. |
| PNG export | pyqtgraph scene at 1920 px. | Compose dashboard PNG at 1920 px. |
| Sensitivity default | UI starts at 2048; comment says 256. | Use 2048 (actual sensor). |
| Calibration strings | `call all`, `start stream`, waits. | `start stream\n` only (D14); `stop stream\n` best-effort on disconnect. |

---

## 3. Platform Constraints and R&D Findings

### 3.1 Web Serial

| Topic | Finding | Consequence |
|---|---|---|
| Availability | Chromium 89+ on desktop; Chrome Android 138+; Safari none; stable Firefox none (Firefox Nightly has experimental work). | Live mode is Chromium-only. Detect `navigator.serial`; do not rely on user-agent strings. |
| Secure context | HTTPS or `http://localhost` is required. | GitHub Pages works; Vite localhost works. |
| User gesture | `requestPort()` must be called from a click/tap. `getPorts()` and `open()` do not. | Connect is always a user action; auto-reconnect only after a session has started. |
| Enumeration | `getPorts()` returns only ports previously granted to this origin. | No silent scan of all COM ports. Show granted ports and a “Grant another port” action. |
| Descriptions | `getInfo()` exposes only `usbVendorId` / `usbProductId`. | Cannot show “USB_SERIAL CH340”; show `CH340 (1a86:7523)` and an index when duplicates exist. |
| Multiple ports | Ethernet/FC and sensor ports can be open at once. | Sensor and FC are separate `SerialPort` objects. |
| Workers | `navigator.serial` and `SerialPort` are exposed in dedicated workers, but `requestPort()` is window-only. | Start with serial on the main thread; if profiling requires it, grant on the main thread, then open the granted port from a worker via `getPorts()`. |
| Read strategy | `readable.getReader({mode: "byob"})` avoids per-chunk allocation; chunks are arbitrary. | Use a 64 KB BYOB buffer and parse complete lines from a byte accumulator. |
| Errors | Buffer overrun, framing, parity, break and disconnect errors are possible. | Catch, count, toast, and reconnect; never crash the UI. |
| Linux permissions | The browser process needs read/write access to `/dev/ttyUSB*` (usually `uucp` group on Arch/CachyOS) and ModemManager must not claim the port. | Document prerequisites; test with `ls -l /dev/ttyUSB0` and `about://device-log`. |

### 3.2 Static hosting

| Topic | Finding | Consequence |
|---|---|---|
| GitHub Pages | Static files over HTTPS; no custom response headers, no server functions. | Perfect for a Vite `dist/`; no backend. |
| COOP/COEP | Cannot set cross-origin isolation headers. | No `SharedArrayBuffer`; use `postMessage` with transferable `ArrayBuffer`s. |
| PWA | Service workers require HTTPS/localhost. | PWA works on Pages and localhost. |
| Base path | Project Pages live under `/<repo>/`. | Make the Vite base configurable; test under a subpath. |
| Caching | `index.html` caching is not controllable. | Use a precache service worker + update prompt. |

### 3.3 Performance ceiling of the text protocol

At 921600 baud, 8N1, the theoretical payload ceiling is about **92 KB/s**. A line such as `S0,12345,-1234,-1234,-1234\n` is roughly 30 bytes, so 2000 Hz needs about **60 KB/s** (65% of the wire). 3200 Hz needs about **96 KB/s**, which already exceeds 921600 baud. 4000 Hz cannot fit at all in this text format.

**Consequences:**

- Recommend keeping the sensor at 2000 Hz or below unless the firmware uses a compact/binary protocol.
- Show estimated wire utilization (`packetRate × avgLineBytes × 10 / baud`) in Diagnostics.
- Warn at >80% and mark dropped packets as “possibly bandwidth-bound”.
- Do not claim 4000 Hz support without a device-side protocol change.

### 3.4 Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| Pyodide + PyQt/pyqtgraph | Very large download, poor GUI support, no serial access, slow startup. Contradicts “slim and fast”. |
| Qt for WebAssembly | PyQt6 is not available; a C++ Qt build is huge and still lacks serial. |
| Electron/Tauri wrapper | Not a browser app and not serverless. |
| Backend + WebSocket bridge | Gives Firefox/Safari live mode but requires hosting; rejected for v1. |
| WebUSB directly | Requires implementing USB CDC and driver quirks; Web Serial is the correct abstraction. |
| Chart.js / Plotly / ECharts | Heavier and slower for six real-time charts. uPlot is purpose-built. |
| React/Svelte | Viable, but Preact + signals gives the best size/complexity balance here. |
| WebGL charts | Unnecessary at 6 × 8k points and 10 Hz. Canvas 2D is sufficient. |

---

## 4. Product Definition

### 4.1 Users and jobs

1. **Lab/bench engineer** — connect the CH340 sensor, watch live vibration, inspect FFT peaks, export evidence.
2. **Field tester** — open a recorded DVB1 burst on any laptop/phone, inspect it, save a screenshot.
3. **Visitor / reviewer** — open the public URL, immediately see a convincing live demo without hardware.
4. **Advanced user** — connect a Betaflight FC and use the same motor test controls as the desktop app, with an explicit warning.

### 4.2 v1 scope

**In scope**

- Live sensor streaming in Chromium, including reconnect and packet-loss detection.
- Live synthetic demo stream + the four existing demo bursts.
- DVB1 file import, burst selection, full-burst FFT and metadata.
- Six linked charts: time and FFT for X, Y, Z.
- RMS statistics, dominant peaks, dynamic scaling, RPM markers.
- Settings: IMU Hz, FFT max, FFT refresh, sensitivity, time window.
- PNG snapshot, DVB1 snapshot, paired export.
- ESC/FC control with MSP, basic warning.
- PWA install/offline for non-serial workflows.
- English UI, dark theme, responsive layout.

**Out of scope**

- Calibration UI.
- `com_log`, `seq_analyzer`, `fettec_ctl` web pages.
- Backend, accounts, cloud storage, telemetry.
- Firefox/Safari live serial.
- Binary sensor protocol changes.
- Continuous ESC heartbeat and auto-stop (deferred per D13).
- Light theme in the initial release (dark only; tokens make it addable).
- Mobile-specific sensor integrations (DeviceMotion, microphone).

### 4.3 Success criteria

- A user can go from landing page to a moving demo in under 2 seconds on a normal laptop.
- A Chromium user can grant the CH340 port, stream at 2000 Hz for 30 minutes, and see no UI freeze or unhandled error.
- A DVB1 file exported by the web app is accepted by `python vibro.py --debug --file <file>` and by the desktop app.
- FFT frequencies match the corrected sample-rate math within 0.1 Hz for the same data.
- Six charts update at the configured rate while the main thread stays responsive.
- Demo and file modes work in Chrome, Edge, Firefox and Safari.
- Lighthouse: Performance ≥ 90, Accessibility ≥ 95, Best Practices ≥ 95, PWA installable.
- Initial JS ≤ 150 KB gzip, CSS ≤ 20 KB gzip.
- No data leaves the device; no network calls after the app is loaded (except optional update check).

---

## 5. UX and Visual Design

### 5.1 Design principles

- **Instruments, not decoration.** The data is the hero; chrome stays out of the way.
- **One glance to health.** Connection, packet rate, loss and sample rate are always visible.
- **Fast first paint.** The demo runs immediately; connecting hardware is one click.
- **Progressive disclosure.** Basic controls visible; advanced/ESC controls collapsed and warned.
- **Dark, precise, modern.** Near-black surfaces, thin borders, cyan/lime accents, tabular numerals.
- **No fake data without a label.** Demo mode is always marked “DEMO”.
- **Accessible by default.** Keyboard paths, focus rings, contrast, reduced motion.

### 5.2 Screen map

| Screen / surface | Purpose |
|---|---|
| Landing / empty state | Brand, short explainer, Connect / Open file / Explore demo, browser support note |
| Dashboard | Six charts, stats header, source controls, settings drawer, status strip |
| Connect dialog | Granted ports, “Grant another port”, baud, CH340 hint, error help |
| File picker | Drag/drop or browse `.bin`/`.dvb`; parse errors; burst selector after load |
| Settings drawer | Source, analysis, display, export, advanced |
| ESC panel | FC connect, warning, start/stop, power, motor channel, diagnostics |
| Safety modal | Props-off confirmation + untested-hardware notice |
| Export dialog | Base name, index, destination (Downloads / folder), preview filename |
| About / Help | Version, build hash, browser support, protocol notes, privacy |
| Toasts | Packet loss, disconnect, save success/failure, update available |

### 5.3 Desktop layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ◉ Vibro      [DEMO ●]  2000 Hz   Loss 0   FPS 60     [Connect] [⚙] [?]      │
├─────────────────────────────────────────────────────────────────────────────┤
│  RMS 1.53 m/s²  ╱╲╱   avg 1.42  min 0.91  max 2.10   Peak 1  Peak 2  Peak 3 │
├───────────────────────────────────────────────────┬─────────────────────────┤
│  Time — X axis                       FFT — X axis │  Source                 │
│  ─────────────────────────────       ─────────── │  ┌───────────────────┐  │
│  Time — Y axis                       FFT — Y axis │  │ Live / Demo / File│  │
│  ─────────────────────────────       ─────────── │  └───────────────────┘  │
│  Time — Z axis                       FFT — Z axis │  Settings               │
│  ─────────────────────────────       ─────────── │  IMU Hz        [2000]   │
│                                                   │  FFT max       [800]    │
│                                                   │  Refresh       [10 Hz]  │
│                                                   │  Sensitivity   [2048]  │
│                                                   │  Window        [2 s]   │
│                                                   │  Export                │
│                                                   │  ESC control (locked)  │
├───────────────────────────────────────────────────┴─────────────────────────┤
│ packets 12,430 · lost 0 · malformed 0 · wire 65% · render 3.1 ms · v0.1.0  │
└─────────────────────────────────────────────────────────────────────────────┘
```

- Charts area uses CSS Grid: `grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);` with three rows, time on the left and FFT on the right.
- Sidebar is 320–360 px, independently scrollable; collapses into a drawer below 1280 px.
- Below 900 px, show an axis selector (`X | Y | Z`) and stack Time + FFT; do not try to fit six charts.
- Header is sticky; status strip is sticky at the bottom on desktop.

### 5.4 Landing layout

```
        VIBRO
        Real-time vibration analysis, in your browser.

        [ Connect sensor ]   [ Open DVB1 file ]   [ Explore demo ]

        Live hardware requires Chrome or Edge.
        Demo and file analysis work in every modern browser.

        ┌────────────────────────────────────────────────────┐
        │  auto-running synthetic stream, six live charts    │
        └────────────────────────────────────────────────────┘

        Why Vibro · Data formats · Privacy · GitHub
```

The landing page **auto-starts the demo stream** after first paint (about 300–600 ms), unless the user has an active session or has disabled autoplay. A “Demo data” badge is always visible. This is the primary GitHub Pages first impression.

### 5.5 Design tokens

```css
:root {
  color-scheme: dark;

  /* surfaces */
  --bg:            #070b10;
  --surface:       #0d131b;
  --surface-2:     #121a24;
  --surface-3:     #182230;
  --border:        #1f2a37;
  --border-strong: #2b394a;

  /* text */
  --text:          #e6edf3;
  --text-muted:    #8b9bb0;
  --text-dim:      #5d6b7c;

  /* accents */
  --accent:        #22d3ee;  /* cyan */
  --accent-2:      #a3e635;  /* lime */
  --danger:        #fb7185;
  --warning:       #fbbf24;
  --ok:            #34d399;

  /* axes */
  --axis-x:        #22d3ee;
  --axis-y:        #fbbf24;
  --axis-z:        #e879f9;

  /* charts */
  --grid:          rgba(255, 255, 255, 0.06);
  --grid-strong:   rgba(255, 255, 255, 0.12);
  --fill:          rgba(34, 211, 238, 0.10);

  /* geometry */
  --radius-sm: 8px;
  --radius:    12px;
  --radius-lg: 16px;
  --shadow:    0 10px 30px rgba(0, 0, 0, 0.35);

  /* type */
  --font-ui: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "Cascadia Code", monospace;
}
```

- **Typography:** system UI for text, system monospace for numbers, `font-variant-numeric: tabular-nums` on all readouts. No web-font download in v1.
- **Spacing:** 4 px base scale; panels use 12–16 px padding; chart gaps 12 px.
- **Borders:** 1 px `--border`; active/focus uses `--accent` at 2 px.
- **Motion:** 120–180 ms ease-out for panels/toasts; charts update without decorative tweening. Respect `prefers-reduced-motion`.
- **Iconography:** inline SVG, 16/20 px, stroke 1.5; no icon package.
- **Status colors:** green streaming, amber reconnecting/demo, red error/loss, cyan action.

### 5.6 Components

| Component | Responsibility |
|---|---|
| `AppShell` | Header, main region, status strip, toasts, drawers |
| `Brand` | Inline SVG waveform logo + wordmark |
| `SourceBadge` | DEMO / LIVE / FILE, connection dot, device label |
| `ConnectionButton` | Connect, reconnect, disconnect, permission state |
| `StatHero` | Large RMS value, unit, trend sparkline, avg/min/max |
| `PeakCards` | Three cards; per-axis frequency/amplitude; empty state |
| `ChartPanel` | Header, axis color, current RMS/peak, uPlot canvas, overlay states |
| `ChartGrid` | Six panels, linked scales, axis selector on mobile |
| `SettingsDrawer` | Sections and controls; persisted values |
| `FileDropZone` | Drag/drop, browse, parse progress/errors |
| `BurstSelect` | Burst list with sequence/timestamp summary |
| `ExportPanel` | Base name, index, destination, save buttons, status |
| `EscPanel` | FC status, warning, start/stop, power, channel |
| `SafetyDialog` | Props-off confirmation, risks, unlock |
| `ToastStack` | Non-blocking notifications with actions |
| `StatusStrip` | Packets, loss, malformed, wire %, render ms, version |
| `UpdatePrompt` | “New version available — Reload” |
| `EmptyState` | No data, no port, unsupported browser, file error |

### 5.7 Chart behavior

**Time charts**

- X range: `-windowSeconds .. 0` in live/demo mode; `0 .. burstDuration` in file mode.
- Window: 2 s default; zoom mode 0.2 s. Keep the full 2 s ring buffer even when zoomed.
- Y range: symmetric, `max(1.0, maxAbs × 1.1)`; minimum span 2.0 m/s².
- Line: 1 px axis color; optional subtle fill at 6% alpha.
- Title/caption: `Time — X axis — 1.53 m/s² RMS`.
- Crosshair tooltip: time (s) and acceleration (m/s²).
- Scroll: new samples enter at the right edge; no scope-style reset.
- Freeze/pause: stops visual updates but keeps ingesting; “Resume live” button.
- User zoom/pan pauses auto-follow; show “Live” button to snap back.

**FFT charts**

- X range: `4 Hz .. min(fftMaxHz, imuHz / 2)`.
- Y range: `0 .. dynamicMax`, starting at 2.0 m/s².
- Line: 1.2 px axis color; area fill at 8% alpha.
- RPM markers: 1× and 2× motor frequency, dashed vertical lines, hidden when out of range.
- Peak dots/labels: top local maximum; optional top 3 dots.
- Crosshair tooltip: frequency (Hz) and amplitude (m/s²).
- Linked zoom/pan across the three FFT charts; time charts link separately.
- Empty state until enough samples: “Waiting for 64 samples…”.

**General**

- Resize via `ResizeObserver` with rAF debounce.
- Canvas DPR handled by uPlot; no manual scaling.
- Hidden live region announces connection/loss/save events for screen readers.
- Each chart has an `aria-label` updated at 1 Hz with its current RMS/peak.

### 5.8 Responsive behavior

| Width | Layout |
|---|---|
| ≥ 1440 px | Full dashboard, sidebar visible, 3 × 2 chart grid |
| 1100–1439 px | Sidebar drawer, charts 3 × 2, tighter header |
| 760–1099 px | Charts stack Time over FFT per axis; axis selector tabs |
| < 760 px | Single chart at a time; axis + domain tabs; sticky compact stats |

### 5.9 Copy deck (English)

- “Connect sensor”
- “Open DVB1 file”
- “Explore demo”
- “Demo data — not a real device”
- “Live hardware requires Chrome or Edge. Demo and file analysis work everywhere.”
- “No sensor found. Plug in the CH340 device, then try again.”
- “Sensor disconnected. Reconnecting…”
- “Lost packets detected. The stream may be unstable.”
- “Saved to Downloads.”
- “New version available. Reload to update.”
- “Props off. This sends motor commands to your flight controller.”
- “ESC control is untested on this hardware. Use at your own risk.”
- “This app never uploads your data.”

---

## 6. Technical Architecture

### 6.1 Stack

| Layer | Choice | Why |
|---|---|---|
| Build | Vite + TypeScript (strict) | Fast dev server, tiny output, first-class Preact/TS |
| UI | Preact 10 + `@preact/signals` | ~4 KB runtime, fine-grained updates, no virtual-DOM churn at 10 Hz |
| Charts | uPlot 1.6.x | ~50 KB, Canvas 2D, extremely fast for time series |
| Styling | Plain CSS with custom properties | No Tailwind/runtime; full control of the dark theme |
| FFT | In-house radix-2 worker | Small, testable, zero dependencies; zero-pad to power of two |
| PWA | `vite-plugin-pwa` | Precache app shell, manifest, update prompt |
| Tests | Vitest + Playwright | Unit + browser E2E; Playwright can mock Web Serial |
| Icons | Inline SVG | No icon package |
| State | Signals + a small mutable data store | Reactive UI, non-reactive sample buffers for speed |

**Runtime dependency budget:** Preact ~4 KB, signals ~2 KB, uPlot ~20 KB gzip, app ~30–50 KB, CSS ~10 KB. Target ≤ 150 KB gzip initial JS.

### 6.2 Directory layout

```text
VibroWebApp/
├── PLAN.md
├── README.md
├── AGENTS.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── public/
│   ├── icons/                 # 192, 512, maskable SVG/PNG
│   ├── favicon.svg
│   └── robots.txt
├── src/
│   ├── main.tsx               # mount, PWA registration
│   ├── app.tsx                # AppShell + screen state
│   ├── core/
│   │   ├── constants.ts       # all defaults and protocol constants
│   │   ├── types.ts           # Sample, Burst, Settings, Stats, SourceKind
│   │   ├── units.ts           # raw↔m/s², formatting, rounding
│   │   ├── ring-buffer.ts     # fixed-size Float32 ring buffers
│   │   ├── parser.ts          # byte-level S0,... line parser
│   │   ├── rate-meter.ts      # packet rate, wire utilization, loss
│   │   ├── stats.ts           # RMS, 10 s history, min/max/avg
│   │   ├── fft.ts             # radix-2 FFT, Hann, normalization
│   │   ├── peaks.ts           # local maxima, top 3
│   │   ├── dvb1.ts            # parse/write DVB1
│   │   ├── naming.ts          # snapshot filenames/collisions
│   │   ├── msp.ts             # MSP v1 encode/parse
│   │   └── esc.ts             # throttle math, ramp state machine
│   ├── sources/
│   │   ├── source.ts          # DataSource interface
│   │   ├── serial.ts          # Web Serial source + reconnect
│   │   ├── demo.ts            # synthetic stream + four bursts
│   │   └── file.ts            # DVB1 file source
│   ├── state/
│   │   ├── store.ts           # signals, source lifecycle
│   │   ├── settings.ts        # defaults, localStorage persistence
│   │   └── toasts.ts          # toast queue
│   ├── charts/
│   │   ├── theme.ts           # uPlot axis/grid/colors
│   │   ├── chart.ts           # create/update chart instances
│   │   ├── rpm-plugin.ts      # 1×/2× RPM vertical lines
│   │   └── export-png.ts      # compose dashboard PNG
│   ├── workers/
│   │   └── fft.worker.ts      # FFT requests with transferables
│   ├── components/
│   │   ├── AppShell.tsx
│   │   ├── Brand.tsx
│   │   ├── Header.tsx
│   │   ├── StatusStrip.tsx
│   │   ├── StatHero.tsx
│   │   ├── PeakCards.tsx
│   │   ├── ChartPanel.tsx
│   │   ├── ChartGrid.tsx
│   │   ├── SettingsDrawer.tsx
│   │   ├── ConnectDialog.tsx
│   │   ├── FileDropZone.tsx
│   │   ├── BurstSelect.tsx
│   │   ├── ExportPanel.tsx
│   │   ├── EscPanel.tsx
│   │   ├── SafetyDialog.tsx
│   │   ├── ToastStack.tsx
│   │   └── UpdatePrompt.tsx
│   ├── styles/
│   │   ├── tokens.css
│   │   ├── base.css
│   │   ├── layout.css
│   │   └── components.css
│   └── pwa.ts
├── tests/
│   ├── unit/
│   │   ├── parser.test.ts
│   │   ├── fft.test.ts
│   │   ├── peaks.test.ts
│   │   ├── dvb1.test.ts
│   │   ├── stats.test.ts
│   │   ├── msp.test.ts
│   │   └── naming.test.ts
│   ├── fixtures/
│   │   ├── test_data.bin      # copied from the Python project
│   │   └── golden.json        # generated by scripts/gen_golden.py
│   └── e2e/
│       ├── demo.spec.ts
│       ├── file.spec.ts
│       ├── settings.spec.ts
│       └── mock-serial.spec.ts
├── scripts/
│   └── gen_golden.py          # dev-only parity fixture generator
├── .github/workflows/
│   ├── ci.yml
│   └── deploy.yml             # ready, only runs when a remote exists
└── .gitignore
```

### 6.3 Data model

```ts
type SourceKind = "demo" | "file" | "serial";
type ConnectionState =
  | "idle" | "requesting" | "connecting" | "streaming"
  | "reconnecting" | "error";

interface Sample {
  sid: number;
  seq: number;
  x: number; // m/s²
  y: number;
  z: number;
  t: number; // performance.now() at ingest (ms)
}

interface Settings {
  imuHz: number;          // 800 | 1000 | 1600 | 2000 | 3200 | 4000
  fftMaxHz: number;       // <= imuHz / 2, display only
  fftRefreshHz: number;   // 0.5 .. 60
  lsbPerG: 256 | 2048;
  windowSeconds: 2.0 | 0.2;
  autoReconnect: boolean;
  saveMode: "download" | "folder";
  escMotorChannel: number; // 1..16
}

interface Burst {
  version: number;
  axes: number;
  sampleRate: number;
  sampleCount: number;
  timestampNs: bigint;
  sequence: bigint;
  samples: Float32Array; // interleaved x,y,z, m/s²
}

interface Peak { frequency: number; amplitude: number; }
interface RmsStats { current: number; avg: number; min: number; max: number; }

interface AppState {
  sourceKind: SourceKind;
  connection: ConnectionState;
  deviceLabel: string;
  settings: Settings;
  bursts: Burst[];
  selectedBurst: number;
  rms: RmsStats;
  peaks: Peak[][];        // [axis][rank]
  packetRate: number;
  lostPackets: number;
  malformedLines: number;
  fftMaxSeen: number;
  renderMs: number;
  fps: number;
  esc: EscState;
}
```

**Important:** sample ring buffers live outside signals. Signals are updated at 10 Hz (or the configured render rate), not per sample. This avoids reactive overhead at 2–4 kHz.

### 6.4 Data flow

```
Web Serial ──bytes──▶ line parser ──samples──▶ Ring buffers (X/Y/Z, 2 s)
                                                   │
DVB1 file ──bursts────────────────────────────────┤
                                                   │
Demo ──synthetic stream────────────────────────────┘
                                                   │
                                                   ▼
                                        Render loop (rAF / 10 Hz)
                                         ├─ time chart data (decimated)
                                         ├─ RMS + 10 s history
                                         ├─ packet/rate diagnostics
                                         └─ FFT request (3 axes, 512 pts)
                                                   │
                                                   ▼
                                           FFT worker (radix-2)
                                                   │
                                                   ▼
                                        FFT charts + peaks + dynamic Y
```

### 6.5 Source abstraction

```ts
interface DataSource {
  kind: SourceKind;
  start(): Promise<void>;
  stop(): Promise<void>;
  onSamples(batch: Sample[]): void;
  onStatus(status: SourceStatus): void;
}
```

- `SerialSource` owns a `SerialPort`, reader, writer, reconnect timer and parser.
- `FileSource` parses a file into bursts and exposes `selectBurst(i)`; it does not stream.
- `DemoSource` generates samples on a timer and can also expose the four demo bursts.
- Switching source always stops the previous one, clears buffers and cancels pending FFT requests.
- The store owns exactly one active source.

### 6.6 Serial source

**State machine**

```
idle ──click Connect──▶ requesting ──granted──▶ connecting ──open──▶ streaming
                                                           │
streaming ──disconnect/error──▶ reconnecting ──success──▶ streaming
                                    │
                                    └──user Stop──▶ idle
```

**Connect flow**

1. If `navigator.serial` is missing, show the unsupported-browser panel with demo/file actions.
2. On click:
   - `const ports = await navigator.serial.getPorts()`.
   - If a previously used port exists, show it as “Reconnect”.
   - “Grant another port” calls `navigator.serial.requestPort({ filters: CH340_FILTERS })`.
   - If no CH340 appears, offer “Show all serial devices” (no filters).
3. `await port.open({ baudRate: 921600, bufferSize: 65536 })`.
4. Write `encoder.encode("start stream\n")` once.
5. Start the read loop. If no bytes arrive within 3 s, show “No data — check the device and that it is not open in another app.”
6. On first valid line, state becomes `streaming`.

**CH340 filters**

```ts
const CH340_FILTERS = [
  { usbVendorId: 0x1a86, usbProductId: 0x7523 },
  { usbVendorId: 0x1a86, usbProductId: 0x5523 },
  { usbVendorId: 0x1a86, usbProductId: 0x7522 },
];
```

Some clones use different PIDs; the “Show all” fallback is essential.

**Read loop**

```ts
while (port.readable && running) {
  const reader = port.readable.getReader({ mode: "byob" });
  try {
    while (running) {
      const { value, done } = await reader.read(new Uint8Array(65536));
      if (done) break;
      parser.push(value); // byte accumulator, emits complete lines
    }
  } catch (err) {
    // Count and surface buffer/framing errors; reconnect if fatal.
  } finally {
    reader.releaseLock();
  }
}
```

**Parser**

- Split on `0x0A`; strip optional `0x0D`; ignore empty lines.
- Fast manual parse, no regex per line:
  - expect `S`, then digits until `,`;
  - parse signed integers between commas;
  - require exactly five fields and a newline-terminated complete line.
- Count malformed lines; keep a small sample of the last malformed line for diagnostics.
- Buffer partial lines across chunks; cap the accumulator (e.g. 4 KB) and reset on overflow.
- For each valid line: increment `packetCount`, update seq/loss, and if `sid === 0`, append to ring buffers.
- Apply `raw * (9.80665 / lsbPerG)` live.
- Drop data if the UI is paused? No — always ingest; pause only freezes rendering.

**Rate and loss**

- Packet rate: count valid lines over a 1 s sliding window; display integer Hz.
- Measured rate: count over a 2 s window for stability; compare to `imuHz`; show a warning chip if deviation > 10%.
- Lost packets: `gap = seq - lastSeq`; if `gap > 1`, `lost += gap - 1`; if `gap <= 0`, ignore and count a “reset”.
- Wire utilization: `rate × avgLineBytes × 10 / baudRate`; warn above 80%.
- Malformed lines: count; do not spam toasts; show in diagnostics.

**Stop / disconnect**

1. Set `running = false`.
2. Best-effort write `stop stream\n` (do not await forever).
3. `reader.cancel()`, `releaseLock()`, `port.close()`.
4. Keep the grant so “Reconnect” works; “Forget port” calls `port.forget()` in Advanced.

**Reconnect**

- Listen to `navigator.serial` `connect`/`disconnect` and `SerialPort` events.
- On unexpected close, if `autoReconnect`, retry `open()` every 1 s while the page is visible.
- Do not call `requestPort()` automatically.
- After 30 s of failures, show “Sensor not available — click Reconnect”.
- Reconnect resets seq tracking (avoid a huge fake loss count) but keeps session totals.

**Limitations to communicate**

- Only one app can open the port at a time; close the Python app first.
- Linux users may need `uucp`/`dialout` group membership.
- Browser tab throttling can cause overruns; keep the tab visible for long runs.

### 6.7 Buffer and render pipeline

- Ring buffer capacity: `imuHz × 2.0` samples per axis (max 8000 at 4000 Hz).
- Use `Float32Array` for samples; `Float64Array` for FFT input/output and chart copies.
- Each render:
  1. Determine view length: `windowSeconds × imuHz`.
  2. Copy the last N samples (contiguous) from the ring buffer into reusable chart arrays.
  3. Compute per-axis mean and subtract it for display/FFT/RMS.
  4. Update time charts and stats.
  5. If due, submit FFT jobs.
- Do not allocate arrays per frame; reuse scratch buffers.
- Decimate only if points-per-pixel > 2: use min/max pairs per pixel column for the time chart. At 8000 points across ~700 px, decimation is optional but useful on mobile.
- Render scheduling: `requestAnimationFrame` loop, throttled to the configured refresh rate. Stats update at 10 Hz, packet stats at 1 Hz, FFT at the configured rate (default 10 Hz).

### 6.8 FFT

**Algorithm**

- Remove the mean (already removed for display; harmless to repeat).
- Hann window: `w[i] = 0.5 - 0.5 * cos(2πi / (n - 1))`.
- `scale = sum(w) / n`.
- `N = nextPowerOfTwo(n)`; zero-pad the windowed signal.
- Radix-2 Cooley–Tukey FFT in `Float64Array` real/imag arrays.
- Amplitude: `amp[k] = hypot(re[k], im[k]) / N / scale`.
- Double interior bins: `amp[k] *= 2` for `0 < k < N/2`; do not double DC or Nyquist.
- Frequencies: `f[k] = k * sampleRate / N`, `k = 0 .. N/2`.

**Live mode**

- `n = min(bufferLength, 512)`; require `n >= 64`; use the last n samples.
- `sampleRate = settings.imuHz` (D8). Display range is independent.
- Default refresh 10 Hz.

**File mode**

- `n = burst.sampleCount` (typically 6400); zero-pad to 8192.
- `sampleRate = burst.sampleRate`.
- Compute once per burst selection; cache results per burst + settings.

**Why zero-padding is safe**

The normalization divides by `sum(window)`, so the amplitude of a bin does not depend on the padded length. Zero-padding only interpolates the spectrum and increases frequency resolution. Golden fixtures must be generated with the same padded length so tests compare like with like.

**Worker protocol**

```ts
type FftRequest = {
  id: number;
  axis: 0 | 1 | 2;
  samples: Float32Array; // transferable
  sampleRate: number;
  full: boolean;
};
type FftResponse = {
  id: number;
  axis: 0 | 1 | 2;
  freqs: Float64Array;   // transferable
  amps: Float64Array;    // transferable
  computeMs: number;
};
```

- One worker, request queue, latest-wins per axis (drop stale requests).
- Transfer `samples`, `freqs`, `amps` buffers to avoid copies.
- If the worker fails, show a toast and fall back to a main-thread FFT for the next frame (optional robustness).

### 6.9 Peak detection

- Skip DC (`k = 0`).
- Candidate: `amps[k] > amps[k-1] && amps[k] >= amps[k+1]`.
- Ignore candidates below `PEAK_MIN_AMPLITUDE` (default `0.02 m/s²`) and outside the display range.
- Sort descending by amplitude.
- Enforce a minimum separation of `PEAK_MIN_SEPARATION_BINS` (default 3); keep the strongest.
- Return up to 3 per axis.
- UI cards: `X 353 Hz · 2.9 m/s²`, `--` when none.
- Draw a small dot + label on the FFT chart for the top peak per axis.

### 6.10 Statistics

- Per-axis RMS: `sqrt(mean((x - mean(x))²))`.
- Vector RMS (ISO-style resultant): `sqrt(rmsX² + rmsY² + rmsZ²)`.
- 10 s history: array of `{t, rms}`; prune older than 10 s on each 10 Hz update.
- Avg/min/max over the retained window.
- Display with 2 decimals; units `m/s²`.
- File mode: one value per burst; show “Burst RMS” label and avg/min/max equal to it.
- Time chart caption: per-axis RMS.
- Sparkline: last 10 s of vector RMS, rendered as a tiny SVG path at 4 Hz (not a second uPlot).

### 6.11 File source (DVB1)

- Accept `.bin` and `.dvb`; drag/drop and file input.
- Read `File.arrayBuffer()` in a worker if size > 8 MB; cap at 100 MB with a clear error.
- Validate:
  - magic `DVB1`;
  - header length 32;
  - `axes >= 3` (use the first 3);
  - `sampleCount > 0`;
  - `32 + count × axes × 2 <= buffer.length`;
  - sample rate > 0.
- Skip garbage bytes by searching for the next magic, like Python.
- Convert int16 to `Float32Array` m/s² with `DVB1_LSB_TO_MS2`.
- Burst list: `Burst N (seq S)`; metadata: index/total, samples, sample rate, timestamp (local), sequence.
- Selecting a burst:
  - Clear time/FFT charts and caches.
  - Remove gravity per axis.
  - Draw time plots `0..duration`.
  - Adjust Y ranges.
  - Submit full FFT.
  - Update RMS/peaks.
- Burst switch discards the previous burst’s view but keeps the file in memory for fast switching.
- File mode hides reconnect/serial controls; shows the burst selector.

### 6.12 Demo source

**Live synthetic stream (landing)**

- Generate at `imuHz` (default 2000) using a `setInterval`/accumulator, not one timer per sample.
- Signal: sum of 2–4 sinusoids with slowly modulated amplitudes + low-amplitude noise:
  - base peaks around 48, 72, 110, 160 Hz;
  - small drift over time so the dashboard looks alive;
  - per-axis phase/amplitude differences.
- Use a seeded LCG for reproducible tests; production can use a random seed.
- Emit batches every 20 ms to avoid timer overhead.
- No packet loss, no malformed lines; `lost = 0`.
- Mark `DEMO` in the header and status strip.
- Pause generation when the tab is hidden; resume on visibility.

**Demo bursts (parity)**

- Four bursts: 48, 72, 110, 160 Hz; 3200 Hz; 6400 samples.
- `x = 1.1 sin(2πft)`, `y = 0.8 sin(2π·1.5f·t + 0.7)`, `z = 0.6 sin(2π·2f·t + 1.4)`.
- Accessible from a “Demo bursts” menu on the landing/dashboard.
- Selecting one switches to file-like static mode with the burst list visible.

### 6.13 ESC / FC subsystem

**Port**

- “Connect FC” opens a second Web Serial port at 115200.
- Show all granted ports except the sensor port (compare object identity); FC VCP is usually VID `0x0483`.
- Store the last FC port for reconnect; `getPorts()` on load.
- On disconnect: send motor stop if possible, close, update state.

**MSP**

- Encoder/decoder per the format in §2.3.
- Buffer partial responses; resync on `$M>`; validate XOR and command id.
- Telemetry poll: request 139 every 100 ms; parse motor count and the selected channel’s RPM.
- Ignore malformed/partial packets; count errors.

**Motor commands**

- `throttle = 1000 + round(powerPercent × 10)`; clamp 1000–2000.
- Send four equal values for all motors (desktop behavior).
- Start: send immediately; set `escRunning = true`.
- Power change while running: send immediately.
- Stop: ramp from current power down by 5% every 50 ms; send `1000` at the end; set `escRunning = false`.
- Basic warning only (D13): show a props-off modal once per session; no heartbeat and no automatic stop on blur/disconnect in v1.
- Big STOP button always visible when the ESC panel is open.
- Mark “Untested on this hardware” in the panel.
- Keep a `ESC_HEARTBEAT_HZ = 0` constant so a heartbeat can be enabled after hardware testing without restructuring.

**Residual risk (explicit)**

Because v1 follows desktop behavior, motor commands are only sent on start/power change/stop. Some ESCs and Betaflight motor modes expect continuous frames and may stop or behave unexpectedly. The user has accepted this for v1. Before any real propeller test, add a heartbeat and auto-stop-on-disconnect in Phase 4.5.

### 6.14 Export

**PNG**

- Compose an offscreen canvas at 1920 px wide (height derived from layout, e.g. 1080).
- Draw:
  - dark background and header;
  - RMS + peak summary;
  - six chart panels at high resolution (re-render chart data, not a screenshot of the DOM);
  - axis labels, units, timestamps, version.
- Use `canvas.toBlob("image/png")`.
- Filename: `{base}{index:02}_{power}.png`.
- Avoid html2canvas; it is heavy and blurry.

**DVB1 snapshot**

- Live: require 2 s of buffered data; use raw samples (including gravity) from the snapshot ring.
- File: use the last 2 s of the selected burst; adjust `timestampNs` by skipped samples / rate; keep sequence.
- Write header + int16 LE samples exactly.
- Round physical values to raw with **round-half-to-even** to match `np.rint`, clamp to int16.
- Timestamp: `BigInt(Date.now()) * 1_000_000n` minus 2 s for live; file mode uses burst timestamp + offset.
- Filename: `{base}{index:02}_{power}.bin`.
- Validate every exported file with the Python `--debug` parser in tests.

**Paired export**

- Compute the stem once; write both `.png` and `.bin` with the same collision suffix.
- If one fails, report partial success and keep the successful file.

**Destination**

- Default: browser download via `Blob` + `<a download>`.
- Optional: `window.showSaveFilePicker()` (Chromium) + remembered directory handle in IndexedDB.
- Collision handling: session name set; with a directory handle, check existing files and append `_02`, `_03`.
- Base name sanitized: trim, strip path separators/control chars, fallback `snapshot`.
- Index 1–99, power 0–100 (rounded); same as desktop.

### 6.15 Persistence

- `localStorage` key `vibro.settings.v1`: settings, theme, last source, autoplay preference.
- `IndexedDB` (optional): last export directory handle; recent filenames for collision tracking.
- Do not persist sample data by default.
- “Reset settings” action in Advanced.
- No cookies, no analytics, no third-party requests.

### 6.16 PWA

- `vite-plugin-pwa`, `registerType: "prompt"`.
- Precache: HTML, JS, CSS, SVG/PNG icons, manifest.
- `navigateFallback: "index.html"` for the single-page app.
- `cleanupOutdatedCaches: true`; do not `skipWaiting` without user action.
- Update prompt: “New version available — Reload”.
- Manifest:
  - name: “Vibro — Vibration Monitor”
  - short_name: “Vibro”
  - display: `standalone`
  - background/theme: `#070b10`
  - icons: 192, 512, maskable
- Offline: demo and file mode fully work; live mode requires the device and browser.
- The service worker must not cache serial data or export blobs.
- Version/build hash injected at build time and shown in About/footer.

---

## 7. Performance Plan

### 7.1 Budgets

| Metric | Target | Hard limit |
|---|---|---|
| Initial JS (gzip) | ≤ 120 KB | 150 KB |
| Initial CSS (gzip) | ≤ 12 KB | 20 KB |
| First contentful paint (localhost) | < 600 ms | 1.2 s |
| Demo visible and animating | < 1.5 s | 2.5 s |
| Main-thread long tasks during streaming | none > 50 ms | none > 100 ms |
| Chart render (6 charts) | < 6 ms/frame | 12 ms/frame |
| FFT (512 points, per axis) | < 1 ms | 3 ms |
| FFT (6400 → 8192, per axis) | < 8 ms | 20 ms |
| Memory after 1 h demo | < 150 MB | 250 MB |
| Serial CPU impact at 2000 Hz | < 10% of one core | 25% |
| Lighthouse Performance | ≥ 90 | — |
| Lighthouse Accessibility | ≥ 95 | — |

### 7.2 Techniques

- Signals only for UI-level state; sample buffers are plain typed arrays.
- Batch serial lines per chunk; no per-line reactive updates.
- Reuse chart arrays and scratch buffers; no allocations in the hot loop.
- Update charts at the configured rate (default 10 Hz), not per sample.
- FFT in a worker with transferable buffers; latest-wins queue.
- Time-chart min/max decimation when points-per-pixel > 2.
- `requestAnimationFrame` for rendering; `setInterval` for 1 Hz stats.
- Avoid layout reads in the render loop; measure once on resize.
- Preload no fonts; use system fonts.
- Lazy-load the ESC panel and About dialog.
- PWA precache only the app shell; no large demo assets.
- Use `content-visibility: auto` on below-the-fold panels (mobile).
- Profile with Chrome Performance and the uPlot built-in FPS counter; log dropped frames.

### 7.3 Serial throughput guardrails

- At 921600 baud, warn when estimated wire utilization > 80%.
- If `imuHz > 2500`, show a persistent warning: “This text protocol may not fit at 921600 baud.”
- If measured packet rate is below 90% of selected IMU Hz, suggest lowering IMU Hz or checking the cable.
- Count buffer overruns separately from seq gaps; they have different causes.

---

## 8. Testing and Validation

### 8.1 Unit tests

| Area | Cases |
|---|---|
| Parser | Valid lines, negatives, CRLF, split chunks, empty lines, malformed fields, oversized line, sid filter, seq gaps, resets |
| Units | raw↔m/s² for 256 and 2048; DVB1 constant; formatting |
| DVB1 parse | `test_data.bin` (6 bursts, 6400 samples, 3200 Hz), truncated file, garbage before magic, invalid axes, invalid rate |
| DVB1 write | Header bytes, int16 LE, round-half-to-even, clamping, timestamp/sequence BigInt, round-trip |
| FFT | 512-point and 6400→8192; DC/Nyquist handling; amplitude normalization; Hann window; compare to Python golden |
| Peaks | Known synthetic peaks, adjacent bins, low-amplitude noise, DC exclusion, separation, top 3 |
| Stats | Vector RMS, per-axis RMS, 10 s pruning, min/max, single sample |
| Rate meter | Packet rate, loss gaps, reset, malformed, wire utilization |
| MSP | SET_MOTOR packet bytes, telemetry request, response parse, checksum, partial buffers, motor channel |
| ESC | Throttle math, clamp, ramp sequence, stop at zero |
| Naming | Base sanitization, index/power suffix, collision `_02`, paired export |
| Settings | Defaults, validation, persistence, FFT max clamp to Nyquist |

### 8.2 Golden parity fixtures

`scripts/gen_golden.py` uses the Python app’s own modules to generate `tests/fixtures/golden.json`:

- parse `test_data.bin` with `utils.parse_dvb1_file`;
- for each burst, compute:
  - metadata;
  - gravity-removed samples (first/last N values + checksum);
  - time arrays;
  - RMS per axis and vector;
  - FFT using the **same padded length** as the web implementation (8192), Hann window and normalization;
  - top local maxima;
- write JSON with numbers at full precision.

The script is a dev tool, not part of the web build. Commit the JSON so CI does not need Python. Tests compare with tolerance `1e-6` for amplitudes and `1e-9` for frequencies.

**Why padded length matters:** Python’s `rfft` supports 6400 directly; the web uses 8192. To compare, the golden generator must zero-pad to 8192 too. Do not compare 6400-bin frequencies to 8192-bin frequencies.

### 8.3 Component tests

- Vitest + `@testing-library/preact` (or direct DOM) for:
  - settings validation and clamping;
  - peak cards formatting;
  - connect dialog states;
  - export panel filename preview;
  - safety dialog gating;
  - toast behavior.

### 8.4 End-to-end tests (Playwright)

1. **Demo smoke:** load page, wait for demo badge, assert six canvases, RMS text changes over time.
2. **File mode:** upload `test_data.bin`, assert burst count 6, select burst 3, assert metadata and FFT canvas, export snapshot and PNG (intercept downloads).
3. **Settings:** change IMU Hz/FFT max/refresh, reload, assert persistence; assert FFT max clamps.
4. **Mock serial:** `addInitScript` installs a fake `navigator.serial` with a granted port; feed a scripted byte stream; assert packet rate, loss count, charts, reconnect.
5. **Mock FC/ESC:** fake second port; accept warning, start, change power, stop; assert exact MSP bytes; assert ramp sequence.
6. **Unsupported browser:** remove `navigator.serial`; assert support banner and that demo/file still work.
7. **Offline PWA:** build + preview, load, wait for SW, set offline, reload, assert demo works (manual if Playwright SW is flaky).
8. **Accessibility:** axe scan on landing/dashboard; no critical violations.

### 8.5 Hardware test matrix

| Test | Environment | Expected |
|---|---|---|
| Live 2000 Hz, 30 min | Chromium Linux, CH340 | Stable charts, no unhandled errors, memory stable |
| Replug device | Chromium Linux | “Reconnecting…”, auto-reopen, no false huge loss count |
| Port busy | Python app open | Clear error message, no crash |
| Permission denied | Chromium | Friendly error, demo/file still usable |
| 256 vs 2048 sensitivity | Live | Values scale correctly |
| 921600 baud | Live | No buffer overrun at 2000 Hz |
| 3200/4000 Hz | Live | Warning; measure actual throughput; document limit |
| File export | Web → Python `--debug` | Valid DVB1, burst count/metadata match |
| PNG export | Web | 1920 px, all six charts readable |
| Tab hidden/visible | Live | No crash; possible overrun warning; recovers |
| FC/ESC | Not available | Mock tests only; mark untested; no props |

### 8.6 Acceptance checklist

- [ ] `npm run typecheck` clean.
- [ ] `npm run test` green; core coverage ≥ 90%.
- [ ] `npm run test:e2e` green (demo, file, mock serial, mock ESC).
- [ ] `npm run build` succeeds; bundle within budget.
- [ ] Demo auto-starts and runs at 60 fps on a normal laptop.
- [ ] Six charts render and link correctly.
- [ ] FFT values match golden fixtures.
- [ ] DVB1 export accepted by Python `--debug`.
- [ ] PNG export contains all six charts and stats.
- [ ] Live 2000 Hz run for 30 min without errors.
- [ ] Reconnect works after unplug/replug.
- [ ] Settings persist; FFT max cannot exceed Nyquist.
- [ ] Demo/file work in Firefox and Safari.
- [ ] PWA installable; offline demo works.
- [ ] Keyboard navigation and focus states pass.
- [ ] No console errors in demo/file.
- [ ] README and AGENTS.md updated.

---

## 9. Implementation Phases

### Phase 0 — Toolchain and scaffold (0.5 day)

**Tasks**

- Install Node.js + npm and Chromium:
  ```bash
  sudo pacman -S --needed nodejs npm chromium
  node --version
  npm --version
  chromium --version
  ```
- `git init` in `/home/kuba/VibroApp/VibroWebApp`.
- Scaffold Vite + Preact + TypeScript.
- Add `uplot`, `@preact/signals`, `vite-plugin-pwa`, `vitest`, `@playwright/test`.
- Configure strict TS, ESLint/Prettier, `.gitignore`.
- Create the base layout, tokens, and a “hello” dashboard.
- Verify `npm run dev` and open `http://localhost:5173` in Chromium.
- Verify Web Serial exists: `"serial" in navigator` in the console.

**Exit criteria:** dev server runs; Chromium opens the app; TypeScript and tests pass; repo has an initial commit.

### Phase 1 — Demo + charts + stats (2–3 days)

**Tasks**

- Ring buffers and demo source (live synthetic + four bursts).
- Six uPlot charts with theme, linked axes, dynamic Y, grid, tooltips.
- RMS stats, 10 s history, sparkline, peak cards (local maxima).
- Landing/empty state with auto-demo.
- Header, status strip, source badge, responsive layout.
- Dark theme tokens and component styles.
- Basic accessibility: focus, labels, reduced motion.

**Exit criteria:** demo runs smoothly with six live charts; RMS and peaks update; layout works at 1920, 1440, 1024, 768, 390 px; bundle within budget.

### Phase 2 — File mode and exports (2 days)

**Tasks**

- DVB1 parser/writer with tests and `test_data.bin` fixture.
- File input + drag/drop + burst list + metadata.
- Full-burst FFT (zero-padded), peak detection, RMS.
- Snapshot export (download + optional folder picker).
- PNG composition export.
- Paired export and collision naming.
- Python golden fixture generator and parity tests.
- Validate exported DVB1 with `python vibro.py --debug --file`.

**Exit criteria:** file mode matches the desktop for `test_data.bin`; exports are valid; golden tests pass.

### Phase 3 — Live serial (2–3 days)

**Tasks**

- Web Serial connect dialog, granted ports, CH340 filter, “show all”.
- Open/write `start stream\n`, BYOB read loop, byte parser.
- Packet rate, loss, malformed, wire utilization.
- Reconnect, disconnect, forget port.
- Settings: IMU Hz, sensitivity, FFT max clamp, refresh.
- Measured-rate warning.
- Diagnostics panel replacing CPU usage.
- Mock serial Playwright tests.
- Manual hardware run with the CH340 sensor.

**Exit criteria:** live 2000 Hz stable for 30 min; reconnect works; no UI freeze; packet loss detection matches the device; settings persist.

### Phase 4 — ESC/FC (2 days)

**Tasks**

- MSP encoder/decoder + tests.
- FC port connect/disconnect, 115200.
- Safety warning modal, untested badge.
- Start/stop/power/ramp, motor channel.
- RPM telemetry polling and FFT markers.
- Mock FC/ESC tests with exact packet assertions.
- Document residual risk and the deferred heartbeat/auto-stop.

**Exit criteria:** mock tests pass; UI never sends commands without the warning; STOP is always reachable; no real hardware used without props off.

### Phase 4.5 — ESC hardening (only when FC hardware is available)

- Add 20 Hz heartbeat while running.
- Auto-stop on tab hide/blur/disconnect/error.
- Verify MSP timeout behavior.
- Test with props off, then a restrained bench test.

This phase is intentionally separate from v1 because the user has no FC hardware.

### Phase 5 — PWA, polish, performance (2 days)

**Tasks**

- Manifest, icons, service worker, update prompt.
- Offline demo/file.
- Keyboard navigation, focus rings, screen-reader labels.
- Error states, toasts, empty states.
- Bundle analysis and performance tuning.
- Lighthouse audit and fixes.
- README, AGENTS.md, About dialog.
- 1 h demo memory test.

**Exit criteria:** installable PWA; offline demo; Lighthouse targets met; docs complete.

### Phase 6 — Deployment (0.5 day, deferred)

**Tasks**

- Create GitHub repository.
- Add `.github/workflows/deploy.yml`.
- Configure Pages (GitHub Actions).
- Set `VITE_BASE` to `/<repo>/`; test subpath preview.
- Optional custom domain.
- Final smoke test on the public URL.
- Confirm Web Serial works on the Pages origin (HTTPS + user gesture).

**Exit criteria:** public URL loads, demo runs, file mode works, live mode works in Chromium.

**Total estimate:** ~10–13 focused days. AI-assisted implementation may compress this; hardware validation and polish should not be skipped.

---

## 10. Risks and Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | User opens the app in Firefox/Safari and expects live mode | High | Medium | Detect support, show a clear banner, keep demo/file fully functional |
| 2 | Web Serial permission UX confuses users | Medium | Medium | Clear Connect flow, granted-port list, CH340 hint, error help |
| 3 | Multiple identical CH340 devices are ambiguous | Low | Medium | Show index + VID/PID; remember choice; ask when multiple |
| 4 | 921600 baud cannot carry 3200/4000 Hz text | High at high rates | High | Warn, show wire utilization, recommend ≤2500 Hz, document binary upgrade path |
| 5 | Main-thread serial parsing causes jank | Medium | Medium | Batched BYOB reads, fast parser, worker fallback plan |
| 6 | Buffer overrun when tab is backgrounded | Medium | High | 64 KB buffer, visibility handling, reconnect, warning |
| 7 | FFT parity mismatch | Medium | High | Golden fixtures, zero-padding parity, ties-to-even, unit tests |
| 8 | ESC control untested and no heartbeat | High | Critical | Basic warning per D13, big STOP, untested badge, no props, Phase 4.5 |
| 9 | PWA stale cache serves old code | Medium | Medium | Prompt update, version hash, cleanup outdated caches |
| 10 | Large DVB1 files exhaust memory | Low | Medium | 100 MB cap, worker parse, progress, clear errors |
| 11 | GitHub Pages subpath breaks assets/SW | Medium | Medium | Configurable base, test preview under subpath |
| 12 | Browser update changes Web Serial behavior | Low | Medium | Feature detection, graceful fallback, no UA sniffing |
| 13 | No real FC hardware means hidden bugs | High | High | Mock tests, feature warning, defer hardening until hardware |
| 14 | Dark-only theme is not enough for lab use | Low | Low | Tokenized theme; light theme later if requested |
| 15 | Scope creep from “modern UI” | Medium | Medium | Phase gates, core-only tool decision, no extra pages |
| 16 | Service worker caches exported blobs or data | Low | Medium | Do not runtime-cache blobs; app-shell-only precache |

### Rollback / fallback strategy

- The Python app remains untouched and fully usable.
- The web app is a separate project; no migration or data lock-in.
- DVB1 files remain compatible in both directions.
- If Web Serial proves unreliable in a target environment, demo/file mode still delivers value; a local bridge can be added later without changing the UI architecture.

---

## 11. Open Questions

These do not block Phases 0–2; resolve before Phase 3/4.

1. ~~**Sensor model and fixed rate.**~~ **Resolved 2026-10-24:** the CH340 device is fixed at **2000 Hz**. The `imuHz` setting therefore stays at its default; the UI still exposes the other rates but selecting one shows “device is fixed at 2000 Hz — values may be wrong”. No post-`start stream` delay is required.
2. **`stop stream` support.** Does the device accept it? (Current plan: best-effort, ignore errors.)
3. **FC/ESC hardware availability.** When can Phase 4.5 be tested? Which FC/ESC and Betaflight version?
4. **GitHub repository name / custom domain.** Needed for Phase 6 and the exact Pages base path.
5. **Light theme.** Deferred; confirm whether it is wanted after dark v1.
6. **Heartbeat/auto-stop.** Revisit after hardware testing; recommended for any propeller test.
7. **Large files.** Is >100 MB DVB1 support needed? If yes, add streamed parsing.
8. **PNG layout.** Is a dashboard screenshot with all six charts + stats the desired export, or per-chart PNGs?
9. **License.** The Python repo has no explicit license in the reviewed files; decide before publishing.

---

## 12. Appendix A — Feature Parity Checklist

### Source and connection

- [ ] Landing with Connect / Open file / Explore demo
- [ ] Web Serial feature detection and support banner
- [ ] Grant port, reconnect granted port, forget port
- [ ] CH340 VID/PID filter + “show all”
- [ ] 921600 baud; `start stream\n`
- [ ] BYOB reads and line parsing
- [ ] Auto-reconnect with backoff
- [ ] Packet rate, lost packets, malformed lines, resets
- [ ] Sensitivity 256/2048 live scaling

### Charts

- [ ] Six charts: time + FFT for X/Y/Z
- [ ] Scrolling time window
- [ ] Linked time axes and linked FFT axes
- [ ] Dynamic time Y range
- [ ] Dynamic FFT Y range
- [ ] FFT min 4 Hz; max clamped to Nyquist
- [ ] RPM 1×/2× markers
- [ ] Local-maxima peak cards
- [ ] Crosshair tooltips
- [ ] Pause/follow controls
- [ ] Responsive/mobile axis tabs

### Analysis

- [ ] Vector RMS + 10 s avg/min/max
- [ ] Per-axis RMS captions
- [ ] Sparkline
- [ ] File burst metadata
- [ ] Burst selector
- [ ] Full-burst FFT
- [ ] Demo live stream + four bursts

### Export

- [ ] PNG export at 1920 px
- [ ] DVB1 snapshot (live 2 s)
- [ ] DVB1 snapshot (file last 2 s)
- [ ] Paired PNG + DVB1
- [ ] Filename convention + collisions
- [ ] Download and optional folder picker
- [ ] Export validated by Python parser

### ESC/FC

- [ ] FC connect/disconnect at 115200
- [ ] Props-off warning
- [ ] Start/stop/power/ramp
- [ ] Power +/- 1/10
- [ ] Motor channel 1–16
- [ ] MSP 139 RPM telemetry
- [ ] FFT RPM markers
- [ ] Mock tests; untested badge
- [ ] Deferred: heartbeat, auto-stop

### Platform

- [ ] PWA installable
- [ ] Offline demo/file
- [ ] Update prompt
- [ ] English UI
- [ ] Dark theme
- [ ] Keyboard/accessibility
- [ ] No data uploads
- [ ] GitHub Pages-ready

---

## 13. Appendix B — Protocol Reference

### B.1 Serial

```text
Baud: 921600, 8N1
Init: "start stream\n"
Stop: "stop stream\n" (best effort)
Line: S<sid>,<seq>,<x>,<y>,<z>\n
```

- `sid`: sensor id; buffer only `0`.
- `seq`: increments by 1; gap > 1 = loss; gap <= 0 = reset.
- `x,y,z`: int16-range accelerometer counts.
- Live m/s²: `raw * 9.80665 / lsb_per_g`.

### B.2 DVB1

```text
Offset 0   4  "DVB1"
Offset 4   2  version = 1
Offset 6   2  axes = 3
Offset 8   4  sample_rate (u32 LE)
Offset 12  4  sample_count (u32 LE)
Offset 16  8  timestamp_ns (u64 LE)
Offset 24  8  sequence (u64 LE)
Offset 32  ... int16 samples[x,y,z] interleaved
```

- DVB1 m/s²: `raw * 0.0039 * 9.80665`.
- Writer: `round_ties_to_even(sample / DVB1_LSB_TO_MS2)`, clamp int16.

### B.3 MSP

```text
SET_MOTOR (214):
  $M< 08 D6 <m1 lo> <m1 hi> ... <m4 lo> <m4 hi> <xor>

MOTOR_TELEMETRY request (139):
  $M< 00 8B 8B

MOTOR_TELEMETRY response:
  $M> <size> 8B <motor_count> <13-byte records...> <xor>
  record (13 bytes, verified against Betaflight master msp.c):
    +0  rpm             u32 LE
    +4  invalid_pct     u16 LE   (0.01 %, 10000 = 100 %)
    +6  esc_temp        u8       (°C)
    +7  esc_voltage     u16 LE   (0.01 V)
    +9  esc_current     u16 LE   (0.01 A)
    +11 esc_consumption u16 LE   (mAh)
  rpm offset: 1 + (channel - 1) * 13, u32 LE
  payload length: 1 + motor_count * 13 (validate before indexing)
```

- XOR over size, command and payload.
- Throttle: `1000 + power × 10` (1000–2000).

### B.4 Demo burst formulas

```text
fs = 3200 Hz, n = 6400
x = 1.1 sin(2π f t)
y = 0.8 sin(2π 1.5f t + 0.7)
z = 0.6 sin(2π 2.0f t + 1.4)
f ∈ {48, 72, 110, 160} Hz
```

---

## 14. Appendix C — Development Commands

```bash
# Toolchain (CachyOS/Arch)
sudo pacman -S --needed nodejs npm chromium

# Project
cd /home/kuba/VibroApp/VibroWebApp
npm install
npm run dev -- --host 127.0.0.1
# open http://localhost:5173 in Chromium

# Quality
npm run typecheck
npm run test
npm run test:e2e
npm run build
npm run preview

# Python parity fixtures (dev only)
python3 scripts/gen_golden.py

# Validate a web-exported DVB1 with the desktop parser
cd /home/kuba/VibroApp/vibro
python3 vibro.py --debug --file /path/to/exported.bin
```

**Linux serial permissions**

```bash
ls -l /dev/ttyUSB0
groups
# If needed (Arch/CachyOS):
sudo usermod -aG uucp "$USER"
# log out/in, then retry
```

**Chromium diagnostics**

- `about://device-log` for serial events.
- `chrome://flags` should not be needed for Web Serial on stable.
- Close the Python app before connecting in the browser.

---

## 15. Appendix D — Definition of Done

The port is done when:

1. The feature parity checklist in Appendix A is complete (except deferred ESC hardening).
2. The app runs locally with `npm run dev`, and a production build runs with `npm run preview`.
3. Demo, file and live modes all work in Chromium; demo/file work in Firefox and Safari.
4. The exported DVB1 files are byte-compatible with the Python parser.
5. FFT/RMS numbers match the Python golden fixtures.
6. Performance budgets and Lighthouse targets are met.
7. The PWA installs and works offline for demo/file.
8. Safety warnings are present and impossible to miss.
9. README, AGENTS.md and this PLAN.md reflect the final behavior.
10. The Python app remains untouched and usable.

---

## 16. Appendix E — Decision Log

| Date | Decision | Notes |
|---|---|---|
| 2026-10-24 | Full parity including ESC/FC | Safety-gated; later relaxed to basic warning per D13 |
| 2026-10-24 | Chromium-only live | Demo/file everywhere |
| 2026-10-24 | Preact + signals + uPlot | Slim/fast |
| 2026-10-24 | Dark technical dashboard | Modern touch |
| 2026-10-24 | Live synthetic landing demo + four bursts | Public Pages first impression |
| 2026-10-24 | Core only | No auxiliary tool pages |
| 2026-10-24 | New project, localhost now | Pages later |
| 2026-10-24 | FFT uses selected IMU Hz | Fixes 25% frequency error |
| 2026-10-24 | Local maxima peaks | Avoids adjacent-bin duplicates |
| 2026-10-24 | Scrolling time charts | Modern, correct rolling window |
| 2026-10-24 | Downloads + optional folder | Browser-friendly |
| 2026-10-24 | Calibration omitted | Not exposed in desktop UI either |
| 2026-10-24 | Basic ESC warning | No heartbeat/auto-stop; residual risk documented |
| 2026-10-24 | `start stream` only | No `call all`; ESP32 gone |
| 2026-10-24 | Install Node + Chromium | Required for live testing |
| 2026-10-24 | PWA + offline | Demo/file offline |
| 2026-10-24 | English only | Polish labels removed |
| 2026-10-24 | CH340 fixed at 2000 Hz | Live mode defaults to 2000 Hz; other IMU rates warn |
| 2026-10-24 | Node + Chromium installed by user | Toolchain is a documented prerequisite |

---

**End of plan.**  
Implementation starts in Phase 0 after approval. Keep the Python app as the reference implementation and test oracle; do not modify it.



