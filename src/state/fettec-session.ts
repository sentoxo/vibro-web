// FETtec session: wires the Web Serial transport, the OneWire bus, the
// per-motor controller, the signal check and the reactive store.
//
// The bus owns the 100 Hz loop; this class ticks the ramp controller from the
// bus's `getRawValues` callback (so the ramp and the frames share one clock).

import {
  FETTEC_DEFAULT_CHECK_POWER,
  FETTEC_DEFAULT_ESC_BAUD,
  FETTEC_DEFAULT_ESC_COUNT,
  FETTEC_DEFAULT_ID_BASE,
  FETTEC_DEFAULT_POLES,
} from "../core/constants";
import { FettecBus } from "../core/fettec/bus";
import { FettecController } from "../core/fettec/controller";
import { DEFAULT_TLM_SCALES, type FettecTelemetryScales } from "../core/fettec/protocol";
import { runSignalCheck, type SignalSample } from "../core/fettec/signalCheck";
import type { FettecCheckSummary, FettecTelemetry } from "../core/fettec/types";
import { SerialFettecTransport } from "../sources/fettec-serial";
import { logDebug, logError, logInfo, logWarn } from "./debugLog";
import { store } from "./store";
import { pushToast } from "./toasts";

const CONTROL_SYNC_MS = 50;

/** Bus log lines carrying fault vocabulary are logged at warn level. */
function busLineLevel(line: string): "info" | "warn" {
  return /timeout|error|fail|problem|emergency|stop|no ack|not present/i.test(line) ? "warn" : "info";
}

