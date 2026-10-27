// FETtec OneWire panel (lazy-loaded). Connects through a Betaflight FC in
// `serialpassthrough esc_sensor` mode, scans the bus, streams fast-throttle
// frames at ~100 Hz and reports whether each motor is driven by OneWire or by
// the FC pins.
//
// Safety: the 250 ms ESC failsafe makes the continuous frame stream the
// stop mechanism; STOP ramps down, Emergency stop zeroes immediately. The
// props-off dialog gates the first motor command and the signal check.

import { useEffect, useState } from "preact/compat";
import { FETTEC_MAX_ESCS, FETTEC_TLM_STALE_MS } from "../core/constants";
import type { FettecStep, FettecVerdict } from "../core/fettec/types";
import { requestNewPort } from "../sources/serial";
import { fettecMotorCount, fettecSession } from "../state/fettec-session";
import { store } from "../state/store";
import { pushToast } from "../state/toasts";
import { SafetyDialog } from "./SafetyDialog";

const STEP_ORDER: FettecStep[] = ["cli", "passthrough", "scan", "init", "ready"];
const STEP_LABELS: Record<string, string> = {
  cli: "CLI",
  passthrough: "passthrough",
  scan: "scan",
  init: "init",
  ready: "ready",
};

const VERDICT_LABELS: Record<FettecVerdict, string> = {
  onewire: "OneWire bus",
  "fc-pin": "FC pin (inferred)",
  "no-onewire": "not on bus",
  unknown: "unknown",
};

function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function tlmAge(lastTelemetryMs: number | null, now: number): { text: string; stale: boolean } {
  if (lastTelemetryMs === null) return { text: "—", stale: true };
  const age = Math.max(0, now - lastTelemetryMs);
  if (age > FETTEC_TLM_STALE_MS) return { text: `${Math.round(age)} ms (stale)`, stale: true };
  return { text: `${Math.round(age)} ms`, stale: false };
}

