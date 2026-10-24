// Settings with defaults, validation, clamping and localStorage persistence
// (plan §6.15).

import {
  DEFAULT_FFT_MAX_FREQ,
  DEFAULT_FFT_REFRESH_HZ,
  DEFAULT_IMU_HZ,
  DEFAULT_LSB_PER_G,
  ESC_DEFAULT_CHANNEL,
  ESC_MAX_CHANNELS,
  FFT_MAX_FREQ_CHOICES,
  IMU_HZ_CHOICES,
  LSB_PER_G_CHOICES,
  RMS_STATISTICS_WINDOW_SECONDS,
  SETTINGS_STORAGE_KEY,
  WINDOW_SECONDS,
  ZOOM_WINDOW_SECONDS,
} from "../core/constants";
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
};

const REFRESH_MIN = 0.5;
const REFRESH_MAX = 60;
// Desktop `set_fft_refresh_rate`: value = max(1.0, hz).
const REFRESH_FLOOR = 1.0;

/**
 * FFT max frequency is the live FFT Nyquist (live_sample_rate = 2×fftMaxHz),
 * independent of imuHz — matching the desktop selector, so every choice in
 * FFT_MAX_FREQ_CHOICES is always available.
 */
export function fftMaxChoicesFor(_imuHz: number): number[] {
  return [...FFT_MAX_FREQ_CHOICES];
}

function numberIn(value: unknown, choices: readonly number[], fallback: number): number {
  return typeof value === "number" && choices.includes(value) ? value : fallback;
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
  };
  // fftMaxHz is independent of imuHz (desktop parity): accept any listed choice.
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
