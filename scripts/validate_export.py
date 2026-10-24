#!/usr/bin/env python3
"""Validate a web-exported DVB1 file with the desktop parser (byte parity gate).

Usage: python3 scripts/validate_export.py tests/.artifacts/exported.bin
Exits non-zero when the file cannot be parsed like utils.parse_dvb1_file does.
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]  # VibroApp root (contains vibro/)
sys.path.insert(0, str(REPO / "vibro"))

import numpy as np  # noqa: E402
import utils  # noqa: E402


def main(path: str) -> int:
    bursts = utils.parse_dvb1_file(path)
    if not bursts:
        print(f"FAIL: {path}: no bursts parsed")
        return 1
    for i, burst in enumerate(bursts):
        samples = burst["samples"]
        if samples.shape[1] != 3:
            print(f"FAIL: burst {i}: expected 3 axes, got {samples.shape}")
            return 1
        if not np.all(np.isfinite(samples)):
            print(f"FAIL: burst {i}: non-finite samples")
            return 1
        if burst["sample_rate"] <= 0:
            print(f"FAIL: burst {i}: bad sample rate {burst['sample_rate']}")
            return 1
        print(
            f"OK: burst {i}: {burst['sample_count']} samples @ "
            f"{burst['sample_rate']} Hz, seq {burst['sequence']}, "
            f"x rms {np.sqrt((samples[:, 0] ** 2).mean()):.4f} m/s2"
        )
    return 0


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else str(
        REPO / "VibroWebApp" / "tests" / ".artifacts" / "exported.bin"
    )
    sys.exit(main(target))
