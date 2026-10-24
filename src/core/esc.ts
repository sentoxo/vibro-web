// ESC throttle math and stop-ramp state machine (plan §6.13).
// Desktop behavior: commands are sent only on start / power change / stop.
// The stop ramp steps down by ESC_RAMP_STEP % every ESC_RAMP_INTERVAL_MS.

import { ESC_MAX_THROTTLE, ESC_MIN_THROTTLE, ESC_RAMP_STEP } from "./constants";
import { clamp, roundHalfToEven } from "./units";

export function clampPower(power: number): number {
  return clamp(power, 0, 100);
}

/** `1000 + power × 10`, banker's rounding like Python `int(round(...))`, clamped 1000..2000. */
export function throttleForPower(power: number): number {
  const throttle = ESC_MIN_THROTTLE + roundHalfToEven(clampPower(power) * 10);
  return clamp(throttle, ESC_MIN_THROTTLE, ESC_MAX_THROTTLE);
}

/** All four channels equal, matching desktop `send_motor_values` usage. */
export function motorCommandForPower(power: number): [number, number, number, number] {
  const throttle = throttleForPower(power);
  return [throttle, throttle, throttle, throttle];
}

export const ZERO_THROTTLE: [number, number, number, number] = [1000, 1000, 1000, 1000];

export type EscPhase = "idle" | "running" | "ramping";

/**
 * Pure ESC state machine. `send` returns false when the transport is down,
 * mirroring how the desktop aborts the ramp when the FC write fails.
 */
export class EscController {
  phase: EscPhase = "idle";
  power = 0;
  private rampPower = 0;
  private readonly send: (throttles: [number, number, number, number]) => boolean;

  constructor(send: (throttles: [number, number, number, number]) => boolean) {
    this.send = send;
  }

  start(): boolean {
    this.phase = "idle"; // cancel any pending ramp (desktop `_stop_ramp_active = False`)
    const ok = this.send(motorCommandForPower(this.power));
    this.phase = ok ? "running" : "idle";
    return ok;
  }

  setPower(power: number): void {
    this.power = clampPower(power);
    if (this.phase === "running") this.start();
  }

  /** Advance the stop ramp one step; call every ESC_RAMP_INTERVAL_MS. */
  stepRamp(): void {
    if (this.phase !== "ramping") return;
    if (this.rampPower <= 0) {
      this.send(ZERO_THROTTLE);
      this.power = 0;
      this.phase = "idle";
      return;
    }
    const ok = this.send(motorCommandForPower(this.rampPower));
    if (!ok) {
      this.phase = "idle";
      this.power = 0;
      return;
    }
    this.power = this.rampPower;
    this.rampPower -= ESC_RAMP_STEP;
  }

  /**
   * Begin the ramp. Desktop `stop_esc` ramps down from the current power
   * whenever the FC is connected, even if the motors were never started;
   * a failed first send parks the controller in `idle`.
   */
  stop(): boolean {
    this.rampPower = clampPower(this.power);
    this.phase = "ramping";
    return true;
  }

  /** Hard reset: motors to zero throttle, state cleared (FC disconnect). */
  emergencyStop(): void {
    this.phase = "idle";
    this.power = 0;
    this.send(ZERO_THROTTLE);
  }

  get running(): boolean {
    return this.phase === "running";
  }

  get ramping(): boolean {
    return this.phase === "ramping";
  }
}
