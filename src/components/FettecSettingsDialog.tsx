// FETtec ESC settings: the drawer's FETtec section, in a centered window.
//
// The window opens from the header gear and from the drawer's FETtec section,
// so the bus setup is reachable from the landing screen too (the drawer is only
// mounted on the dashboard). Every field writes straight to store settings,
// which persist to localStorage; the structural ones are captured at connect,
// so they are disabled while the bus is live and apply on the next connect.

import { DEFAULT_SETTINGS } from "../state/settings";
import {
  FETTEC_BAUD_CHOICES,
  FETTEC_MAX_ESCS,
  FETTEC_MAX_ID_BASE,
  FETTEC_MAX_POLES,
  FETTEC_MIN_ID_BASE,
  FETTEC_MIN_POLES,
  FETTEC_REPLY_TIMEOUT_MAX_MS,
  FETTEC_REPLY_TIMEOUT_MIN_MS,
  FETTEC_RPM_SOURCE_AUTO,
  FETTEC_RPM_SOURCE_MEAN,
} from "../core/constants";
import { DEFAULT_TLM_SCALES } from "../core/fettec/protocol";
import type { Settings } from "../core/types";
import { store } from "../state/store";
import { pushToast } from "../state/toasts";

/**
 * Every `fettec*` default, for "Reset FETtec settings": derived from
 * `DEFAULT_SETTINGS` so a new FETtec setting is covered without editing this.
 */
function fettecDefaults(): Partial<Settings> {
  const defaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (key.startsWith("fettec")) defaults[key] = value;
  }
  return defaults as Partial<Settings>;
}

