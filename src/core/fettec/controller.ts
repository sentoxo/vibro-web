// FETtec per-motor throttle state machine. Kept separate from `core/esc.ts`
// so the MSP/desktop-parity path is untouched.
//
// Raw mapping: percent 0..100 → 11-bit 1000..2000 (1000 = stop). The ramp
// moves 5 % every 50 ms, matching the desktop ESC ramp.

import { ESC_RAMP_INTERVAL_MS, ESC_RAMP_STEP } from "../constants";
import { clamp, roundHalfToEven } from "../units";

export const FETTEC_RAW_MIN = 0;
export const FETTEC_RAW_MAX = 2000;
export const FETTEC_RAW_STOP = 1000;
export const FETTEC_DEADBAND_LOW = 991;
export const FETTEC_DEADBAND_HIGH = 1009;
export const FETTEC_MAX_ESCS = 8;

/** Absolute percent → 11-bit raw, banker's rounding like Python `int(round())`. */
export function fettecRawForPercent(percent: number): number {
  const value = clamp(percent, 0, 100);
  return clamp(roundHalfToEven(FETTEC_RAW_STOP + value * 10), FETTEC_RAW_MIN, FETTEC_RAW_MAX);
}

export function fettecPercentForRaw(raw: number): number {
  return (clamp(raw, FETTEC_RAW_MIN, FETTEC_RAW_MAX) - FETTEC_RAW_STOP) / 10;
}

export function isFettecDeadband(raw: number): boolean {
  return raw >= FETTEC_DEADBAND_LOW && raw <= FETTEC_DEADBAND_HIGH;
}

export type FettecPhase = "idle" | "ramping" | "running";

/**
 * Per-motor controller. `tick(now)` advances ramps; the bus loop calls it at
 * ~100 Hz and sends `rawValues()` in every fast-throttle frame.
 *
 * START is a **latch** (`armed`): it stays active until STOP, an emergency stop
 * or a link drop. While armed, moving a slider — including back to 0 % and up
 * again — drives the motors straight away, so the user never has to press START
 * per motor test. Disarmed, the sliders only record the commanded targets;
 * nothing turns until START.
 */
export class FettecController {
  readonly count: number;
  phase: FettecPhase = "idle";
  private readonly targets: number[];
  private readonly currents: number[];
  private latched = false;
  private stopping = false;
  private lastTick = 0;

  constructor(count: number) {
    if (!Number.isInteger(count) || count < 1 || count > FETTEC_MAX_ESCS) {
      throw new RangeError(`FETtec ESC count must be 1..${FETTEC_MAX_ESCS}`);
    }
    this.count = count;
    this.targets = new Array<number>(count).fill(0);
    this.currents = new Array<number>(count).fill(0);
  }

  /** Commanded percentage for one motor (0-based index). */
  setMotor(index: number, percent: number): void {
    if (index < 0 || index >= this.count) return;
    if (this.stopping) return; // a stop ramp always wins
    this.targets[index] = clamp(percent, 0, 100);
    if (!this.latched) return; // disarmed: the slider records the target, nothing turns
    if (this.currents[index] !== this.targets[index]) {
      this.phase = "ramping";
      this.lastTick = 0;
    }
  }

  setAll(percent: number): void {
    for (let i = 0; i < this.count; i++) this.setMotor(i, percent);
  }

  /**
   * START: latch the session armed. It stays armed while the sliders sit at
   * 0 %, so ramping one back up needs no second START.
   */
  start(): boolean {
    if (this.count === 0) return false;
    this.stopping = false;
    this.latched = true;
    this.lastTick = 0;
    this.phase = this.atTargets() ? "running" : "ramping";
    return true;
  }

  /** STOP: release the latch, targets to zero, 5 % per 50 ms. */
  stop(): boolean {
    if (this.count === 0) return false;
    this.targets.fill(0);
    this.stopping = true;
    this.latched = false;
    this.lastTick = 0;
    this.phase = this.allZero() ? "idle" : "ramping";
    return true;
  }

  /** Hard stop: values are zeroed immediately (the bus sends zeros ×3). */
  emergencyStop(): void {
    this.targets.fill(0);
    this.currents.fill(0);
    this.phase = "idle";
    this.stopping = false;
    this.latched = false;
    this.lastTick = 0;
  }

  /** Advance the ramp. Returns true when any current value changed. */
  tick(nowMs: number): boolean {
    if (this.phase !== "ramping") {
      this.lastTick = nowMs;
      return false;
    }
    if (this.lastTick === 0) this.lastTick = nowMs;
    const steps = Math.floor((nowMs - this.lastTick) / ESC_RAMP_INTERVAL_MS);
    if (steps <= 0) return false;
    this.lastTick += steps * ESC_RAMP_INTERVAL_MS;

    let changed = false;
    for (let step = 0; step < steps; step++) {
      for (let i = 0; i < this.count; i++) {
        const difference = this.targets[i] - this.currents[i];
        if (difference === 0) continue;
        if (Math.abs(difference) <= ESC_RAMP_STEP) this.currents[i] = this.targets[i];
        else this.currents[i] += Math.sign(difference) * ESC_RAMP_STEP;
        changed = true;
      }
    }
    if (this.atTargets()) {
      this.stopping = false;
      // Releasing the latch (STOP) is what makes a ramp-down end in "idle";
      // an armed session keeps driving, even when every target is 0 %.
      this.phase = this.latched ? "running" : "idle";
    }
    return changed;
  }

  /** Raw 11-bit values to put in the next fast-throttle frame. */
  rawValues(): number[] {
    return this.currents.map((percent) => fettecRawForPercent(percent));
  }

  /** Raw targets (what the sliders command), useful for diagnostics/tests. */
  targetRawValues(): number[] {
    return this.targets.map((percent) => fettecRawForPercent(percent));
  }

  targetValues(): number[] {
    return [...this.targets];
  }

  currentValues(): number[] {
    return [...this.currents];
  }

  /** Highest commanded absolute percentage (export filename / UI). */
  get power(): number {
    return Math.max(0, ...this.targets.map((value) => Math.abs(value)));
  }

  /** Highest current absolute percentage. */
  get currentPower(): number {
    return Math.max(0, ...this.currents.map((value) => Math.abs(value)));
  }

  get running(): boolean {
    return this.latched && this.phase !== "idle";
  }

  get ramping(): boolean {
    return this.phase === "ramping";
  }

  get idle(): boolean {
    return this.phase === "idle";
  }

  /** START latch: true from START until STOP / emergency stop / disconnect. */
  get armed(): boolean {
    return this.latched;
  }

  private atTargets(): boolean {
    for (let i = 0; i < this.count; i++) if (this.currents[i] !== this.targets[i]) return false;
    return true;
  }

  private allZero(): boolean {
    for (let i = 0; i < this.count; i++) if (this.targets[i] !== 0 || this.currents[i] !== 0) return false;
    return true;
  }
}
