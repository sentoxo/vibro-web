// Signal-check box: decides whether each motor is driven by the FETtec
// OneWire bus or by the FC's PWM/DShot pins.
//
// The FC holds its motor pins high during `serialpassthrough`, so an ESC that
// is fed from the FC pins still answers on the OneWire bus (power/telemetry)
// but ignores bus throttle. We therefore *infer* "FC pin signal" from a
// telemetry answer that does not react to a bus throttle pulse — it is never a
// direct PWM measurement. ESCs with no telemetry at all are not on the bus.

import {
  FETTEC_CHECK_AMPS_THRESHOLD,
  FETTEC_CHECK_BASELINE_MS,
  FETTEC_CHECK_ERPM_THRESHOLD,
  FETTEC_CHECK_PULSE_MS,
  FETTEC_CHECK_SETTLE_MS,
  FETTEC_TLM_STALE_MS,
} from "../constants";
import type { FettecCheckResult, FettecCheckSummary, FettecVerdict } from "./types";

export interface SignalSample {
  erpm: number | null;
  amps: number | null;
  lastTelemetryMs: number | null;
  /** ESC self-diagnosis message (configurator 7357 frame), if any. */
  problem?: string | null;
}

export interface SignalCheckThresholds {
  erpm: number;
  amps: number;
  staleMs: number;
}

export const DEFAULT_CHECK_THRESHOLDS: SignalCheckThresholds = {
  erpm: FETTEC_CHECK_ERPM_THRESHOLD,
  amps: FETTEC_CHECK_AMPS_THRESHOLD,
  staleMs: FETTEC_TLM_STALE_MS,
};