function sameValues(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function emptyTelemetry(index: number): FettecTelemetry {
  return {
    escIndex: index,
    tempC: null,
    volt: null,
    amps: null,
    erpm: null,
    rpm: null,
    mah: null,
    debug: [null, null, null],
    lastTelemetryMs: null,
  };
}

function scalesFromSettings(): FettecTelemetryScales {
  const settings = store.settings.peek();
  return {
    temp: settings.fettecScaleTemp || DEFAULT_TLM_SCALES.temp,
    voltage: settings.fettecScaleVoltage || DEFAULT_TLM_SCALES.voltage,
    current: settings.fettecScaleCurrent || DEFAULT_TLM_SCALES.current,
    erpm: settings.fettecScaleErpm || DEFAULT_TLM_SCALES.erpm,
    consumption: settings.fettecScaleConsumption || DEFAULT_TLM_SCALES.consumption,
  };
}

class FettecSession {
  private bus: FettecBus | null = null;
  private controller: FettecController | null = null;
  private latestTelemetry: FettecTelemetry[] = [];
  private lastControlSync = 0;
  private connecting = false;

  // No visibilitychange stop (user decision): switching browser tabs must not
  // force-stop the motors. Background timers are throttled, so while the tab
  // is hidden the ESC's 250 ms hardware failsafe spins the motors down, and
  // the loop's targets resume driving them when the tab is shown again.
  // Port loss and write errors still trigger a real emergency stop.

  get isConnected(): boolean {
    return this.bus !== null && store.esc.peek().connected;
  }

  get isBusy(): boolean {
    return this.connecting || store.esc.peek().checkRunning;
  }

  async connect(port: SerialPort): Promise<boolean> {
    if (this.connecting) return false;
    if (this.bus) await this.disconnect();
    const settings = store.settings.peek();
    const count = settings.fettecEscCount;
    const controller = new FettecController(count);
    this.controller = controller;
    this.latestTelemetry = Array.from({ length: count }, (_, index) => emptyTelemetry(index));
    this.connecting = true;
    logInfo(
      "fettec",
      `connect requested: count=${count}, idBase=${settings.fettecIdBase}, poles=${settings.fettecPoles}, ` +
        `baud=${settings.fettecEscBaud}, replyTimeout=${settings.fettecReplyTimeoutMs} ms`,
    );

    store.patchEsc({
      mode: "fettec",
      connected: false,
      running: false,
      ramping: false,
      power: 0,
      error: null,
      paused: false,
      check: null,
      checkRunning: false,
      devices: [],
      telemetry: [],
      targets: new Array<number>(count).fill(0),
      diagnostic: "Connecting FETtec bus…",
    });

    const bus = new FettecBus(new SerialFettecTransport(port), {
      count,
      idBase: settings.fettecIdBase || FETTEC_DEFAULT_ID_BASE,
      baud: settings.fettecEscBaud || FETTEC_DEFAULT_ESC_BAUD,
      cliLine: settings.fettecCliLine,
      poles: settings.fettecPoles || FETTEC_DEFAULT_POLES,
      scales: scalesFromSettings(),
      autoReboot: settings.fettecAutoReboot,
      replyTimeoutMs: settings.fettecReplyTimeoutMs,
      getRawValues: (now) => {
        controller.tick(now);
        this.syncControl(now);
        return controller.rawValues();
      },
      onState: (step, message) => {
        store.patchEsc({
          connected: step === "ready",
          busStats: { ...store.esc.peek().busStats, state: step, message },
          diagnostic: message,
        });
        if (step === "error" || step === "stopped") {
          store.patchEsc({ running: false, ramping: false, power: 0 });
        }
      },
      onDevices: (devices) => store.patchEsc({ devices }),
      onTelemetry: (telemetry) => {
        this.latestTelemetry = telemetry;
        store.patchEsc({ telemetry });
        this.syncControl(performance.now(), true);
      },
      onStats: (busStats) => store.patchEsc({ busStats }),
      onLog: (line) => {
        logDebug("fettec", busLineLevel(line), line);
        store.patchEsc({ diagnostic: `[FETtec] ${line}` });
      },
      onEmergency: (reason) => {
        logWarn("fettec", `emergency stop: ${reason}`);
        this.controller?.emergencyStop();
        store.patchEsc({
          connected: false,
          running: false,
          ramping: false,
          power: 0,
          paused: true,
          error: reason,
          diagnostic: reason,
        });
        pushToast({ kind: "warn", title: "FETtec stopped", message: reason });
      },
    });
    this.bus = bus;

    try {
      await bus.connect();
      store.patchEsc({ connected: true, error: null, paused: false });
      logInfo("fettec", "bus ready: fast-throttle loop running");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.bus = null;
      this.controller = null;
      logError("fettec", `connect failed: ${message}`);
      store.patchEsc({ connected: false, error: message, diagnostic: message });
      pushToast({ kind: "error", title: "FETtec", message });
      return false;
    } finally {
      this.connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    const bus = this.bus;
    logInfo("fettec", "disconnect requested (zero frames, DTR drop)");
    this.bus = null;
    this.controller = null;
    this.latestTelemetry = [];
    if (bus) await bus.stop("Disconnected");
    store.patchEsc({
      connected: false,
      running: false,
      ramping: false,
      power: 0,
      devices: [],
      telemetry: [],
      targets: [],
      check: null,
      checkRunning: false,
      paused: false,
      diagnostic: "Disconnected",
    });
  }

  start(): boolean {
    const controller = this.controller;
    if (!controller || !this.isConnected) return false;
    const ok = controller.start();
    if (ok) logInfo("fettec", `START: motors ramping (targets: ${controller.targetValues().join(", ")} %)`);
    this.syncControl(performance.now(), true);
    return ok;
  }

  stop(): boolean {
    const controller = this.controller;
    if (!controller) return false;
    const ok = controller.stop();
    if (ok) logInfo("fettec", `STOP: ramping down from ${controller.currentPower}%`);
    this.syncControl(performance.now(), true);
    return ok;
  }

  emergencyStop(reason = "Manual emergency stop"): Promise<void> {
    logWarn("fettec", `emergency stop: ${reason}`);
    this.controller?.emergencyStop();
    this.syncControl(performance.now(), true);
    return this.bus?.emergencyStop(reason) ?? Promise.resolve();
  }

  setMotor(index: number, percent: number): void {
    this.controller?.setMotor(index, percent);
    this.syncControl(performance.now(), true);
  }

  setAll(percent: number): void {
    logInfo("fettec", `apply-to-all: ${percent}%`);
    this.controller?.setAll(percent);
    this.syncControl(performance.now(), true);
  }

  async runCheck(): Promise<FettecCheckSummary | null> {
    const controller = this.controller;
    if (!controller || !this.isConnected || store.esc.peek().checkRunning) return null;
    const settings = store.settings.peek();
    const power = settings.fettecCheckPower || FETTEC_DEFAULT_CHECK_POWER;
    store.patchEsc({ checkRunning: true, check: null, diagnostic: "Signal check running…" });

    try {
      const summary = await runSignalCheck({
        count: controller.count,
        power,
        read: (index) => this.sample(index),
        setMotor: (index, percent) => this.setMotor(index, percent),
        setAll: (percent) => this.setAll(percent),
        start: () => {
          this.start();
        },
        stop: () => {
          this.stop();
        },
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => performance.now(),
        aborted: () => !this.isConnected,
      });
      store.patchEsc({ check: summary, checkRunning: false, diagnostic: summary.summary });
      logInfo("fettec", `signal check: ${summary.summary}`);
      pushToast({ kind: summary.allOneWire ? "info" : "warn", title: "Signal check", message: summary.summary });
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.patchEsc({ checkRunning: false, error: message, diagnostic: message });
      pushToast({ kind: "error", title: "Signal check", message });
      return null;
    } finally {
      controller.setAll(0);
      controller.stop();
      this.syncControl(performance.now(), true);
    }
  }

  destroy(): void {
    void this.disconnect();
  }

  private sample(index: number): SignalSample {
    const entry = this.latestTelemetry[index];
    // The ESC self-diagnosis lives on the device record; a self-diagnosing
    // channel reports problem codes, not measurements (see classifySignalCheck).
    const problem = store.esc.peek().devices[index]?.problem ?? null;
    return {
      erpm: entry?.erpm ?? null,
      amps: entry?.amps ?? null,
      lastTelemetryMs: entry?.lastTelemetryMs ?? null,
      problem,
    };
  }

  private syncControl(now: number, force = false): void {
    const controller = this.controller;
    if (!controller) return;
    if (!force && now - this.lastControlSync < CONTROL_SYNC_MS) return;
    this.lastControlSync = now;
    const current = store.esc.peek();
    const power = controller.currentPower;
    const targets = controller.targetValues();
    if (
      current.power !== power ||
      current.running !== controller.running ||
      current.ramping !== controller.ramping ||
      !sameValues(current.targets, targets)
    ) {
      store.patchEsc({ power, running: controller.running, ramping: controller.ramping, targets });
    }
  }

  /** Per-motor commanded percentages (for the panel inputs). */
  targets(): number[] {
    return this.controller?.targetValues() ?? [];
  }
}

export const fettecSession = new FettecSession();

/** Number of configured motors, clamped to the FETtec limit. */
export function fettecMotorCount(): number {
  return store.settings.peek().fettecEscCount || FETTEC_DEFAULT_ESC_COUNT;
}
