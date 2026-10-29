// Settings with defaults, validation, clamping and localStorage persistence
// (plan §6.15).

import {
  DEFAULT_FFT_MAX_FREQ,
  DEFAULT_FFT_REFRESH_HZ,
  DEFAULT_IMU_HZ,
  DEFAULT_LSB_PER_G,
  ESC_DEFAULT_CHANNEL,
  ESC_MAX_CHANNELS,
  FETTEC_BAUD_CHOICES,
  FETTEC_DEFAULT_CHECK_POWER,
  FETTEC_DEFAULT_ESC_BAUD,
  FETTEC_DEFAULT_ESC_COUNT,
  FETTEC_DEFAULT_ID_BASE,
  FETTEC_DEFAULT_POLES,
  FETTEC_MAX_ESCS,
  FETTEC_MAX_ID_BASE,
  FETTEC_MAX_POLES,
  FETTEC_MIN_ID_BASE,
  FETTEC_MIN_POLES,
  FETTEC_REPLY_TIMEOUT_MAX_MS,
  FETTEC_REPLY_TIMEOUT_MIN_MS,
  FETTEC_REPLY_TIMEOUT_MS,
  FETTEC_RPM_SOURCE_AUTO,
  FETTEC_RPM_SOURCE_MEAN,
  FFT_MAX_FREQ_CHOICES,
  IMU_HZ_CHOICES,
  LSB_PER_G_CHOICES,
  RMS_STATISTICS_WINDOW_SECONDS,
  SETTINGS_STORAGE_KEY,
  WINDOW_SECONDS,
  ZOOM_WINDOW_SECONDS,
} from "../core/constants";
import { DEFAULT_TLM_SCALES } from "../core/fettec/protocol";
import type { Settings } from "../core/types";

export const DEFAULT_SETTINGS: Settings = {
  imuHz: DEFAULT_IMU_HZ,
  fftMaxHz: DEFAULT_FFT_MAX_FREQ,
  fftRefreshHz: DEFAULT_FFT_REFRESH_HZ,
  lsbPerG: DEFAULT_LSB_PER_G,
  windowSeconds: WINDOW_SECONDS,
  autoReconnect: true,
  saveMode: "download",
  escMotorChannel: ESC_DEFAULT_CHANNEL,
  autoplayDemo: true,
  fettecEscCount: FETTEC_DEFAULT_ESC_COUNT,
  fettecIdBase: FETTEC_DEFAULT_ID_BASE,
  fettecPoles: FETTEC_DEFAULT_POLES,
  fettecEscBaud: FETTEC_DEFAULT_ESC_BAUD,
  fettecReplyTimeoutMs: FETTEC_REPLY_TIMEOUT_MS,
  fettecCliLine: "",
  fettecAutoReboot: true,
  fettecCheckPower: FETTEC_DEFAULT_CHECK_POWER,
  fettecRpmMotor: FETTEC_RPM_SOURCE_AUTO,
  fettecScaleTemp: DEFAULT_TLM_SCALES.temp,
  fettecScaleVoltage: DEFAULT_TLM_SCALES.voltage,
  fettecScaleCurrent: DEFAULT_TLM_SCALES.current,
  fettecScaleErpm: DEFAULT_TLM_SCALES.erpm,
  fettecScaleConsumption: DEFAULT_TLM_SCALES.consumption,
};

const REFRESH_MIN = 0.5;
const REFRESH_MAX = 60;
// Desktop `set_fft_refresh_rate`: value = max(1.0, hz).
const REFRESH_FLOOR = 1.0;

/**
 * FFT max frequency is the FFT chart's display band (a zoom), independent of
 * imuHz — every choice in FFT_MAX_FREQ_CHOICES stays available. The spectrum
 * itself always runs at the real acquisition rate (imuHz), so changing this
 * setting must never move a peak.
 */
export function fftMaxChoicesFor(_imuHz: number): number[] {
  return [...FFT_MAX_FREQ_CHOICES];
}

function numberIn(value: unknown, choices: readonly number[], fallback: number): number {
  return typeof value === "number" && choices.includes(value) ? value : fallback;
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function scaleIn(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value <= 0 || value > 1e6) return fallback;
  return value;
}

