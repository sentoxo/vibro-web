// Settings sidebar / drawer: source, analysis, export, ESC, advanced
// (plan §5.6). All values persist via store settings.

import {
  FETTEC_BAUD_CHOICES,
  FETTEC_MAX_ESCS,
  FETTEC_MAX_ID_BASE,
  FETTEC_MAX_POLES,
  FETTEC_MIN_ID_BASE,
  FETTEC_MIN_POLES,
  FFT_MAX_FREQ_CHOICES,
  IMU_HZ_CHOICES,
  LSB_PER_G_CHOICES,
  WINDOW_SECONDS,
  ZOOM_WINDOW_SECONDS,
} from "../core/constants";
import { DEFAULT_TLM_SCALES } from "../core/fettec/protocol";
import { store } from "../state/store";
import { pushToast } from "../state/toasts";
import { BurstSelect } from "./BurstSelect";
import { EscPanel } from "./EscPanel";
import { ExportPanel } from "./ExportPanel";
import { FileDropZone } from "./FileDropZone";

export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = store.settings.value;
  const kind = store.sourceKind.value;
  const staticMode = store.staticMode.value;
  const esc = store.esc.value;
  const fettecLive = esc.connected && esc.mode === "fettec";

  return (
    <aside class={`settings-drawer ${open ? "settings-drawer-open" : ""}`} aria-label="Settings">
      <div class="drawer-head">
        <span>Controls</span>
        <button class="btn btn-icon" aria-label="Close settings" onClick={onClose}>
          ×
        </button>
      </div>

      <section class="drawer-section">
        <div class="section-label">Source</div>
        <div class="source-mode-row" role="group" aria-label="Source mode">
          <button
            class={`btn btn-small ${kind === "serial" && !staticMode ? "btn-accent" : ""}`}
            onClick={() => window.dispatchEvent(new CustomEvent("vibro:connect"))}
          >
            Live
          </button>
          <button
            class={`btn btn-small ${kind === "demo" && !staticMode ? "btn-accent" : ""}`}
            onClick={() => void store.startDemo()}
          >
            Demo
          </button>
          <button
            class={`btn btn-small ${kind === "file" || (kind === "demo" && staticMode) ? "btn-accent" : ""}`}
            onClick={() => void store.showDemoBursts()}
          >
            Bursts
          </button>
        </div>
        {staticMode ? (
          <BurstSelect />
        ) : (
          <div class="source-status">
            {kind === "serial" && <div>State: {store.connection.value}</div>}
            {kind === "demo" && <div class="demo-note">Demo data — not a real device</div>}
            {kind === "file" && <div>Streaming from file</div>}
          </div>
        )}
        <FileDropZone compact />
      </section>

      <section class="drawer-section">
        <div class="section-label">Analysis</div>
        <label class="field-row">
          <span>IMU Hz</span>
          <select
            class="input"
            value={settings.imuHz}
            onChange={(event) => store.patchSettings({ imuHz: Number((event.target as HTMLSelectElement).value) })}
          >
            {IMU_HZ_CHOICES.map((hz) => (
              <option value={hz} key={hz}>
                {hz}
              </option>
            ))}
          </select>
        </label>
        <label class="field-row">
          <span>FFT max</span>
          <select
            class="input"
            value={settings.fftMaxHz}
            onChange={(event) => store.patchSettings({ fftMaxHz: Number((event.target as HTMLSelectElement).value) })}
          >
            {FFT_MAX_FREQ_CHOICES.map((hz) => (
              <option value={hz} key={hz}>
                {hz} Hz
              </option>
            ))}
          </select>
        </label>
        <label class="field-row">
          <span>FFT refresh</span>
          <input
            class="input"
            type="number"
            min={0.5}
            max={60}
            step={0.5}
            value={settings.fftRefreshHz}
            onChange={(event) =>
              store.patchSettings({ fftRefreshHz: Number((event.target as HTMLInputElement).value) })
            }
          />
        </label>
        <label class="field-row">
          <span>Sensitivity</span>
          <select
            class="input"
            value={settings.lsbPerG}
            onChange={(event) => store.patchSettings({ lsbPerG: Number((event.target as HTMLSelectElement).value) })}
          >
            {LSB_PER_G_CHOICES.map((lsb) => (
              <option value={lsb} key={lsb}>
                {lsb} LSB/g{lsb === 256 ? " (old ADXL345)" : " (new sensor)"}
              </option>
            ))}
          </select>
        </label>
        <label class="field-row">
          <span>Time window</span>
          <button
            class="btn btn-small"
            onClick={() =>
              store.patchSettings({
                windowSeconds: settings.windowSeconds === WINDOW_SECONDS ? ZOOM_WINDOW_SECONDS : WINDOW_SECONDS,
              })
            }
          >
            {settings.windowSeconds === WINDOW_SECONDS ? "2 s" : "0.2 s (zoom)"}
          </button>
        </label>
      </section>

      <section class="drawer-section">
        <ExportPanel />
      </section>

      <section class="drawer-section">
        <EscPanel />
      </section>

      <section class="drawer-section">
        <div class="section-label">FETtec ESC</div>
        <div class="esc-dim fettec-settings-note">
          Structural changes (baud, count, ID base, poles, CLI line) apply on the next connect.
        </div>
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
            onInput={(event) => store.patchSettings({ fettecIdBase: Number((event.target as HTMLInputElement).value) })}
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
            onInput={(event) => store.patchSettings({ fettecPoles: Number((event.target as HTMLInputElement).value) })}
          />
        </label>
        <label class="field-row">
          <span>CLI line override</span>
          <input
            class="input fettec-cli-input"
            type="text"
            value={settings.fettecCliLine}
            placeholder="serialpassthrough esc_sensor 2000000 rxtx reset"
            disabled={fettecLive}
            onInput={(event) => store.patchSettings({ fettecCliLine: (event.target as HTMLInputElement).value })}
          />
        </label>
        <label class="field-row">
          <span>Signal check power</span>
          <input
            class="input"
            type="number"
            min={1}
            max={50}
            value={settings.fettecCheckPower}
            onInput={(event) =>
              store.patchSettings({ fettecCheckPower: Number((event.target as HTMLInputElement).value) })
            }
          />
        </label>
        <label class="field-row">
          <span>RPM source motor</span>
          <select
            class="input"
            value={settings.fettecRpmMotor}
            onChange={(event) =>
              store.patchSettings({ fettecRpmMotor: Number((event.target as HTMLSelectElement).value) })
            }
          >
            <option value={0}>Mean of all</option>
            {Array.from({ length: settings.fettecEscCount }, (_, index) => (
              <option value={index + 1} key={index + 1}>
                Motor {index + 1}
              </option>
            ))}
          </select>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={settings.fettecAutoReboot}
            onChange={(event) => store.patchSettings({ fettecAutoReboot: (event.target as HTMLInputElement).checked })}
          />
          <span>Drop DTR on disconnect (reboot FC)</span>
        </label>
        <details class="fettec-scale-details">
          <summary>Telemetry scale overrides</summary>
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
      </section>

      <section class="drawer-section">
        <div class="section-label">Advanced</div>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={settings.autoReconnect}
            onChange={(event) => store.patchSettings({ autoReconnect: (event.target as HTMLInputElement).checked })}
          />
          <span>Auto-reconnect sensor</span>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={settings.autoplayDemo}
            onChange={(event) => store.patchSettings({ autoplayDemo: (event.target as HTMLInputElement).checked })}
          />
          <span>Autoplay landing demo</span>
        </label>
        <div class="drawer-buttons">
          <button
            class="btn btn-small"
            onClick={async () => {
              try {
                await store.serialSource.forgetPort();
                pushToast({ kind: "info", title: "Port forgotten" });
              } catch {
                pushToast({ kind: "warn", title: "No granted port to forget" });
              }
            }}
          >
            Forget port
          </button>
          <button
            class="btn btn-small"
            onClick={() => {
              store.resetSettings();
              pushToast({ kind: "info", title: "Settings reset" });
            }}
          >
            Reset settings
          </button>
          <button class="btn btn-small" onClick={() => void store.goLanding()}>
            Back to landing
          </button>
        </div>
      </section>
    </aside>
  );
}
