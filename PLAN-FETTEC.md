# FETtec ESC over Betaflight passthrough — implementation plan

Feature: connect to FETtec OneWire ESCs through a Betaflight FC in
`serialpassthrough esc_sensor` mode, inside the app's **ESC control** panel, plus a
box that reports whether each motor is driven by the **FETtec OneWire bus** or by the
**FC signal pins (PWM/DShot)**. 8 motors (2 ESCs on one bus).

Oracle for this subsystem: the FETtec configurator JS
(`gui.fettec.net/js/ESC/onewire.js`, `js/ESC/protocol/bf_pt.js`, `js/common/OW_commands.js`,
`ESC/main.js`) and ArduPilot `AP_FETtecOneWire`. The app's `../vibro/fettec_ctl.py` is
**not** an oracle — see "Prototype defects".

---

## Facts verified from the sources

| Item | Verified result |
| --- | --- |
| Enter passthrough | open VCP @115200 → write `#` → CLI banner → `serialpassthrough esc_sensor 2000000 rxtx reset\n` → ~1.5 s settle (ESCs enter OneWire/bootloader) |
| ESC bus baud | **2 000 000** (FETtec GUI `BF_PT`); `BF_PT_5k` = 500 000. Host/USB side stays 115200 |
| BF side effects | `motorDisable()` + every motor tag `IOHi()` → FC PWM/DShot output is killed for the whole passthrough session |
| Exit | BF never leaves passthrough; with the `reset` arg, dropping DTR reboots the FC → `port.setSignals({ dataTerminalReady: false })` |
| Frame | `[0x01, id, typeLo, typeHi, len, msg, payload…, crc8]`, `len` = whole frame length, CRC-8 poly **0x07** over all bytes before the CRC (configurator `update_crc8`, ArduPilot `crc8_dvb_update(..., 0x7)`; 0xD5 is DVB-S2); reply source `0x02` = bootloader, `0x03` = firmware |
| Fast throttle | `ceil((12 + 11·N)/8)` bytes **before the CRC** (N=8 → 13 + CRC = 14 B full frame). byte0 = `0x80 \| (tlmSlot<<4) \| ((v0>>10)&1)<<3 \| 0x01`, byte1 = `((v0>>7)&7)<<5 \| 0x1F` (ALL_ID), MSB-first 11-bit stream, CRC last; ESC 1 starts at bit 23. `1000` = stop, `1010..2000` forward, `0..990` reverse, `991..1009` dead band |
| TLM init | `SET_TLM_TYPE 0` (fast slots, the configurator default; ack tolerated as missing), then `SET_FAST_COM_LENGTH <fullLen> <minId> <count>`; ack payload starts with `OW_OK` |
| TLM reply | 2 bytes (big-endian) per ESC, ID order from `minId`: Temp, Voltage, Current, **ERPM ×100**, Consumption (mAh), Debug1, Debug2, Debug3. Slot 2 is signed. `rpm = erpm * 2 / poles` |
| Round robin | one requested TLM slot per frame → 100 Hz / 8 ESCs ≈ **12.5 Hz per motor** |
| Failsafe | ESC stops motors after 250 ms of silence → continuous ~100 Hz frames are mandatory |
| Echo | the host's own bytes come back on the half-duplex bus; the configurator counts `SentThrottleBytes` and skips them, plus validates the echoed last CRC. Our parser is CRC-validated, so echo/noise are skipped by construction |

### Prototype defects (`../vibro/fettec_ctl.py`)

- `pack_fast_throttle`: `pad = (nbytes-3)*8 - nacc` is **negative for N ≥ 3** → Python
  `ValueError`; `spin`/`monitor`/`interactive` crash on an 8-motor rig (only N ≤ 2 works).
- Default ESC baud 115200 vs the real 2 Mbit bus.
- Decodes the ArduPilot 11-byte telemetry (`decode_tlm`), not the 8×u16 fast telemetry
  that `SET_FAST_COM_LENGTH` + `tlm_request_id` produce.
- CLI line lacks `rxtx`/`reset`; `beep` sends unsequenced frames; no `SET_TLM_TYPE` ack
  tolerance.

Keep the file untouched (out of app scope) and record the defects in AGENTS.md.

---

## Phase 1 — protocol core (pure, unit-testable, no hardware)

**`src/core/fettec/protocol.ts`**
- `crc8Fettec(data, seed?)` — poly **0x07** (alias `crc8Dvb` kept for the original plan name).
- `buildConfigFrame(id, msg, payload)`; `MSG` constants: `OK 0`, `NOT_OK 2`,
  `BL_START_FW 3`, `REQ_TYPE 5`, `REQ_SN 6`, `REQ_SW_VER 7`, `REQ_TLM 12`, `BEEP 13`,
  `SET_FAST_COM_LENGTH 26`, `SET_TLM_TYPE 27`.