function cliLineIn(value: unknown): string {
  if (typeof value !== "string") return "";
  // One CLI line only: strip CR/LF/control chars and cap the length.
  return value
    .replace(/[\r\n\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 200);
}

/** Sanitize arbitrary stored data into a valid Settings object. */
export function validateSettings(raw: unknown): Settings {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const settings: Settings = {
    imuHz: numberIn(source.imuHz, IMU_HZ_CHOICES, DEFAULT_SETTINGS.imuHz),
    fftMaxHz: DEFAULT_SETTINGS.fftMaxHz,
    fftRefreshHz:
      typeof source.fftRefreshHz === "number" &&
      Number.isFinite(source.fftRefreshHz) &&
      source.fftRefreshHz >= REFRESH_MIN &&
      source.fftRefreshHz <= REFRESH_MAX
        ? Math.max(REFRESH_FLOOR, source.fftRefreshHz)
        : DEFAULT_SETTINGS.fftRefreshHz,
    lsbPerG: numberIn(source.lsbPerG, LSB_PER_G_CHOICES, DEFAULT_SETTINGS.lsbPerG),
    windowSeconds: numberIn(source.windowSeconds, [WINDOW_SECONDS, ZOOM_WINDOW_SECONDS], WINDOW_SECONDS),
    autoReconnect: typeof source.autoReconnect === "boolean" ? source.autoReconnect : true,
    saveMode: source.saveMode === "folder" ? "folder" : "download",
    escMotorChannel:
      typeof source.escMotorChannel === "number" &&
      source.escMotorChannel >= 1 &&
      source.escMotorChannel <= ESC_MAX_CHANNELS
        ? Math.trunc(source.escMotorChannel)
        : ESC_DEFAULT_CHANNEL,
    autoplayDemo: typeof source.autoplayDemo === "boolean" ? source.autoplayDemo : true,
    fettecEscCount: intIn(source.fettecEscCount, 1, FETTEC_MAX_ESCS, FETTEC_DEFAULT_ESC_COUNT),
    fettecIdBase: intIn(source.fettecIdBase, FETTEC_MIN_ID_BASE, FETTEC_MAX_ID_BASE, FETTEC_DEFAULT_ID_BASE),
    fettecPoles: intIn(source.fettecPoles, FETTEC_MIN_POLES, FETTEC_MAX_POLES, FETTEC_DEFAULT_POLES),
    fettecEscBaud: numberIn(source.fettecEscBaud, FETTEC_BAUD_CHOICES, FETTEC_DEFAULT_ESC_BAUD),
    fettecReplyTimeoutMs: intIn(
      source.fettecReplyTimeoutMs,
      FETTEC_REPLY_TIMEOUT_MIN_MS,
      FETTEC_REPLY_TIMEOUT_MAX_MS,
      FETTEC_REPLY_TIMEOUT_MS,
    ),
    fettecCliLine: cliLineIn(source.fettecCliLine),
    fettecAutoReboot: typeof source.fettecAutoReboot === "boolean" ? source.fettecAutoReboot : true,
    fettecCheckPower: intIn(source.fettecCheckPower, 1, 50, FETTEC_DEFAULT_CHECK_POWER),
    // -1 = Mean of all, 0 = Auto (highest throttle), 1..8 = one motor. The old
    // value space had 0 = Mean, so a saved 0 silently becomes Auto: the intended
    // improvement, and Mean is one click away for anyone who wants it back.
    fettecRpmMotor: intIn(source.fettecRpmMotor, FETTEC_RPM_SOURCE_MEAN, FETTEC_MAX_ESCS, FETTEC_RPM_SOURCE_AUTO),
    fettecScaleTemp: scaleIn(source.fettecScaleTemp, DEFAULT_TLM_SCALES.temp),
    fettecScaleVoltage: scaleIn(source.fettecScaleVoltage, DEFAULT_TLM_SCALES.voltage),
    fettecScaleCurrent: scaleIn(source.fettecScaleCurrent, DEFAULT_TLM_SCALES.current),
    fettecScaleErpm: scaleIn(source.fettecScaleErpm, DEFAULT_TLM_SCALES.erpm),
    fettecScaleConsumption: scaleIn(source.fettecScaleConsumption, DEFAULT_TLM_SCALES.consumption),
  };
  // fftMaxHz is independent of imuHz: accept any listed choice; the chart
  // clamps the visible band to the real Nyquist (imuHz / 2).
  settings.fftMaxHz = numberIn(source.fftMaxHz, FFT_MAX_FREQ_CHOICES, DEFAULT_FFT_MAX_FREQ);
  return settings;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return validateSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage disabled (private mode); settings stay in memory.
  }
}

export function resetSettings(): Settings {
  try {
    localStorage.removeItem(SETTINGS_STORAGE_KEY);
  } catch {
    // ignore
  }
  return { ...DEFAULT_SETTINGS };
}

export { RMS_STATISTICS_WINDOW_SECONDS };
