#!/usr/bin/env python3
"""Regenerate tests/fixtures/golden.json using the desktop app as oracle.

Run from anywhere: `python3 scripts/gen_golden.py` (numpy + the vibro deps
PyQt6/pyserial/psutil/pyqtgraph for the module imports). The golden values
come from the *unmodified* Python modules (`vibro/fft_worker.py`,
`vibro/utils.py`, `vibro/app.py:find_fft_peaks`).

Two FFT modes are captured per burst/axis:
  full: the whole 6400-sample window at the burst rate (3200 Hz) — the
        file-mode spectrum (n = 6400 is not a power of two; the web port
        uses Bluestein here, numpy uses pocketfft).
  live: the LAST 512 samples (MAX_FFT_POINTS) at the default live sample
        rate 2 * DEFAULT_FFT_MAX_FREQ = 1600 Hz.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
VIBRO_DIR = ROOT.parent / "vibro"
FIXTURE = ROOT / "tests" / "fixtures" / "test_data.bin"
OUT = ROOT / "tests" / "fixtures" / "golden.json"

sys.path.insert(0, str(VIBRO_DIR))

# Headless stub: fft_worker imports PyQt6.QtCore for the QThread plumbing
# only; the compute_fft math below is the untouched module code.
import types  # noqa: E402


def _stub_module(name: str, attrs: dict) -> None:
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module


_stub_module("PyQt6", {})
_stub_module(
    "PyQt6.QtCore",
    {"QThread": type("QThread", (), {}), "pyqtSignal": lambda *a, **k: None},
)

import config  # noqa: E402
from fft_worker import FFTWorker  # noqa: E402
from utils import remove_gravity_component  # noqa: E402

WINDOW = 6400
AXES = ("x", "y", "z")


# Verbatim copy of vibro/app.py:find_fft_peaks (pure numpy) so this script
# does not import the PyQt6 GUI stack.
def find_fft_peaks(frequencies, amplitudes):
    if len(frequencies) < 2:
        return []
    non_dc_indices = np.arange(1, len(frequencies))
    peak_indices = non_dc_indices[np.argsort(amplitudes[non_dc_indices])[-3:][::-1]]
    return [(frequencies[index], amplitudes[index]) for index in peak_indices]


def main() -> None:
    data = np.fromfile(FIXTURE, dtype=np.int16)
    n_bursts = data.size // (WINDOW * 3)

    # Frequency axes for the two FFT modes (shared by all bursts).
    full_freqs = np.fft.rfftfreq(WINDOW, 1.0 / config.DVB1_SAMPLE_RATE)
    live_n = config.MAX_FFT_POINTS
    live_fs = 2.0 * config.DEFAULT_FFT_MAX_FREQ
    live_freqs = np.fft.rfftfreq(live_n, 1.0 / live_fs)

    bursts = []
    for burst in range(n_bursts):
        base = burst * WINDOW * 3
        samples = data[base : base + WINDOW * 3].astype(np.float64) * config.DVB1_LSB_TO_MS2
        axes = [samples[ax :: 3] for ax in range(3)]
        axes = [np.asarray(g) for g in remove_gravity_component(axes)]

        rms = [float(np.sqrt(np.mean(a ** 2))) for a in axes]
        rms_total = float(np.sqrt(sum(r * r for r in rms)))

        entry = {"burst": burst, "rms_total": rms_total, "axes": {}}
        for ax, name in enumerate(AXES):
            signal = axes[ax]

            f_full, a_full = FFTWorker.compute_fft(signal, config.DVB1_SAMPLE_RATE, full=True)
            f_live, a_live = FFTWorker.compute_fft(signal, live_fs, full=False)

            entry["axes"][name] = {
                "rms": rms[ax],
                "full": {
                    "amps": [round(float(v), 12) for v in a_full],
                    "peaks": [[float(f), float(a)] for f, a in find_fft_peaks(f_full, a_full)],
                },
                "live": {
                    "amps": [round(float(v), 12) for v in a_live],
                    "peaks": [[float(f), float(a)] for f, a in find_fft_peaks(f_live, a_live)],
                },
            }
        bursts.append(entry)
        print(f"burst {burst}: done", file=sys.stderr)

    OUT.write_text(
        json.dumps(
            {
                "window": WINDOW,
                "dvb1_rate": config.DVB1_SAMPLE_RATE,
                "live_fs": live_fs,
                "max_fft_points": live_n,
                "full_freqs": [round(float(f), 9) for f in full_freqs],
                "live_freqs": [round(float(f), 9) for f in live_freqs],
                "bursts": bursts,
            }
        )
    )
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
