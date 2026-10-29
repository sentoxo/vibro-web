// Settings sidebar / drawer: source, analysis, export, ESC, advanced
// (plan §5.6). All values persist via store settings.
//
// The FETtec ESC *setup* is not here: it lives in the centered
// FettecSettingsDialog (header gear), which also makes it reachable from the
// landing screen where this drawer is not mounted. The section below only
// summarises the bus and opens that window.

import {
  FETTEC_RPM_SOURCE_AUTO,
  FETTEC_RPM_SOURCE_MEAN,
  FFT_MAX_FREQ_CHOICES,
  IMU_HZ_CHOICES,
  LSB_PER_G_CHOICES,
  WINDOW_SECONDS,
  ZOOM_WINDOW_SECONDS,
} from "../core/constants";
import { store } from "../state/store";
import { pushToast } from "../state/toasts";
import { BurstSelect } from "./BurstSelect";
import { EscPanel } from "./EscPanel";
import { ExportPanel } from "./ExportPanel";
import { FileDropZone } from "./FileDropZone";

/** Short label for the RPM marker source, for the drawer's FETtec summary. */
function rpmSourceLabel(source: number): string {
  if (source === FETTEC_RPM_SOURCE_AUTO) return "Auto";
  if (source === FETTEC_RPM_SOURCE_MEAN) return "Mean";
  return `M${source}`;
}

export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = store.settings.value;
  const kind = store.sourceKind.value;
  const staticMode = store.staticMode.value;

  return (
    <aside class={`settings-drawer ${open ? "settings-drawer-open" : ""}`} aria-label="Controls panel">
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
          {settings.fettecEscCount} ESC · IDs {settings.fettecIdBase}-
          {settings.fettecIdBase + settings.fettecEscCount - 1} · {settings.fettecPoles} poles ·{" "}
          {settings.fettecEscBaud} · RPM {rpmSourceLabel(settings.fettecRpmMotor)}
        </div>
        <div class="drawer-buttons">
          <button
            class="btn btn-small"
            title="OneWire bus setup in a centered window: count, ID base, poles, baud, reply timeout, CLI line, RPM source, telemetry scales"
            onClick={() => window.dispatchEvent(new CustomEvent("vibro:esc-settings"))}
          >
            Open FETtec ESC settings
          </button>
        </div>
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
