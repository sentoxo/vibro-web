// MSP / FC control panel: second Web Serial port at 115200, MSP motor
// commands, RPM telemetry, safety gating (plan §6.13, §5.6).
//
// Residual risk (D13): commands go out on start/power-change/stop only —
// no heartbeat, no auto-stop. Untested on real hardware; props-off modal
// gates the first command. The FETtec path (FettecPanel) is separate and does
// send continuous frames.

import { useEffect, useRef, useState } from "preact/compat";
import { FC_BAUD_RATE, TELEMETRY_POLL_MS, ESC_RAMP_INTERVAL_MS, ESC_MAX_CHANNELS } from "../core/constants";
import { EscController } from "../core/esc";
import {
  analogRequestPacket,
  MspParser,
  parseAnalog,
  parseMotorTelemetry,
  setMotorPacket,
  telemetryRequestPacket,
} from "../core/msp";
import { requestNewPort } from "../sources/serial";
import { store } from "../state/store";
import { pushToast } from "../state/toasts";
import { SafetyDialog } from "./SafetyDialog";

export function MspEscPanel() {
  const esc = store.esc.value;
  const settings = store.settings.value;
  const [showSafety, setShowSafety] = useState(false);
  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const runningRef = useRef(false);
  const telemetryTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const rampTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const parserRef = useRef<MspParser | null>(null);
  const escRef = useRef<EscController | null>(null);
  // One writer at a time: back-to-back polls (telemetry + MSP_ANALOG) used to
  // race for `writable.getWriter()` and silently drop the second request.
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve());

  const log = (message: string, level: "INFO" | "OK" | "ERROR" = "INFO") => {
    store.patchEsc({ diagnostic: `[FC] ${level}: ${message}` });
  };

  const writePacket = (packet: Uint8Array): boolean => {
    const port = portRef.current;
    if (!port?.writable) return false;
    writeQueue.current = writeQueue.current.then(async () => {
      const target = portRef.current;
      if (!target?.writable) return false;
      try {
        const writer = target.writable.getWriter();
        try {
          await writer.write(packet);
          return true;
        } finally {
          try {
            writer.releaseLock();
          } catch {
            // Already released (port closed mid-write).
          }
        }
      } catch {
        store.patchEsc({ connected: false, running: false, error: "FC write failed" });
        return false;
      }
    });
    return true;
  };

  if (escRef.current === null) {
    escRef.current = new EscController((throttles) => {
      const ok = writePacket(setMotorPacket(throttles));
      log(
        ok ? `Sending ESC packet channels=[${throttles.join(",")}]` : "FC serial not writable; command dropped",
        ok ? "INFO" : "ERROR",
      );
      return ok;
    });
  }

  useEffect(() => {
    parserRef.current = new MspParser({
      onResponse: (response) => {
        if (response.command === 139) {
          const telemetry = parseMotorTelemetry(response.payload, store.settings.peek().escMotorChannel);
          if (telemetry) {
            store.patchEsc({ rpm: telemetry.rpm ?? 0, motorCount: telemetry.motorCount });
          }
        } else if (response.command === 110) {
          const analog = parseAnalog(response.payload);
          if (analog) store.patchEsc({ mspAnalog: analog });
        }
      },
      onChecksumError: () => log("MSP checksum error", "ERROR"),
    });
    return () => {
      void shutdownFc();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readLoop = async (port: SerialPort) => {
    while (runningRef.current && port.readable) {
      const reader = port.readable.getReader();
      readerRef.current = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parserRef.current?.push(value);
        }
      } catch {
        break;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // already released
        }
      }
    }
  };

  const connectFc = async () => {
    try {
      const sensorPort = store.serialSource.grantedPort;
      const port = await requestNewPort();
      if (port === sensorPort) {
        log("Refused: selected port is the sensor port", "ERROR");
        pushToast({ kind: "warn", title: "FC", message: "The sensor port cannot be the FC port." });
        return;
      }
      await port.open({ baudRate: FC_BAUD_RATE });
      portRef.current = port;
      runningRef.current = true;
      void readLoop(port);
      telemetryTimer.current = setInterval(() => {
        if (runningRef.current && portRef.current?.writable) {
          writePacket(telemetryRequestPacket());
          // MSP_ANALOG is the cross-check source for the FETtec signal check.
          // Poll it at half the motor-telemetry rate to keep the link light.
          writePacket(analogRequestPacket());
        }
      }, TELEMETRY_POLL_MS);
      store.patchEsc({ connected: true, error: null });
      log(`FC connected at ${FC_BAUD_RATE} baud.`, "OK");
    } catch (error) {
      log(`FC connection failed: ${error instanceof Error ? error.message : error}`, "ERROR");
      store.patchEsc({ connected: false, error: "FC connection failed" });
    }
  };

  const shutdownFc = async () => {
    runningRef.current = false;
    if (telemetryTimer.current !== null) clearInterval(telemetryTimer.current);
    if (rampTimer.current !== null) clearInterval(rampTimer.current);
    telemetryTimer.current = null;
    rampTimer.current = null;
    const port = portRef.current;
    if (port?.writable) {
      writePacket(setMotorPacket([1000, 1000, 1000, 1000]));
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    try {
      readerRef.current?.cancel().catch(() => {});
      await port?.close();
    } catch {
      // already closed
    }
    portRef.current = null;
    readerRef.current = null;
    escRef.current = null;
    store.patchEsc({ connected: false, running: false, ramping: false, rpm: 0, power: 0 });
    log("FC disconnected.", "OK");
  };

  const startMotors = () => {
    if (!escRef.current || !esc.connected) {
      pushToast({ kind: "error", title: "ESC", message: "FC is not connected." });
      return;
    }
    if (!esc.warningAcknowledged) {
      setShowSafety(true);
      return;
    }
    const ok = escRef.current.start();
    store.patchEsc({ running: ok, power: escRef.current.power });
    log(ok ? "ESC start command accepted." : "ESC start failed.", ok ? "OK" : "ERROR");
  };

  const stopMotors = () => {
    const controller = escRef.current;
    if (!controller || !esc.connected) return;
    if (!controller.stop()) return;
    store.patchEsc({ running: false, ramping: true });
    log("Stop ramp started.", "INFO");
    rampTimer.current = setInterval(() => {
      controller.stepRamp();
      store.patchEsc({ power: controller.power });
      if (controller.phase === "idle") {
        if (rampTimer.current !== null) clearInterval(rampTimer.current);
        rampTimer.current = null;
        store.patchEsc({ ramping: false });
        log("Stop ramp completed; motors at zero throttle.", "OK");
      }
    }, ESC_RAMP_INTERVAL_MS);
  };

  const setPower = (value: number) => {
    const controller = escRef.current;
    if (!controller) return;
    const power = Math.min(100, Math.max(0, value));
    controller.setPower(power);
    store.patchEsc({ power: controller.power });
    if (esc.running) log(`Power → ${controller.power}% (sent).`, "INFO");
  };

  return (
    <>
      <div class="esc-status">
        FC: <b>{esc.connected ? "connected" : "disconnected"}</b>
        {esc.running && <span class="esc-running"> · RUNNING</span>}
        {esc.ramping && <span class="esc-running"> · ramping…</span>}
      </div>
      <div class="esc-rpm tabular">
        RPM (motor {settings.escMotorChannel}): <b>{Math.round(esc.rpm)}</b>
        {esc.motorCount > 0 && <span class="esc-dim"> · {esc.motorCount} motors</span>}
      </div>

      <label class="field-row">
        <span>RPM motor channel</span>
        <input
          class="input"
          type="number"
          min={1}
          max={ESC_MAX_CHANNELS}
          value={settings.escMotorChannel}
          onInput={(event) =>
            store.patchSettings({
              escMotorChannel: Number((event.target as HTMLInputElement).value),
            })
          }
        />
      </label>

      <div class="esc-power">
        <label class="field-row">
          <span>Power level</span>
          <input
            class="input"
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={esc.power}
            disabled={!esc.connected}
            onInput={(event) => setPower(Number((event.target as HTMLInputElement).value))}
          />
        </label>
        <div class="esc-power-buttons">
          <button class="btn btn-small" disabled={!esc.running} onClick={() => setPower(esc.power - 10)}>
            −10%
          </button>
          <button class="btn btn-small" disabled={!esc.running} onClick={() => setPower(esc.power - 1)}>
            −1%
          </button>
          <button class="btn btn-small" disabled={!esc.running} onClick={() => setPower(esc.power + 1)}>
            +1%
          </button>
          <button class="btn btn-small" disabled={!esc.running} onClick={() => setPower(esc.power + 10)}>
            +10%
          </button>
        </div>
      </div>

      <div class="esc-actions">
        <button class="btn btn-accent" disabled={!esc.connected || esc.running} onClick={startMotors}>
          START
        </button>
        <button
          class="btn btn-danger esc-stop"
          disabled={!esc.connected || (!esc.running && !esc.ramping)}
          onClick={stopMotors}
        >
          STOP
        </button>
      </div>

      <div class="esc-actions">
        {esc.connected ? (
          <button class="btn" onClick={() => void shutdownFc()}>
            Disconnect FC
          </button>
        ) : (
          <button class="btn" onClick={() => void connectFc()}>
            Connect FC (115200)
          </button>
        )}
      </div>

      <div class="esc-diagnostic" aria-live="polite">
        {esc.diagnostic}
        {esc.error && <span class="status-danger"> — {esc.error}</span>}
      </div>

      {showSafety && (
        <SafetyDialog
          onConfirm={() => {
            store.patchEsc({ warningAcknowledged: true });
            setShowSafety(false);
            startMotors();
          }}
          onCancel={() => setShowSafety(false)}
        />
      )}
    </>
  );
}