function average(values: (number | null)[]): number | null {
  const numbers = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (numbers.length === 0) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

export function FettecPanel() {
  const esc = store.esc.value;
  const [showSafety, setShowSafety] = useState(false);
  const [pending, setPending] = useState<"start" | "check" | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [applyAll, setApplyAll] = useState(0);

  // Leaving the panel (mode switch / drawer unmount) must never leave the bus
  // streaming: disconnect zeroes the motors and drops DTR so the FC reboots.
  useEffect(() => {
    return () => {
      void fettecSession.disconnect();
    };
  }, []);

  const connected = esc.connected;
  const busy = connecting || esc.checkRunning;
  const motorCount = Math.max(1, Math.min(FETTEC_MAX_ESCS, esc.targets.length || fettecMotorCount()));
  const stepIndex = STEP_ORDER.indexOf(esc.busStats.state);
  const now = performance.now();
  const analog = esc.mspAnalog;
  const escVolt = average(esc.telemetry.map((entry) => entry.volt));
  const escAmps = average(esc.telemetry.map((entry) => entry.amps));
  const crossCheckMismatch =
    analog !== null &&
    escVolt !== null &&
    (Math.abs(analog.voltage - escVolt) > Math.max(0.2, analog.voltage * 0.1) ||
      (escAmps !== null && Math.abs(analog.current - escAmps) > Math.max(0.3, analog.current * 0.15)));

  const connect = async () => {
    if (connecting || connected) return;
    try {
      const sensorPort = store.serialSource.grantedPort;
      const port = await requestNewPort();
      if (sensorPort && port === sensorPort) {
        pushToast({ kind: "warn", title: "FETtec", message: "The sensor port cannot be the FC passthrough port." });
        return;
      }
      setConnecting(true);
      const ok = await fettecSession.connect(port);
      if (ok) pushToast({ kind: "info", title: "FETtec", message: "OneWire bus ready." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message) pushToast({ kind: "error", title: "FETtec", message });
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    await fettecSession.disconnect();
  };

  const start = () => {
    if (!connected) {
      pushToast({ kind: "error", title: "FETtec", message: "Connect the bus first." });
      return;
    }
    if (!esc.warningAcknowledged) {
      setPending("start");
      setShowSafety(true);
      return;
    }
    if (!fettecSession.start()) pushToast({ kind: "warn", title: "FETtec", message: "Start was rejected." });
  };

  const stop = () => {
    if (!connected) return;
    fettecSession.stop();
  };

  const emergencyStop = () => {
    void fettecSession.emergencyStop("Emergency stop");
  };

  const runCheck = () => {
    if (!connected) {
      pushToast({ kind: "error", title: "FETtec", message: "Connect the bus first." });
      return;
    }
    if (!esc.warningAcknowledged) {
      setPending("check");
      setShowSafety(true);
      return;
    }
    void fettecSession.runCheck();
  };

  const confirmSafety = () => {
    store.patchEsc({ warningAcknowledged: true });
    setShowSafety(false);
    const action = pending;
    setPending(null);
    if (action === "start") fettecSession.start();
    else if (action === "check") void fettecSession.runCheck();
  };

  const setMotor = (index: number, value: number) => {
    const percent = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
    fettecSession.setMotor(index, percent);
  };

  return (
    <>
      <div class="esc-status">
        FETtec: <b>{connected ? "connected" : connecting ? "connecting…" : "disconnected"}</b>
        {esc.running && <span class="esc-running"> · RUNNING</span>}
        {esc.ramping && <span class="esc-running"> · ramping…</span>}
        {esc.checkRunning && <span class="esc-dim"> · signal check…</span>}
      </div>

      <ol class="fettec-steps" aria-label="Passthrough steps">
        {STEP_ORDER.map((step, index) => (
          <li
            key={step}
            class={`fettec-step ${index === stepIndex ? "fettec-step-active" : ""} ${
              stepIndex >= 0 && index < stepIndex ? "fettec-step-done" : ""
            }`}
          >
            <span class="fettec-step-index">{index + 1}</span>
            {STEP_LABELS[step]}
          </li>
        ))}
      </ol>

      {esc.paused && (
        <div class="fettec-paused" role="status">
          <b>Passthrough paused.</b> {esc.error ?? "The link stopped and the ESCs were zeroed."}
          <button class="btn btn-small" disabled={connecting} onClick={() => void connect()}>
            Reconnect
          </button>
        </div>
      )}

      <div class="esc-actions">
        {connected ? (
          <button class="btn" disabled={busy} onClick={() => void disconnect()}>
            Disconnect FETtec
          </button>
        ) : (
          <button class="btn" disabled={connecting} onClick={() => void connect()}>
            {connecting ? "Connecting…" : "Connect FETtec"}
          </button>
        )}
      </div>

      {esc.devices.length > 0 && (
        <div class="fettec-table-wrap">
          <table class="fettec-table" aria-label="FETtec devices">
            <thead>
              <tr>
                <th>ID</th>
                <th>Model</th>
                <th>FW</th>
                <th>SN</th>
                <th>TLM</th>
                <th>°C</th>
                <th>V</th>
                <th>A</th>
                <th>RPM</th>
                <th>mAh</th>
              </tr>
            </thead>
            <tbody>
              {esc.devices.map((device) => {
                const tlm = esc.telemetry[device.index];
                const age = tlmAge(device.lastTelemetryMs, now);
                const verdict = esc.check?.results.find((result) => result.escIndex === device.index)?.verdict;
                return (
                  <tr key={device.id} class={age.stale ? "fettec-row-stale" : ""}>
                    <td>
                      {device.id}
                      {!device.present && (
                        <span class="fettec-missing" title={device.error ?? "not present"}>
                          {" "}
                          !
                        </span>
                      )}
                      {verdict && (
                        <span class={`fettec-verdict fettec-verdict-${verdict}`} title={VERDICT_LABELS[verdict]}>
                          {verdict === "onewire"
                            ? "OW"
                            : verdict === "fc-pin"
                              ? "FC"
                              : verdict === "no-onewire"
                                ? "—"
                                : "?"}
                        </span>
                      )}
                    </td>
                    <td title={device.error ?? undefined}>{device.typeName}</td>
                    <td>{device.firmware || "—"}</td>
                    <td class="fettec-serial" title={device.serial}>
                      {device.serial || "—"}
                    </td>
                    <td>{age.text}</td>
                    <td>{fmt(tlm?.tempC, 0)}</td>
                    <td>{fmt(tlm?.volt, 2)}</td>
                    <td>{fmt(tlm?.amps, 2)}</td>
                    <td>{fmt(tlm?.rpm, 0)}</td>
                    <td>{fmt(tlm?.mah, 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div class="fettec-motors">
        {Array.from({ length: motorCount }, (_, index) => {
          const target = esc.targets[index] ?? 0;
          const tlm = esc.telemetry[index];
          return (
            <div class="fettec-motor" key={index}>
              <span class="fettec-motor-label">M{index + 1}</span>
              <input
                class="fettec-slider"
                type="range"
                min={0}
                max={100}
                step={1}
                value={target}
                disabled={!connected || esc.checkRunning}
                aria-label={`Motor ${index + 1} throttle`}
                onInput={(event) => setMotor(index, Number((event.target as HTMLInputElement).value))}
              />
              <input
                class="input fettec-motor-input"
                type="number"
                min={0}
                max={100}
                step={1}
                value={target}
                disabled={!connected || esc.checkRunning}
                aria-label={`Motor ${index + 1} percent`}
                onInput={(event) => setMotor(index, Number((event.target as HTMLInputElement).value))}
              />
              <span class="fettec-motor-rpm tabular">{fmt(tlm?.rpm, 0)} rpm</span>
            </div>
          );
        })}
      </div>

      <div class="fettec-apply">
        <label class="field-row">
          <span>Apply to all</span>
          <input
            class="input"
            type="number"
            min={0}
            max={100}
            step={1}
            value={applyAll}
            disabled={!connected || esc.checkRunning}
            aria-label="Apply percent to all motors"
            onInput={(event) => setApplyAll(Number((event.target as HTMLInputElement).value))}
          />
        </label>
        <button
          class="btn btn-small"
          disabled={!connected || esc.checkRunning}
          onClick={() => fettecSession.setAll(Math.max(0, Math.min(100, applyAll || 0)))}
        >
          Apply to all
        </button>
      </div>

      <div class="esc-actions">
        <button
          class="btn btn-accent"
          disabled={!connected || esc.running || esc.ramping || esc.checkRunning}
          onClick={start}
        >
          START
        </button>
        <button class="btn btn-danger esc-stop" disabled={!connected || (!esc.running && !esc.ramping)} onClick={stop}>
          STOP
        </button>
      </div>

      <div class="esc-actions">
        <button class="btn btn-danger btn-small" disabled={!connected} onClick={emergencyStop}>
          Emergency stop
        </button>
        <button
          class="btn btn-small"
          disabled={!connected || esc.checkRunning || esc.running || esc.ramping}
          onClick={runCheck}
        >
          Run signal check
        </button>
      </div>

      <div class="fettec-crosscheck">
        <div class="section-label">Signal check</div>
        {esc.check ? (
          <>
            <div class={`fettec-summary ${esc.check.allOneWire ? "fettec-summary-ok" : "fettec-summary-warn"}`}>
              {esc.check.summary}
            </div>
            <ul class="fettec-verdicts">
              {esc.check.results.map((result) => (
                <li key={result.escIndex}>
                  <b>M{result.escIndex + 1}</b>{" "}
                  <span class={`fettec-verdict fettec-verdict-${result.verdict}`}>
                    {VERDICT_LABELS[result.verdict]}
                  </span>
                  <span class="esc-dim">
                    {" "}
                    · {fmt(result.baselineErpm, 0)}→{fmt(result.pulseErpm, 0)} eRPM
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div class="esc-dim">
            Runs a {store.settings.value.fettecCheckPower}% pulse on one motor at a time. “FC pin” is inferred: the ESC
            answers on the bus but ignores bus throttle (Betaflight holds the motor pins high in passthrough).
          </div>
        )}
        <div class="fettec-msp-check">
          {analog ? (
            <>
              MSP cross-check: FC {fmt(analog.voltage, 2)} V / {fmt(analog.current, 2)} A · ESC avg {fmt(escVolt, 2)} V
              / {fmt(escAmps, 2)} A{" "}
              <span class={crossCheckMismatch ? "status-danger" : "esc-dim"}>
                {crossCheckMismatch ? "— mismatch, adjust the scale overrides" : "— match"}
              </span>
            </>
          ) : (
            <span class="esc-dim">
              No MSP V/A snapshot yet. Connect the MSP panel once before passthrough to compare the scales.
            </span>
          )}
        </div>
      </div>

      <div class="fettec-stats tabular" aria-label="FETtec bus statistics">
        <span>state {esc.busStats.state}</span>
        <span>frames {esc.busStats.framesSent}</span>
        <span>replies {esc.busStats.replies}</span>
        <span>loop {esc.busStats.loopHz} Hz</span>
        <span>RX {(esc.busStats.rxBytesPerSecond / 1024).toFixed(1)} KB/s</span>
        <span>CRC {esc.busStats.crcErrors}</span>
        <span>timeouts {esc.busStats.timeouts}</span>
      </div>

      <div class="esc-diagnostic" aria-live="polite">
        {esc.diagnostic}
        {esc.error && <span class="status-danger"> — {esc.error}</span>}
      </div>

      {showSafety && (
        <SafetyDialog
          mode="fettec"
          onConfirm={confirmSafety}
          onCancel={() => {
            setShowSafety(false);
            setPending(null);
          }}
        />
      )}
    </>
  );
}

export default FettecPanel;
