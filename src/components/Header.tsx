// Sticky header: brand, source badge, quick stats, connect, settings, help.

import { store } from "../state/store";
import { debugLogCount, downloadDebugLog } from "../state/debugLog";
import { Brand } from "./Brand";
import { formatInt } from "../core/units";

const STATE_DOT: Record<string, string> = {
  streaming: "dot-ok",
  connecting: "dot-warn",
  reconnecting: "dot-warn",
  requesting: "dot-warn",
  error: "dot-danger",
  idle: "dot-idle",
};

export function Header({
  onConnect,
  onSettings,
  onAbout,
}: {
  onConnect: () => void;
  onSettings: () => void;
  onAbout: () => void;
}) {
  const kind = store.sourceKind.value;
  const connection = store.connection.value;
  const staticMode = store.staticMode.value;
  const diag = store.diagnostics.value;
  const paused = store.paused.value;
  const demo = kind === "demo";
  const badge = demo ? "DEMO" : kind === "file" ? "FILE" : "LIVE";
  const connected =
    (kind === "serial" && (connection === "streaming" || connection === "reconnecting")) ||
    (kind === "demo" && !staticMode) ||
    (kind === "file" && staticMode);
  // Freeze only makes sense for a live stream on the dashboard (file bursts
  // and the static demo bursts are already frozen).
  const canFreeze = store.screen.value === "dashboard" && connected && !staticMode && kind !== "file";

  return (
    <header class="app-header">
      <Brand />
      <span
        class={`source-badge ${demo ? "source-badge-demo" : ""}`}
        title={demo ? "Demo data — not a real device" : store.deviceLabel.peek()}
      >
        <span class={`dot ${connected ? (STATE_DOT[connection] ?? "dot-idle") : "dot-idle"}`} />
        {badge}
      </span>
      <span class="header-device">{store.deviceLabel.value}</span>
      <span class="header-chip tabular">{store.settings.value.imuHz} Hz</span>
      {diag.lostPackets > 0 && (
        <span class="header-chip header-chip-danger tabular">Loss {formatInt(diag.lostPackets)}</span>
      )}
      <span class="header-chip tabular">FPS {formatInt(diag.fps)}</span>
      {canFreeze && (
        <button
          class={`btn btn-small ${paused ? "btn-accent" : ""}`}
          aria-pressed={paused}
          title={paused ? "Resume live updates" : "Freeze the charts (data keeps buffering)"}
          onClick={() => {
            store.paused.value = !store.paused.value;
          }}
        >
          {paused ? "Resume" : "Freeze"}
        </button>
      )}
      <span class="header-spacer" />
      {kind === "serial" && connected ? (
        <button class="btn" onClick={() => void store.disconnectSerial()}>
          Disconnect
        </button>
      ) : (
        <button class="btn btn-accent" onClick={onConnect}>
          Connect
        </button>
      )}
      <button
        class="btn btn-icon"
        aria-label="Open controls panel"
        title="Controls panel: source, analysis, export, ESC control, files"
        onClick={onSettings}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
        >
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
      </button>
      <button
        class="btn btn-icon"
        aria-label="Download debug log"
        title={`Download the app debug log (${debugLogCount.value} events): sessions, ESC bus lines, warnings`}
        onClick={() => downloadDebugLog()}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
        >
          <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
          <path d="M4 21h16" />
        </svg>
      </button>
      <button
        class="btn btn-icon"
        aria-label="ESC settings"
        title="FETtec ESC settings: OneWire bus, motors, RPM source, telemetry scales"
        onClick={() => {
          window.dispatchEvent(new CustomEvent("vibro:esc-settings"));
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.06a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.06a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1Z" />
        </svg>
      </button>
      <button class="btn btn-icon" aria-label="About Vibro" onClick={onAbout}>
        ?
      </button>
    </header>
  );
}