export function FettecSettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = store.settings.value;
  const esc = store.esc.value;
  const fettecLive = esc.connected && esc.mode === "fettec";

  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="FETtec ESC settings">
      <div class="modal modal-settings" onClick={(event) => event.target === event.currentTarget && onClose()}>
        <div class="modal-title settings-title">
          <span>FETtec ESC settings</span>
          <button class="btn btn-icon" aria-label="Close FETtec ESC settings" onClick={onClose}>
            ×
          </button>
        </div>

        <div class="modal-body">
          <div class="esc-dim fettec-settings-note">
            Changes save immediately. Structural fields (bus baud, ESC count, ID base, poles, reply timeout, CLI line)
            are read once at connect, so they apply on the next connect and are locked while the bus is live.
            {fettecLive ? " The bus is live now — disconnect to edit them." : ""}
          </div>

          <div class="settings-grid">
            <section class="settings-column">
              <div class="section-label">OneWire bus</div>
              <label class="field-row">
                <span>ESC bus baud</span>
                <select
                  class="input"
                  value={settings.fettecEscBaud}
                  disabled={fettecLive}
                  onChange={(event) =>
                    store.patchSettings({ fettecEscBaud: Number((event.target as HTMLSelectElement).value) })
                  }
                >
                  {FETTEC_BAUD_CHOICES.map((baud) => (
                    <option value={baud} key={baud}>
                      {baud}
                    </option>
                  ))}
                </select>
              </label>
              <label class="field-row">
                <span>ESC count</span>
                <input
                  class="input"
                  type="number"
                  min={1}
                  max={FETTEC_MAX_ESCS}
                  value={settings.fettecEscCount}
                  disabled={fettecLive}
                  onInput={(event) =>
                    store.patchSettings({ fettecEscCount: Number((event.target as HTMLInputElement).value) })
                  }
                />
              </label>
              <label class="field-row">
                <span>First OneWire ID</span>
                <input
                  class="input"
                  type="number"
                  min={FETTEC_MIN_ID_BASE}
                  max={FETTEC_MAX_ID_BASE}
                  value={settings.fettecIdBase}
                  disabled={fettecLive}
                  onInput={(event) =>
                    store.patchSettings({ fettecIdBase: Number((event.target as HTMLInputElement).value) })
                  }
                />
              </label>
              <label class="field-row">
                <span>Motor poles</span>
                <input
                  class="input"
                  type="number"
                  min={FETTEC_MIN_POLES}
                  max={FETTEC_MAX_POLES}
                  value={settings.fettecPoles}
                  disabled={fettecLive}
                  onInput={(event) =>
                    store.patchSettings({ fettecPoles: Number((event.target as HTMLInputElement).value) })
                  }
                />
              </label>
              <label class="field-row">
                <span>Reply timeout</span>
                <input
                  class="input"
                  type="number"
                  min={FETTEC_REPLY_TIMEOUT_MIN_MS}
                  max={FETTEC_REPLY_TIMEOUT_MAX_MS}
                  step={5}
                  value={settings.fettecReplyTimeoutMs}
                  disabled={fettecLive}
                  title="Fast-telemetry reply window in ms. The FC's USB CDC data arrives in ~16 ms polls; a reply split across two polls lands at ~32 ms. Raise it (40–60) when stats show timeouts with a partial byte count (e.g. '8 B rx +16 ms' = echo arrived, telemetry did not)."
                  onInput={(event) =>
                    store.patchSettings({ fettecReplyTimeoutMs: Number((event.target as HTMLInputElement).value) })
                  }
                />
              </label>
              <label class="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.fettecAutoReboot}
                  onChange={(event) =>
                    store.patchSettings({ fettecAutoReboot: (event.target as HTMLInputElement).checked })
                  }
                />
                <span>Drop DTR on disconnect (reboot FC)</span>
              </label>
            </section>

            <section class="settings-column">
              <div class="section-label">Motors and RPM marker</div>
              <label class="field-row">
                <span>RPM source motor</span>
                <select
                  class="input"
                  value={settings.fettecRpmMotor}
                  title="Which ESC feeds the RPM readout and the FFT 1×/2× marker lines. Auto follows the motor with the highest throttle; ties break on the highest measured eRPM. Self-diagnosing channels (no motor) are never a source."
                  onChange={(event) =>
                    store.patchSettings({ fettecRpmMotor: Number((event.target as HTMLSelectElement).value) })
                  }
                >
                  <option value={FETTEC_RPM_SOURCE_AUTO}>Auto (highest throttle)</option>
                  <option value={FETTEC_RPM_SOURCE_MEAN}>Mean of all</option>
                  {Array.from({ length: settings.fettecEscCount }, (_, index) => (
                    <option value={index + 1} key={index + 1}>
                      Motor {index + 1}
                    </option>
                  ))}
                </select>
              </label>
              {settings.fettecRpmMotor === FETTEC_RPM_SOURCE_AUTO && esc.mode === "fettec" && esc.connected && (
                <div class="esc-dim" role="status">
                  {store.fettecRpmSourceIndex >= 0
                    ? `Following M${store.fettecRpmSourceIndex + 1} (highest throttle).`
                    : "No driven channel yet — the marker stays flat until a motor has throttle."}
                </div>
              )}
              <label class="field-row">
                <span>Signal check power</span>
                <input
                  class="input"
                  type="number"
                  min={1}
                  max={50}
                  value={settings.fettecCheckPower}
                  title="Throttle used by the signal-check pulses. Keep it low: the pulses spin the motors with props off."
                  onInput={(event) =>
                    store.patchSettings({ fettecCheckPower: Number((event.target as HTMLInputElement).value) })
                  }
                />
              </label>
              <div class="esc-dim fettec-settings-note">
                {esc.mode === "fettec" && esc.connected
                  ? `Bus live: ${esc.devices.length} ESC answered the scan.`
                  : "The scan uses the count, ID base and poles above; a 4in1 answers with one ESC per channel."}
              </div>
            </section>
          </div>

          <label class="field-row settings-field-wide">
            <span>CLI line override</span>
            <input
              class="input fettec-cli-input"
              type="text"
              value={settings.fettecCliLine}
              placeholder="serialpassthrough esc_sensor 2000000 rxtx reset"
              disabled={fettecLive}
              title="Betaflight CLI line that enters OneWire passthrough. Empty = generated from the bus baud. Keep 'rxtx reset'."
              onInput={(event) => store.patchSettings({ fettecCliLine: (event.target as HTMLInputElement).value })}
            />
          </label>

          <details class="fettec-scale-details">
            <summary>Telemetry scale overrides</summary>
            <div class="settings-scale-grid">
              <label class="field-row">
                <span>Temperature ×</span>
                <input
                  class="input"
                  type="number"
                  min={0.0001}
                  step={0.01}
                  value={settings.fettecScaleTemp}
                  onInput={(event) =>
                    store.patchSettings({ fettecScaleTemp: Number((event.target as HTMLInputElement).value) })
                  }
                />
              </label>
              <label class="field-row">
                <span>Voltage ×</span>
                <input
                  class="input"
                  type="number"
                  min={0.0001}
                  step={0.01}
                  value={settings.fettecScaleVoltage}
                  onInput={(event) =>
                    store.patchSettings({ fettecScaleVoltage: Number((event.target as HTMLInputElement).value) })
                  }
                />
              </label>
              <label class="field-row">
                <span>Current ×</span>
                <input
                  class="input"
                  type="number"
                  min={0.0001}
                  step={0.01}
                  value={settings.fettecScaleCurrent}
                  onInput={(event) =>
                    store.patchSettings({ fettecScaleCurrent: Number((event.target as HTMLInputElement).value) })
                  }
                />
              </label>
              <label class="field-row">
                <span>eRPM ×</span>
                <input
                  class="input"
                  type="number"
                  min={0.0001}
                  step={0.01}
                  value={settings.fettecScaleErpm}
                  onInput={(event) =>
                    store.patchSettings({ fettecScaleErpm: Number((event.target as HTMLInputElement).value) })
                  }
                />
              </label>
              <label class="field-row">
                <span>Consumption ×</span>
                <input
                  class="input"
                  type="number"
                  min={0.0001}
                  step={0.01}
                  value={settings.fettecScaleConsumption}
                  onInput={(event) =>
                    store.patchSettings({ fettecScaleConsumption: Number((event.target as HTMLInputElement).value) })
                  }
                />
              </label>
            </div>
            <button
              class="btn btn-small"
              onClick={() =>
                store.patchSettings({
                  fettecScaleTemp: DEFAULT_TLM_SCALES.temp,
                  fettecScaleVoltage: DEFAULT_TLM_SCALES.voltage,
                  fettecScaleCurrent: DEFAULT_TLM_SCALES.current,
                  fettecScaleErpm: DEFAULT_TLM_SCALES.erpm,
                  fettecScaleConsumption: DEFAULT_TLM_SCALES.consumption,
                })
              }
            >
              Reset scales
            </button>
          </details>

          <div class="modal-actions">
            <button
              class="btn btn-small"
              onClick={() => {
                store.patchSettings(fettecDefaults());
                pushToast({ kind: "info", title: "FETtec settings reset" });
              }}
            >
              Reset FETtec settings
            </button>
            <button class="btn btn-accent" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
