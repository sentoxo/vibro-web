# Vibro Web

Real-time vibration analysis in the browser — a port of the [Vibro desktop app](https://github.com/sentoxo/vibro)
(PyQt6 + pyserial) to a static web app. No backend: the app talks to the CH340 ADXL345 sensor
directly over **Web Serial**, parses the same `S<sid>,<seq>,<x>,<y>,<z>` text protocol, and keeps
the desktop's math (FFT, RMS, peaks, DVB1 format) bit-for-bit compatible.

**Live demo:** the deployed app autoplays a synthetic stream — no hardware needed.

## Features

- **Live sensor** over Web Serial (Chrome/Edge): CH340 at 921600 baud, desktop startup handshake
  (`call all` → 3 s → `start stream`), auto-reconnect, one-time packet-loss modal.
- **Six charts**: time-domain X/Y/Z + FFT X/Y/Z, 2 s window with 0.2 s zoom, RPM marker lines,
  FFT peak labels, cursor sync.
- **Hero RMS**: ISO-style vector resultant `√(x²+y²+z²)` with 10 s rolling avg/min/max and sparkline.
- **File mode**: open multi-burst `.bin` (DVB1 container) files, pick a burst, full-length true-N FFT
  (6400 samples = 0.5 Hz resolution via Bluestein chirp-z).
- **Demo mode**: four synthetic bursts at 48/72/110/160 Hz, identical to the desktop demo.
- **ESC / FC control**: second serial port at 115200 baud, MSP v1 (`SET_MOTOR` 214,
  `MOTOR_TELEMETRY` 139), RPM readout, safety dialog, stop ramp — desktop parity.
- **Export**: dashboard PNG + DVB1 snapshot; filenames follow the desktop `{base}{index:02d}_{power}`
  convention; byte-compatible with the Python recorder (np.rint ties-to-even quantization).
- **PWA**: installable, offline shell, update prompt.
- Works offline after first load; settings persist in `localStorage`.

## Browser support

| Mode | Chrome / Edge | Firefox / Safari |
| --- | --- | --- |
| Live sensor + ESC | ✅ (Web Serial) | ❌ |
| Demo, file analysis, export, PWA | ✅ | ✅ |

## Development

```bash
npm install
npm run dev          # Vite dev server at http://127.0.0.1:5173
npm run typecheck    # tsc --noEmit
npm test             # unit + DOM tests (vitest)
npm run test:e2e     # Playwright against a production preview build
npm run build        # dist/ (production, PWA assets included)
npm run preview      # serve dist/
```

The desktop app in `../vibro` is the behavioral oracle — do not modify it.
When its protocol, math, or file format changes, re-baseline the port and regenerate
the fixtures (see [AGENTS.md](./AGENTS.md)).

## Testing the DVB1 byte contract

`npm run test:e2e` exports a snapshot from the browser to `tests/.artifacts/exported.bin`;
verify it with the desktop's own parser:

```bash
python3 scripts/validate_export.py tests/.artifacts/exported.bin
```

Golden FFT/peaks/RMS fixtures live in `tests/fixtures/golden.json`; regenerate them
against the Python code with `npm run golden` (requires numpy; PyQt6 is stubbed).

## Deployment

Static hosting of `dist/` (GitHub Pages via the included workflow). Set the base path with
`VITE_BASE=/repo-name/ npm run build`.

## Documentation

- [PLAN.md](./PLAN.md) — the approved architecture and decisions (protocol sections superseded where the desktop app has moved on).
- [AGENTS.md](./AGENTS.md) — contributor/agent guide: layout, parity rules, fixture regeneration, gotchas.
