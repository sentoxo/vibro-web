// Which ESC feeds the motor-RPM readout and the FFT 1×/2× marker lines.
//
// The Auto rule matches how the panel is used: the user dials up one motor (or
// a group with "apply to all"), so the marker must follow the channel with the
// **highest commanded throttle** — the motor that is actually being driven.
// Ties break on the highest measured eRPM, which keeps the marker on a channel
// that really spins: on a 4in1 with one prop fitted the mean divided the marker
// frequency by the channel count (4450 rpm → 18.5 Hz lines instead of 74 Hz).
//
// A FETtec self-diagnosing channel (no motor / FET failure) reports problem
// *codes* in its telemetry slots, so its eRPM is not a measurement and is
// skipped as a source.

import { FETTEC_RPM_SOURCE_AUTO, FETTEC_RPM_SOURCE_MEAN } from "../constants";

export interface FettecRpmSourceInput {
  /** `settings.fettecRpmMotor`: AUTO, MEAN, or 1..count for one pinned motor. */
  source: number;
  /** Commanded percent per ESC (`esc.targets`) — what the user dialed up. */
  targets: number[];
  /** Measured RPM per ESC, `null` when the channel has no measurement. */
  rpms: (number | null)[];
  /** `false` = self-diagnosing channel: its slots carry codes, not values. */
  healthy: boolean[];
}

/**
 * Motor index (0-based) that feeds the marker, or -1 for "mean of every
 * healthy channel".
 */
export function pickFettecRpmMotor({ source, targets, rpms, healthy }: FettecRpmSourceInput): number {
  if (source === FETTEC_RPM_SOURCE_MEAN) return -1;
  if (source > 0) {
    const pinned = source - 1;
    return pinned < rpms.length ? pinned : -1;
  }

  const usable = (index: number) => index < healthy.length && healthy[index];
  let bestTarget = 0;
  for (let index = 0; index < rpms.length; index++) {
    if (!usable(index)) continue;
    bestTarget = Math.max(bestTarget, targets[index] ?? 0);
  }

  // Nothing commanded (STOP ramped out, sliders at 0): stay on the channel that
  // is physically spinning so the marker does not jump during a ramp-down.
  if (bestTarget <= 0) {
    let spinning = -1;
    let spinningRpm = 0;
    for (let index = 0; index < rpms.length; index++) {
      const rpm = usable(index) ? (rpms[index] ?? 0) : 0;
      if (rpm > spinningRpm) {
        spinningRpm = rpm;
        spinning = index;
      }
    }
    return spinning;
  }

  let pick = -1;
  let pickRpm = -1;
  for (let index = 0; index < rpms.length; index++) {
    if (!usable(index) || (targets[index] ?? 0) !== bestTarget) continue;
    const rpm = rpms[index] ?? 0;
    if (rpm > pickRpm) {
      pickRpm = rpm;
      pick = index;
    }
  }
  return pick;
}

/** Marker frequency in Hz (0 when there is no usable measurement). */
export function fettecMarkerRpmHz(input: FettecRpmSourceInput): number {
  const index = pickFettecRpmMotor(input);
  if (index >= 0) {
    const usable = index < input.healthy.length ? input.healthy[index] : false;
    return (usable ? (input.rpms[index] ?? 0) : 0) / 60;
  }
  const measured = input.rpms.filter((rpm, index) => rpm !== null && input.healthy[index]) as number[];
  if (measured.length === 0) return 0;
  return measured.reduce((sum, rpm) => sum + rpm, 0) / measured.length / 60;
}

/** True when the source is the Auto (highest-throttle) rule. */
export function isFettecRpmSourceAuto(source: number): boolean {
  return source === FETTEC_RPM_SOURCE_AUTO;
}