function average(values: (number | null)[]): number | null {
  const numbers = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (numbers.length === 0) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

/** Classify one motor from its zero-throttle baseline and its test pulse. */
export function classifySignalCheck(
  baseline: SignalSample,
  pulse: SignalSample,
  nowMs: number,
  thresholds: SignalCheckThresholds = DEFAULT_CHECK_THRESHOLDS,
): { verdict: FettecVerdict; note: string } {
  const last = pulse.lastTelemetryMs ?? baseline.lastTelemetryMs;
  if (last === null || nowMs - last > thresholds.staleMs) {
    return {
      verdict: "no-onewire",
      note: "No telemetry on the OneWire bus (check the signal wire / ESC power).",
    };
  }

  // A self-diagnosing ESC reports problem *codes* in the current slot (e.g.
  // 2000 = no motor → "20 A"), not a real current draw. The bus-throttle test
  // is meaningless for it, so report the fault verbatim instead of guessing.
  const problem = pulse.problem ?? baseline.problem ?? null;
  if (problem !== null) {
    return {
      verdict: "unknown",
      note: `ESC self-diagnosis: ${problem.toLowerCase()}.`,
    };
  }

  const erpmDelta =
    pulse.erpm !== null && baseline.erpm !== null ? pulse.erpm - baseline.erpm : pulse.erpm !== null ? pulse.erpm : 0;
  const ampsDelta =
    pulse.amps !== null && baseline.amps !== null ? pulse.amps - baseline.amps : pulse.amps !== null ? pulse.amps : 0;

  if (erpmDelta >= thresholds.erpm || ampsDelta >= thresholds.amps) {
    return {
      verdict: "onewire",
      note: "ERPM/current followed the bus throttle pulse.",
    };
  }
  return {
    verdict: "fc-pin",
    note: "Answers on the bus but ignores bus throttle — inferred FC pin (PWM/DShot) signal.",
  };
}

export function summarizeSignalCheck(results: FettecCheckResult[]): FettecCheckSummary {
  const onewire = results.filter((result) => result.verdict === "onewire").length;
  const fcPin = results.filter((result) => result.verdict === "fc-pin").length;
  const missing = results.filter((result) => result.verdict === "no-onewire").length;
  const selfDiagnosis = results.filter(
    (result) => result.verdict === "unknown" && result.note.startsWith("ESC self-diagnosis"),
  ).length;
  const unknown = results.filter((result) => result.verdict === "unknown").length - selfDiagnosis;

  let summary: string;
  if (results.length === 0) {
    summary = "No motors checked.";
  } else if (onewire === results.length) {
    summary = `${onewire} motor${onewire === 1 ? "" : "s"} on the OneWire bus.`;
  } else if (onewire === 0 && fcPin > 0 && missing === 0) {
    summary = "No OneWire devices — ESCs are fed from the FC pins (inferred).";
  } else if (onewire === 0 && missing === results.length) {
    summary = "No OneWire devices answered — check the signal wire and ESC power.";
  } else {
    const parts = [`${onewire} on OneWire`, `${fcPin} on FC pins (inferred)`];
    if (missing > 0) parts.push(`${missing} not on the bus`);
    if (selfDiagnosis > 0) parts.push(`${selfDiagnosis} ESC self-diagnosis`);
    if (unknown > 0) parts.push(`${unknown} unknown`);
    summary = `Mixed wiring: ${parts.join(", ")}.`;
  }

  return {
    results,
    summary,
    ranAt: Date.now(),
    allOneWire: results.length > 0 && onewire === results.length,
  };
}

export interface SignalCheckIo {
  count: number;
  /** Test pulse power in percent (positive). */
  power: number;
  /** Latest telemetry for one motor (0-based). */
  read(index: number): SignalSample;
  setMotor(index: number, percent: number): void;
  setAll(percent: number): void;
  start(): void;
  stop(): void;
  wait(ms: number): Promise<void>;
  now(): number;
  /** Checked between steps; returns true when the user disconnected. */
  aborted(): boolean;
}

async function sampleAverage(io: SignalCheckIo, index: number, samples = 3, intervalMs = 40): Promise<SignalSample> {
  const erpm: (number | null)[] = [];
  const amps: (number | null)[] = [];
  let last: number | null = null;
  let problem: string | null = null;
  for (let i = 0; i < samples; i++) {
    if (i > 0) await io.wait(intervalMs);
    const sample = io.read(index);
    erpm.push(sample.erpm);
    amps.push(sample.amps);
    if (sample.lastTelemetryMs !== null) last = sample.lastTelemetryMs;
    if (sample.problem) problem = sample.problem;
  }
  return { erpm: average(erpm), amps: average(amps), lastTelemetryMs: last, problem };
}

/**
 * Run the props-off signal check. The caller owns the safety gate (the UI only
 * calls this after the props-off dialog) and must keep the bus loop running:
 * the pulse is applied through the normal throttle controller.
 */
export async function runSignalCheck(
  io: SignalCheckIo,
  thresholds: SignalCheckThresholds = DEFAULT_CHECK_THRESHOLDS,
): Promise<FettecCheckSummary> {
  const results: FettecCheckResult[] = [];

  // 1. Zero-throttle baseline (all motors stopped).
  io.setAll(0);
  io.stop();
  await io.wait(FETTEC_CHECK_BASELINE_MS);
  const baselines: SignalSample[] = [];
  for (let index = 0; index < io.count; index++) baselines.push(await sampleAverage(io, index));

  // 2. One motor at a time, sampled during the pulse.
  const rampMs = Math.ceil(Math.max(0, io.power) / 5) * 50;
  const settleMs = Math.max(FETTEC_CHECK_SETTLE_MS, rampMs + 100);
  for (let index = 0; index < io.count; index++) {
    if (io.aborted()) break;
    // start() must clear the previous stop ramp before setMotor() can take a
    // new target (a stop ramp always wins while it is in progress).
    io.start();
    io.setMotor(index, io.power);
    await io.wait(FETTEC_CHECK_PULSE_MS);
    const pulse = await sampleAverage(io, index);
    io.setMotor(index, 0);
    io.stop();
    await io.wait(settleMs);

    const { verdict, note } = classifySignalCheck(baselines[index], pulse, io.now(), thresholds);
    results.push({
      escIndex: index,
      verdict,
      baselineErpm: baselines[index].erpm,
      pulseErpm: pulse.erpm,
      baselineAmps: baselines[index].amps,
      pulseAmps: pulse.amps,
      note,
    });
  }

  // 3. Always leave the motors at zero.
  io.setAll(0);
  io.stop();
  await io.wait(Math.max(0, io.power) > 0 ? settleMs : 0);

  return summarizeSignalCheck(results);
}
