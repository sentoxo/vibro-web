# AGENTS.md — Vibro Web

Contributor/agent guide. Read [PLAN.md](./PLAN.md) for the full architecture; this file records
the hard parity rules, the deltas where the port was re-baselined to the **current** desktop app,
and the environment gotchas learned the hard way.

## The oracle rule

`../vibro` (Python/PyQt6 desktop app) is the ground-truth oracle. **Never modify it.** When in
doubt about behavior, read:

| Question about | Source file |
| --- | --- |
| Orchestration, RMS, peaks, naming, snapshots, ESC ramp, handshake timing | `vibro/app.py` |
| Constants (FS, MAX_FFT_POINTS=512, DVB1, sensitivity, SEQ_LINE regex) | `vibro/config.py` |
| FFT math (`compute_fft`, tail-512 cap, Hann, scale) | `vibro/fft_worker.py` |
| Serial protocol, `call all`/`start stream`, sensitivity commands, reconnect | `vibro/serial_io.py` |
| DVB1 parse/write, gravity removal | `vibro/utils.py` |
| MSP telemetry record rules | `vibro/esc_telemetry.py` |

`com_log.py`, `seq_analyzer.py`, `test.py`, `fettec_ctl.py` in the desktop repo are standalone
dev CLI tools — out of app scope. For **FETtec OneWire** the oracle is *not* the desktop:
read the FETtec configurator (`gui.fettec.net/js/ESC/onewire.js`, `js/ESC/protocol/bf_pt.js`,
`js/common/OW_commands.js`, `ESC/main.js`) and ArduPilot `libraries/AP_FETtecOneWire`.
`vibro/fettec_ctl.py` is a defective prototype — see [FETtec gotchas](#fettec-gotchas).

## Layout

```
src/core/        pure logic: parser, fft (radix-2 + Bluestein), peaks, stats, dvb1, msp, esc,
                 naming, units, rate-meter, ring-buffer, settings, constants, types;
                 fettec/ = OneWire protocol, controller, signal check, bus session
src/workers/     fft.worker.ts (spectrum off-thread), + sources/dvb1.worker.ts (parse off-thread)
src/sources/     demo.ts, serial.ts (Web Serial sensor), file.ts (FileSource), fettec-serial.ts
src/state/       store.ts (central orchestration), settings.ts, exporter.ts, toasts.ts,
                 fettec-session.ts (store ↔ bus ↔ controller)
src/charts/      chart.ts (uPlot factory), export-png.ts
src/components/  Preact components (Header, Landing, ChartGrid, SettingsDrawer, EscPanel,
                 MspEscPanel, FettecPanel (lazy), SafetyDialog, …)
tests/unit/      vitest node project (parser/fft/golden/stats/peaks/dvb1/msp/esc/fettec/…)
tests/dom/       vitest jsdom project (settings persistence)
tests/e2e/       Playwright specs (+ support/fake-serial.ts mock)
tests/fixtures/  test_data.bin (6×6400@3200 DVB1 container), golden.json, py_dvb1_*.bin
scripts/         gen_golden.py (fixture regeneration), validate_export.py (byte-parity gate)
```

## Parity contract (verified by tests)

- **FFT**: `computeSpectrum` mirrors `fft_worker.compute_fft`: mean removal → `np.hanning` →
  `|rfft|/n/(sum(w)/n)`, interior bins ×2; live mode caps to the **tail 512** samples.
  n=512 is radix-2; n=6400 (file bursts) is **not** a power of two → Bluestein chirp-z computes
  the exact DFT (no zero-padding). Tolerance to golden fixtures: 1e-6 amplitude.
- **Peaks** (`find_fft_peaks`): top 3 **raw bins** by amplitude over indices 1..N-1 (DC excluded),
  strongest first, ties → higher bin index first (stable ascending argsort, taken from the end,
  reversed). No min-amplitude, no bin separation.
- **Hero RMS**: per-axis `sqrt(mean(x²))` after gravity removal, combined as the **vector
  resultant** `sqrt(rx²+ry²+rz²)`; 10 s rolling avg/min/max.
- **Live FFT axis**: runs at `live_sample_rate = 2 × fftMaxHz` on the last 512 samples;
  `fftMaxHz` is independent of `imuHz` (all choices always valid, no Nyquist clamp).
- **Time charts**: x-axis 0..windowSeconds (2 s / 0.2 s zoom).
- **DVB1**: container of concatenated bursts; per-burst header = `"DVB1"` + `struct "<HHIIQQ"`
  (32 bytes: magic, version, axes, rate, count, timestamp_ns, sequence), then `count*axes` LE
  int16 samples at `0.0039*9.80665` ms/s² per LSB. Quantization = `np.rint` (ties-to-even) +
  int16 clamp (`roundHalfToEven`). Parser resyncs over garbage (magic scan) and drops a
  truncated trailing burst. Fixtures `tests/fixtures/py_dvb1_*.bin` were written by the real
  `utils.write_dvb1_file`; `npm run test:e2e` + `python3 scripts/validate_export.py` gate
  the web→Python direction.
- **Serial**: `call all\n` on open → 3 s → `start stream\n`; packet rate counts all valid lines;
  loss = seq gaps on sid==0 lines (`gap = seq - last_seq`, no mod-wrap normalization);
  first loss in a session opens a one-time modal. A manual connect starts a **new session**:
  counters reset, the first sequence id is a new baseline, and the previous session's loss
  dialog is dismissed. Each (re)connect also gets a new `epoch`; read loops, parsers, handshake
  timers and stats timers bound to an older epoch are ignored, so late chunks from the closed
  session can never feed the new one. The first `LOSS_SETTLE_MS` (1.5 s) of a session re-baselines
  seq jumps instead of counting them: a reopened USB CDC link drains a backlog and can drop
  samples while the host catches up. Automatic reconnect keeps session totals but re-baselines seq
  (the outage gap is not loss) and re-acquires the port from `navigator.serial.getPorts()`
  (Chrome issues a new handle after replug).
- **Link rate**: diagnostics show measured payload `rate × avgLineBytes` in KB/s. Do not compute a
  percentage of the nominal baud rate: the sensor is an STM32 USB CDC device (USB full speed), so
  921600 is line coding, not the transport ceiling.
- **ESC**: throttle `1000 + power*10` with Python `int(round())` banker's rounding; stop ramp
  5 % per 50 ms step (allowed from idle when FC connected); commands only on start/change/stop.
- **FETtec ESC** (separate from the MSP path, `src/core/fettec/`): OneWire config frames
  `[src, id, typeLo, typeHi, length, msg, payload…, crc8]` with CRC-8 poly **0x07**; reply
  sources `0x02` bootloader / `0x03` firmware; reply payloads have **no message-id prefix**.
  Fast throttle is one frame of `ceil((12+11N)/8)` bytes *before* the CRC (N=8 → 13 + CRC =
  14 bytes total), byte 0 `0x80|(slot<<4)|((v0>>10)&1)<<3|0x01`, byte 1
  `((v0>>7)&7)<<5|0x1F`, then 11-bit MSB-first values, CRC last. Fast telemetry = 2
  big-endian bytes per ESC per requested slot (0 temp signed, 1 V, 2 A signed, 3 ERPM×100,
  4 mAh, 5–7 debug); `rpm = erpm*2/poles`. Continuous ~100 Hz frames are mandatory (250 ms
  failsafe); per-motor values are 0..100 % and ramps are 5 %/50 ms, `emergencyStop()` is
  immediate. Passthrough is
  entered with `serialpassthrough esc_sensor 2000000 rxtx reset` and left by dropping DTR.
- **MSP v1**: `$M<`/`$M>` size cmd payload xor (xor over size+cmd+payload); telemetry record
  check is `len >= offset + 4` (desktop loose rule), records are 13 bytes.
- **Files/naming**: `{base}{index:02d}_{power}` with `_02` collision suffixes; demo burst
  snapshot always fails with `Waiting for 2 seconds of data (0.0 seconds available)`.

## Superseded PLAN.md decisions (port re-baselined to the current desktop app)

- D8 → live FFT is 512 samples at `2×fftMaxHz`, not the imuHz axis.
- D9 → peaks are top-3 raw bins (no min amplitude / separation).
- D10 → time x-axis is `0..windowSeconds`, not `-win..0`.
- D14 → handshake is `call all` → 3 s → `start stream` (no heartbeat; the current desktop has none).
- D13 → superseded for the **FETtec path only** (D19): continuous OneWire frames + auto-stop on
  blur/port loss/250 ms failsafe. The MSP path keeps `ESC_HEARTBEAT_HZ = 0` and desktop behavior.
- DVB1 header is 32 bytes without sensitivity/filter fields (PLAN described an older 40-byte layout);
  the "resync maxSamples" rule is gone — files are multi-burst containers.
- Desktop CPU stat → web render-ms/FPS readout; desktop updater → PWA update prompt.
- PLAN's wire-utilization percentage → measured KB/s (STM32 USB CDC, no baud budget to divide by);
  the >80 % warning and the 921600-baud IMU-rate warning are gone.
- Time charts use `0..durationSeconds` everywhere, including the PNG export (the old
  `-duration..0` range clipped every live curve off-screen). `Freeze/Resume` lives in the header.
- Landing auto-demo stream is a web-only extra; app "Demo" mode = the 4 static bursts.

## Commands

```bash
npm run golden          # regenerate tests/fixtures/golden.json from ../vibro (numpy only; PyQt6 stubbed)
npm test                # unit (node) + dom (jsdom) projects
npm run test:e2e        # Playwright; builds VITE_E2E=1 (exposes window.__store), preview on :4173
python3 scripts/validate_export.py <file>   # parse a web export with the desktop parser
npm run format          # prettier (config in .prettierrc, printWidth 120)
```

E2E downloads `tests/.artifacts/exported.bin` during the file-mode spec; the CI job feeds it to
`validate_export.py`. `scripts/gen_golden.py` imports the real `fft_worker`/`utils` with a
`PyQt6.QtCore` stub — the desktop repo must be present at `../vibro`.

## Gotchas (all cost real debugging time)

- **File visibility lag**: after writing files, verify content (grep) before trusting a build/test run.
- **Vitest 5** with `projects`: `unit` = node env (`tests/unit/**`), `dom` = jsdom (`tests/dom/**`);
  jsdom is required only for `localStorage`.
- **Preact 11 + @preact/signals 2.11** (PLAN assumed Preact 10; API compatible). Store is a plain
  class of signals; components read `.value`.
- **uPlot 1.6.32**: plugins are `{ hooks: { draw: [fn] } }`; `setSize({ width, height })`;
  `cursor.sync.key` is a string; `focus.prox` must be a number; the Drag plugin needs a cast for
  `dragging`/`fired`.
- **vite-plugin-pwa v2** client: `registerSW({ immediate: true, ... })` returns
  `updateSW(reloadPage?)`; `onNeedRefresh()` takes no args.
- **Playwright mock serial**:
  - `navigator.serial` is a readonly accessor → install the mock with
    `Object.defineProperty(navigator, "serial", { get: () => api })`.
  - The sensor link reads **BYOB mode** → the fake readable must be created with
    `type: "bytes"`, and Chrome's byte-stream controller requires **ArrayBufferView** chunks
    (enqueue `Uint8Array`, not `ArrayBuffer`).
  - The ESC panel reads default mode → its fake port must be a default (non-bytes) stream.
  - Preact delegated `onInput` can swallow `locator.fill()` → use `pressSequentially`.
  - The packet-loss modal is a real modal: it blocks ESC-panel clicks → tests that exercise ESC
    must pass `{ simulateLoss: false }` to the fake serial installer.
  - START can race the 100 ms telemetry poll for the port writer (the desktop "command dropped"
    case) → the test retries START until `esc.running` flips.
- **Arch Linux hosts**: `npx playwright install chromium` only (no `--with-deps`; sudo fails);
  system libraries are already present on the dev machine.
- `ESC_HEARTBEAT_HZ = 0` is dead/documentation for the **MSP path only** (desktop parity); the
  FETtec path always runs continuous frames. `fftMaxChoicesFor(_imuHz)` returns all choices for
  API compatibility. The measurement readout is `formatDataRate` (KB/s), never a baud percentage.
- **Fake serial reconnect**: the mock port recreates its streams on `open()` and is nullable when
  closed (real `SerialPort.readable`/`writable` are null after close). `simulateSensorLoss()`
  errors the pending read and dispatches a `disconnect` event; the pump keeps advancing `seq`
  while detached, which is exactly the no-loss baseline test for auto-reconnect. On the second
  `open()` (manual or automatic reconnect) the pump drops 7 packets one chunk after the baseline,
  reproducing the real-hardware post-reopen backlog gap that must **not** raise the loss warning.
- **Session epochs**: `SerialSource` binds each read loop/timer to an `epoch`; `stop()` and every
  connect bump it. Don't move cross-session state (parser, seq tracker, stats patches) outside
  that guard — a stale callback resurrecting `lostPackets` was the phantom-warning bug.

## FETtec gotchas

The OneWire protocol has almost nothing in common with MSP. These cost real debugging time.

- **The prototype is not an oracle.** `../vibro/fettec_ctl.py` computes a negative pad in
  `pack_fast_throttle` for N ≥ 3 (crashes 8-motor rigs), defaults the ESC bus to 115200 instead
  of 2 Mbit, decodes ArduPilot 11-byte telemetry instead of fast-slot telemetry, and its CLI line
  lacks `rxtx`/`reset`. Keep it untouched; use the configurator + ArduPilot instead.
- **CRC is poly 0x07, not 0xD5.** The configurator's `update_crc8` and ArduPilot's
  `crc8_dvb_update(..., 0x7)` agree; 0xD5 belongs to DVB-S2. `crc8Dvb` exists only as a
  back-compat alias for the plan's original name.
- **Fast-throttle byte 0** is `0x80 | (slot<<4) | ((v0>>10)&1)<<3 | 0x01`: the telemetry slot is
  bits 4..6, and `0x80` is required. `unpackFastThrottle` starts ESC 1 at **bit 23** (byte 2 bit 0);
  a bit-offset-18 unpacker silently shifts every value.
- **`SET_FAST_COM_LENGTH` carries the full frame length including CRC**
  (`ceil((12+11N)/8)+1`; N=8 → 14, N=2 → 6, N=1 → 4). The command length before the CRC is one
  less. Sending the command length makes the ESC wait for a byte that never comes.
- **Config reply payloads have no message-id prefix**: REQ_TYPE → 1 type byte, REQ_SW_VER →
  version+subversion, REQ_SN → 12 serial bytes, OK/SET_* ack → one `0` byte.
- **Half-duplex echo.** Our own frames come back. `extractFrames` only accepts sources 0x02/0x03
  with a valid CRC (so echo/noise/truncation are skipped by construction). Fast telemetry has no
  CRC: `consumeFastReply` prefers the exact echo, but real 4in1 rigs **bit-flip echo bytes** (field
  log: byte 3 `FA→F8`, byte 0 `0x91→0x81` slot bit, `0x91→0x11` bit 7 — the 2 Mbit turnaround
  collides with the ESC's reply start). So a full-length buffer is length-skipped and parsed
  **without validating the echo** (configurator/ArduPilot rule); validating byte 0's
  `0x80|slot<<4` marker rejects exactly the frames the bus corrupts most → "timeouts == frames".
  The loop clears its buffer every cycle, so full length = the reply.
- **Telemetry mode.** Fast-slot mode (`SET_TLM_TYPE 0`, 2 bytes/ESC/slot) is the configurator
  default. It is sent explicitly but a timeout/NOT_OK is tolerated (not every firmware acks it).
  Then `SET_FAST_COM_LENGTH` must be acknowledged.
- **Reply window = USB poll quantization.** Linux polls the FC's CDC interface in 16 ms frames;
  first bytes measurably arrive at +15/16 ms, and a reply split across two polls lands at ~32 ms.
  The 20 ms window sat exactly on that boundary and clipped them (field log: timeouts with
  `8 B rx +16 ms` = full echo, telemetry in the next poll). Default is **40 ms**; timeouts with a
  *partial* byte count at +16 ms mean raise the setting, not that the bus is faulty. A
  one-byte-short window (`15 B rx`) is a real CDC byte loss — rare, self-healing next cycle.
- **Leaving passthrough needs a DTR drop.** Betaflight never exits on its own; the CLI line ends
  in `reset`, and `port.setSignals({ dataTerminalReady: false })` reboots the FC. Zero the motors
  ×3 first. The fake port records DTR transitions in `fettecSignals()`.
- **BF holds the motor pins high in passthrough.** An ESC fed from the FC pins still answers
  telemetry but ignores bus throttle; the signal check's "FC pin signal" verdict is *inferred*,
  never a direct PWM measurement. ESCs that never answer are "not on the OneWire bus".
- **One persistent writer.** The bus keeps a single writer for the whole session; taking a fresh
  `getWriter()` per write races and drops frames (the same failure the MSP panel fixed with a
  serialized write queue).
- **Signal check must start before setMotor.** `runSignalCheck` calls `io.start()` first; a stop
  ramp wins over `setMotor`, so the old order suppressed every test pulse and every ESC looked
  like an FC-pin ESC.
- **Settings are captured at connect.** Count, ID base, poles and bus baud are read once by
  `fettecSession.connect`; the drawer disables those structural fields while connected and they
  take effect on reconnect.
- **Port loss / write error = stop.** Write errors and disconnects zero the motors, pause the loop and show a banner.
  A hidden tab no longer force-stops (user decision): background timers are throttled, so the ESC's 250 ms **hardware**
  failsafe spins the motors down while the tab is hidden, and the ramp targets resume driving them when it shows again.
- **Lazy panel.** `FettecPanel` is `lazy()` + `Suspense` from `EscPanel`; keep FETtec modules out
  of the entry import graph or the 150 kB gzip cap breaks.
- **Fake serial**: the FETtec port is the third kind (`sensor` → `fc` → `fettec`;
  `setNextPort("fettec")` forces it), uses default (non-bytes) streams, echoes the fast-throttle
  frame plus a 16-byte TLM block, models per-motor RPM/current, and ESC index 4 ignores bus
  throttle (the fc-pin case). `fettecFrames()` / `fettecSignals()` expose captures.
- **Playwright names**: `getByRole(..., { name: "Connect FETtec" })` also matches "Disconnect
  FETtec" (substring, case-insensitive) — pass `{ exact: true }`.

## Definition of done (any feature change)

`npm run typecheck` + `npm test` + `npm run build` clean; e2e green when the change touches UI
flows, serial, file mode, export, or settings; keep the main entry ≤ 150 kB gzipped (CI enforces it).