- `extractFrames(buf) → { frames, leftover }` — scan for source `0x02`/`0x03`,
  accept `6 ≤ len ≤ 6 + MAX_RX_PAYLOAD`, require a valid CRC, return `(src, id, payload)`;
  keeps the tail for split frames; skips echo and garbage.
- `fastThrottleLen(n)`; `packFastThrottle(values, tlmSlot)` using the configurator's
  bit-stream algorithm (not the prototype's accumulator); `unpackFastThrottle` for tests.
- `decodeFastTelemetry(bytes, count, slot, scales)` → `{ tempC, volt, amps, erpm, rpm, mah,
  debug[3] }`; unit factors come from a scale table (Phase "scales"), never literals.
- Device-type name subset from the configurator's `DEVICE_types` for the device table.

**`src/core/fettec/controller.ts`** — pure state machine, per motor:
- 8 absolute % → 11-bit raw (`1000 + pct*10`, banker's rounding parity with
  `throttleForPower`), dead-band handling, 0..100 % forward range only, `setAll(%)`,
  ramp-up, stop ramp 5 %/50 ms, `emergencyStop()`.
- Kept separate from `src/core/esc.ts` so the MSP desktop-parity path is untouched.

**`src/core/msp.ts`** — add `MSP_ANALOG` (110) request + decode
(voltage 0.1 V, current 0.01 A, mAh, RSSI) for the cross-check.

Unit tests (`tests/unit/fettec-protocol.test.ts`, `esc.test.ts`, `msp.test.ts` extensions):
CRC vectors, byte-exact frames, `extractFrames` resync over echo / garbage / truncated,
`fastThrottleLen` for n=1..8, `packFastThrottle` golden vectors for n=2/4/8 incl. TLM-slot
bits and ALL_ID, telemetry decode (signed temp, ERPM ×100, rpm = erpm·2/poles), per-motor
raw mapping.

## Phase 2 — bus session + panel skeleton

**`src/core/fettec/bus.ts`** — `FettecBus`, mirroring `src/sources/serial.ts` conventions
(epoch-guard every read loop and timer; stale callbacks ignored):
1. connect: `open({ baudRate: 115200 })` → `#` → tolerant banner check → CLI line →
   settle ~1.5 s → RX reset.
2. scan `base..base+N-1`: `OW_OK`; `0x02` → `BL_START_FW` with retry, then per-ESC error;
   `0x03` → firmware. Read type / SW version / SN for the device table.
3. init per ESC: `SET_TLM_TYPE 0` (fast slots; ack tolerated as missing),
   `SET_FAST_COM_LENGTH <fullLen>,minId,count`, verify `OK` ack.
4. cyclic loop: self-rescheduling ~100 Hz, **one persistent writer** (the current MSP
   path takes a fresh writer per write, which is how commands get dropped), round-robin
   TLM slot, CRC-validated RX, store patches batched ≤20 Hz.
5. diagnostics: frames/s, CRC errors, per-ESC TLM age, bus bytes/s.
6. disconnect: zeros ×3 → stop loop → `setSignals({ dataTerminalReady: false })` → close.
7. watchdog: write error / port close / `visibilitychange` hidden → zero throttle + stop.
   Background tabs throttle timers, so the ESC failsafe stops the motors; surface that in
   a UI banner.

**`src/components/FettecPanel.tsx`** — lazy-loaded (entry bundle stays under the 150 kB CI cap):
- step badges `CLI → passthrough → scan → init → ready`;
- device table: ID, model, FW, SN, TLM age, per-row Temp/V/A/RPM/mAh, stale flag;
- 8 per-motor % sliders + numeric inputs, `apply to all`, START / big STOP, ramp badge;
- bus stats + diagnostic line.

**`src/components/EscPanel.tsx`** — segmented mode switch `MSP` / `FETtec passthrough` on
the one FC port (they are mutually exclusive: in passthrough the VCP is a raw pipe, MSP is
dead). Switching tears the session down; MSP controls disabled while passthrough is live.
Shared `SafetyDialog` (text extended: OneWire, continuous frames, FC reboots on disconnect).

**Settings** (`src/state/settings.ts`, `src/core/constants.ts`, `src/core/types.ts`) —
new "FETtec ESC" section, persisted + clamped: ESC bus baud (115200/500000/2000000),
ESC count 1..8, ID base, poles, CLI-line override, auto-reboot-on-disconnect,
signal-check power %, per-unit scale overrides, RPM source motor.

## Phase 3 — spin + signal check box

**`src/core/fettec/signalCheck.ts`** (props-off gate, check power default 10 %):
1. TLM presence per ESC (is telemetry answering on the bus).
2. ~500 ms zero-throttle baseline of ERPM + current.
3. Test pulse on one motor at a time, ~300 ms, sampled.
4. Verdict per ESC/motor:
   - **FETTEC OneWire input** — ERPM/current moved with bus throttle;
   - **FC pin signal (PWM/DShot)** — answers on the bus, ignores bus throttle (FC pins are
     held high in passthrough, so the ESC idles);
   - **not on the OneWire bus** — no telemetry at all (TLM wire open / ESC unpowered).
5. MSP cross-check column: MSP V/A captured **before** entering passthrough, compared to
   ESC V/A to pin the scale factors and flag a mismatch.
6. Ramp to zero, restore state.

Summary line: "8 motors on OneWire bus" / "mixed wiring" / "no OneWire devices — ESCs fed
from FC pins". Honest wording: "FC pin signal" is *inferred* (answers, ignores bus
throttle), never a direct PWM measurement, because BF holds the motor pins high during
passthrough.

