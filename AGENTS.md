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
dev CLI tools — out of app scope.

## Layout

```
src/core/        pure logic: parser, fft (radix-2 + Bluestein), peaks, stats, dvb1, msp, esc,
                 naming, units, rate-meter, ring-buffer, settings, constants, types
src/workers/     fft.worker.ts (spectrum off-thread), + sources/dvb1.worker.ts (parse off-thread)
src/sources/     demo.ts, serial.ts (Web Serial sensor), file.ts (FileSource), source.ts
src/state/       store.ts (central orchestration), settings.ts, exporter.ts, toasts.ts
src/charts/      chart.ts (uPlot factory), export-png.ts
src/components/  Preact components (Header, Landing, ChartGrid, SettingsDrawer, EscPanel, …)
tests/unit/      vitest node project (parser/fft/golden/stats/peaks/dvb1/msp/esc/naming/units/…)
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
  first loss in a session opens a one-time modal. A manual connect clears the counters and uses
  a fresh sequence baseline, so disconnect → connect without unplugging reports zero loss.
  Automatic reconnect keeps session totals but re-baselines seq (the outage gap is not loss) and
  re-acquires the port from `navigator.serial.getPorts()` (Chrome issues a new handle after replug).
- **Link rate**: diagnostics show measured payload `rate × avgLineBytes` in KB/s. Do not compute a
  percentage of the nominal baud rate: the sensor is an STM32 USB CDC device (USB full speed), so
  921600 is line coding, not the transport ceiling.
- **ESC**: throttle `1000 + power*10` with Python `int(round())` banker's rounding; stop ramp
  5 % per 50 ms step (allowed from idle when FC connected); commands only on start/change/stop.
- **MSP v1**: `$M<`/`$M>` size cmd payload xor (xor over size+cmd+payload); telemetry record
  check is `len >= offset + 4` (desktop loose rule), records are 13 bytes.
- **Files/naming**: `{base}{index:02d}_{power}` with `_02` collision suffixes; demo burst
  snapshot always fails with `Waiting for 2 seconds of data (0.0 seconds available)`.

## Superseded PLAN.md decisions (port re-baselined to the current desktop app)

- D8 → live FFT is 512 samples at `2×fftMaxHz`, not the imuHz axis.
- D9 → peaks are top-3 raw bins (no min amplitude / separation).
- D10 → time x-axis is `0..windowSeconds`, not `-win..0`.
- D14 → handshake is `call all` → 3 s → `start stream` (no heartbeat; the current desktop has none).
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
- `ESC_HEARTBEAT_HZ = 0` is dead/documentation; `fftMaxChoicesFor(_imuHz)` returns all choices for
  API compatibility. The measurement readout is `formatDataRate` (KB/s), never a baud percentage.
- **Fake serial reconnect**: the mock port recreates its streams on `open()` and is nullable when
  closed (real `SerialPort.readable`/`writable` are null after close). `simulateSensorLoss()`
  errors the pending read and dispatches a `disconnect` event; the pump keeps advancing `seq`
  while detached, which is exactly the no-loss baseline test for auto-reconnect.

## Definition of done (any feature change)

`npm run typecheck` + `npm test` + `npm run build` clean; e2e green when the change touches UI
flows, serial, file mode, export, or settings; keep the main entry ≤ 150 kB gzipped (CI enforces it).
