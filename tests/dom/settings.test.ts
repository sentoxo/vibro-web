// Settings persistence and validation (jsdom project: needs localStorage).

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  resetSettings,
  saveSettings,
  validateSettings,
} from "../../src/state/settings";
import {
  ESC_DEFAULT_CHANNEL,
  FFT_MAX_FREQ_CHOICES,
  IMU_HZ_CHOICES,
  LSB_PER_G_CHOICES,
  SETTINGS_STORAGE_KEY,
} from "../../src/core/constants";

describe("validateSettings", () => {
  it("falls back to defaults for non-objects and junk", () => {
    for (const junk of [null, undefined, 42, "str", []]) {
      expect(validateSettings(junk)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("keeps valid values untouched", () => {
    const custom = { ...DEFAULT_SETTINGS, imuHz: 3200, fftMaxHz: 1600, autoplayDemo: false };
    expect(validateSettings(custom)).toEqual(custom);
  });

  it("snaps enum values to legal choices", () => {
    const s = validateSettings({ imuHz: 1234, lsbPerG: 100, fftMaxHz: 99999, windowSeconds: 5 });
    expect(IMU_HZ_CHOICES).toContain(s.imuHz);
    expect(LSB_PER_G_CHOICES).toContain(s.lsbPerG);
    expect(FFT_MAX_FREQ_CHOICES).toContain(s.fftMaxHz);
    expect(s.windowSeconds).toBe(DEFAULT_SETTINGS.windowSeconds);
  });

  it("fftMaxHz is independent of imuHz (desktop parity: full choice list)", () => {
    const s = validateSettings({ imuHz: 800, fftMaxHz: 1600 });
    expect(s.fftMaxHz).toBe(1600);
  });

  it("applies the desktop refresh floor (max(1.0, hz)) and range gate", () => {
    expect(validateSettings({ fftRefreshHz: 0.7 }).fftRefreshHz).toBe(1.0);
    expect(validateSettings({ fftRefreshHz: 2.5 }).fftRefreshHz).toBe(2.5);
    expect(validateSettings({ fftRefreshHz: 0.4 }).fftRefreshHz).toBe(DEFAULT_SETTINGS.fftRefreshHz);
    expect(validateSettings({ fftRefreshHz: 61 }).fftRefreshHz).toBe(DEFAULT_SETTINGS.fftRefreshHz);
    expect(validateSettings({ fftRefreshHz: Number.NaN }).fftRefreshHz).toBe(DEFAULT_SETTINGS.fftRefreshHz);
  });

  it("truncates and range-checks the ESC channel", () => {
    expect(validateSettings({ escMotorChannel: 3.7 }).escMotorChannel).toBe(3);
    expect(validateSettings({ escMotorChannel: 0 }).escMotorChannel).toBe(ESC_DEFAULT_CHANNEL);
    expect(validateSettings({ escMotorChannel: 17 }).escMotorChannel).toBe(ESC_DEFAULT_CHANNEL);
  });

  it("coerces booleans strictly and saveMode to the union", () => {
    expect(validateSettings({ autoReconnect: 1 }).autoReconnect).toBe(true);
    expect(validateSettings({ autoplayDemo: "yes" }).autoplayDemo).toBe(true);
    expect(validateSettings({ saveMode: "x" }).saveMode).toBe("download");
    expect(validateSettings({ saveMode: "folder" }).saveMode).toBe("folder");
  });
});

describe("persistence (localStorage)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips a saved object", () => {
    const custom = { ...DEFAULT_SETTINGS, imuHz: 3200, fftMaxHz: 1600, escMotorChannel: 5 };
    saveSettings(custom);
    expect(loadSettings()).toEqual(custom);
  });

  it("merges partial stored payloads over defaults", () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ imuHz: 1600 }));
    const s = loadSettings();
    expect(s.imuHz).toBe(1600);
    expect(s.fftMaxHz).toBe(DEFAULT_SETTINGS.fftMaxHz);
  });

  it("drops unknown keys", () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ imuHz: 800, futureThing: 1 }));
    const s = loadSettings() as unknown as Record<string, unknown>;
    expect(s.imuHz).toBe(800);
    expect("futureThing" in s).toBe(false);
  });

  it("falls back to defaults on corrupt payloads", () => {
    for (const junk of ["not json", "null", "[]", "42", '"str"']) {
      localStorage.setItem(SETTINGS_STORAGE_KEY, junk);
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("resetSettings clears storage and returns defaults", () => {
    saveSettings({ ...DEFAULT_SETTINGS, imuHz: 4000 });
    expect(loadSettings().imuHz).toBe(4000);
    expect(resetSettings()).toEqual(DEFAULT_SETTINGS);
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("saveSettings never throws when storage writes fail", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException("QuotaExceeded");
    };
    try {
      expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