## Phase 4 — app integration, tests, docs

- **Store** (`src/state/store.ts`): extend `EscStateSignal` with
  `mode: "msp" | "fettec"`, devices, per-motor telemetry, check results, passthrough state,
  bus stats. `motorRpmHz` (today `esc.rpm / 60`, feeding the `rpmPlugin` FFT markers, hero
  and PNG export) switches to the FETtec source in fettec mode, source motor selectable
  (single motor or mean of N).
- **e2e** (`tests/e2e/support/fake-serial.ts`, `tests/e2e/fettec.spec.ts`): a third fake
  port kind "BF passthrough" — answers `#` + CLI line, emulates the OneWire bus (scan acks,
  `SET_*` acks, fast-throttle echo + 16-byte TLM block, RPM model from poles). Spec covers
  connect → 8 devices → signal-check verdict → START → per-motor slider → stop ramp →
  disconnect emits the DTR drop. Mind the AGENTS.md modal / `pressSequentially` gotchas.
- **Docs**: AGENTS.md — FETtec subsystem oracle, the prototype-defect list, and gotchas
  (echo, `reset`/DTR, motor pins held high, 250 ms failsafe, single writer, lazy panel).
  PLAN.md — new §6.16 + a decision superseding D13 for the FETtec path (continuous
  heartbeat required; MSP path keeps `ESC_HEARTBEAT_HZ = 0`). README + About dialog text.
- **Definition of done**: `npm run typecheck` + `npm test` + `npm run build` +
  `npm run test:e2e` green; entry ≤ 150 kB gzipped.

---

## Hardware verification checklist

1. **TLM slot units.** Fast-TLM Voltage / Current / Consumption are shown almost raw by the
   FETtec GUI. Use the MSP ANALOG cross-check + the scale-override fields; first run should
   be compared side by side with gui.fettec.net.
2. **DTR reboot** only works if the FC's VCP honours DTR — keep the toggle plus a
   power-cycle prompt fallback.
3. **ID layout** — confirm the 8 IDs really are 1..8 (FETtec auto-assigns by bus power-up
   order); `base + count` covers the 2-ESC case. ID *writes* are out of v1 scope.
4. **CLI-line spelling** on the user's Betaflight build (the override field exists for this).
5. **Load** — 100 Hz bus loop + 2 kHz sensor parse + 8-row table: verify with the app's
   render-ms/FPS readout; batch store patches, keep the loop off the render path.
6. Confirm motors stop within 250 ms after tab close / port close.

## Risks

- Telemetry units unverified → scale table + cross-check + user overrides.
- 100 Hz loop in a throttled background tab → ESC failsafe stops motors (safety net, shown
  in the UI).
- Half-duplex echo on the bus → CRC-validated frame extraction, never byte-count parsing.
- 2 Mbit ESC bus inside a 115200-labelled VCP: USB CDC line coding is nominal, the real
  budget is ~100 Hz × (13 B TX + 17 B RX) ≈ 3 KB/s — trivial.
- Motor command liveness: continuous frames mean a crash/tab close stops the motors; that is
  the intended behaviour, and STOP must stay reachable at all times in the panel.

## Effort

| Phase | Est. |
| --- | --- |
| 1 protocol core + unit tests | 1 d |
| 2 bus + fake transport + panel skeleton | 1 d |
| 3 spin + ramp + watchdog + signal check | 1 d |
| 4 integration + e2e + docs | 0.5–1 d |
| Hardware session (checklist above) | one sitting, props off |
