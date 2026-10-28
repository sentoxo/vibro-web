// FETtec OneWire bus session over a Betaflight `serialpassthrough` link.
//
// The transport is injected so the protocol/session logic stays testable and
// the Web Serial adapter lives in `src/sources/fettec-serial.ts`.
//
// Conventions mirror `src/sources/serial.ts`: every connect/stop bumps an
// `epoch`; read loops, waiters and timers bound to an older epoch are ignored.
// One persistent writer is owned by the transport (the MSP path's
// getWriter-per-write is how commands get dropped).
//
// Half-duplex: the host's own fast-throttle frame is echoed back before the
// ESC telemetry. `consumeFastReply` finds the exact echo and takes `count*2`
// telemetry bytes; a full-length echo that is not byte-identical (real rigs
// bit-flip echo bytes, byte 0 slot/0x80 bits included, under the 2 Mbit
// half-duplex turnaround) is skipped by length, the configurator/ArduPilot
// way, so a bit-flipped echo no longer means "timeouts == frames".

import {
  FETTEC_BOOTLOADER_SETTLE_MS,
  FETTEC_CLI_BANNER_TIMEOUT_MS,
  FETTEC_CLI_SETTLE_MS,
  FETTEC_CONFIG_RETRIES,
  FETTEC_CONFIG_TIMEOUT_MS,
  FETTEC_LOOP_INTERVAL_MS,
  FETTEC_REPLY_TIMEOUT_MS,
  FETTEC_RX_MAX_BYTES,
  FETTEC_STATS_INTERVAL_MS,
  FETTEC_TELEMETRY_PATCH_MS,
  FETTEC_ZERO_FRAMES,
} from "../constants";
import {
  buildConfigFrame,
  concatBytes,
  consumeFastReply,
  decodeFastTelemetry,
  extractFrames,
  fastThrottleLen,
  fettecDeviceName,
  fettecProblemInfo,
  MSG,
  packFastThrottle,
  SRC_BOOTLOADER,
  SRC_ESC,
  TLM_DIAGNOSTIC_MARKER,
  TLM_TYPE_FAST_SLOTS,
  type FettecFrame,
  type FettecTelemetryScales,
} from "./protocol";
import type { FettecBusStats, FettecDevice, FettecStep, FettecTelemetry } from "./types";

export interface FettecTransport {
  readonly label: string;
  open(): Promise<void>;
  /** One persistent writer; must not take a fresh writer per call. */
  write(bytes: Uint8Array): Promise<void>;
  /** Resolves with the next chunk, or null when the link is closed. */
  read(): Promise<Uint8Array | null>;
  setDtr(value: boolean): Promise<void>;
  close(): Promise<void>;
}

export interface FettecBusOptions {
  count: number;
  idBase: number;
  /** ESC bus baud written into the generated CLI line. */
  baud: number;
  /** Explicit CLI line override ("" = generate from `baud`). */
  cliLine: string;
  poles: number;
  scales: FettecTelemetryScales;
  autoReboot: boolean;
  /** Fast-reply window (write → complete telemetry block). Raise for FCs whose
   * USB VCP forwarding is slow; default FETTEC_REPLY_TIMEOUT_MS. */
  replyTimeoutMs?: number;
  /** Called once per fast-throttle frame; tick the ramp controller here. */
  getRawValues(nowMs: number): number[];
  onState(step: FettecStep, message: string): void;
  onDevices(devices: FettecDevice[]): void;
  onTelemetry(telemetry: FettecTelemetry[]): void;
  onStats(stats: FettecBusStats): void;
  onLog(line: string): void;
  onEmergency(reason: string): void;
}

const EMPTY_STATS: FettecBusStats = {
  state: "idle",
  framesSent: 0,
  replies: 0,
  crcErrors: 0,
  timeouts: 0,
  echoFallbacks: 0,
  rxDebug: "",
  loopHz: 0,
  rxBytesPerSecond: 0,
  message: "",
  updatedAt: 0,
};

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

function emptyDevice(id: number, index: number): FettecDevice {
  return {
    id,
    index,
    present: false,
    source: "unknown",
    type: 0,
    typeName: "unknown",
    firmware: "",
    serial: "",
    error: null,
    problem: null,
    problemCode: null,
    lastTelemetryMs: null,
  };
}

function serialHex(payload: Uint8Array): string {
  let out = "";
  for (let i = 0; i < payload.length; i++) out += payload[i].toString(16).padStart(2, "0").toUpperCase();
  return out;
}

export class FettecBus {
  private readonly transport: FettecTransport;
  private readonly options: FettecBusOptions;

  private epoch = 0;
  private running = false;
  private loopRunning = false;
  private rx: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private chunkWaiters: (() => void)[] = [];
  private pumpPromise: Promise<void> | null = null;
  private loopPromise: Promise<void> | null = null;

  private devices: FettecDevice[] = [];
  private telemetry: FettecTelemetry[] = [];
  // Per-device raw slot values (8 slots) of the latest telemetry. A diagnostic
  // frame is fully described by its raws: marker 7357 in slot 4 (consumption),
  // problem code in slot 2 (current), auxiliary type ids in slots 5..6.
  private deviceRaw: number[][] = [];
  private tlmSlot = 0;
  // The fast-throttle/telemetry window is sized to the *present, contiguous*
  // ESC range detected during scan, exactly like the configurator
  // (`maxFT_DeviceId - minDeviceId + 1`), not the configured `count`. A 4in1 on
  // IDs 1..4 with count=8 must send 4-ESC frames and read 4*2 telemetry bytes;
  // asking for 8*2 bytes never fills and every frame times out (no RPM).
  private fastIndexStart = 0; // first device index in the fast range (0-based)
  private fastCount = 0; // number of ESCs the fast frame covers
  private reportedProblems = new Set<string>();
  /** Per-label throttle for the one-line reply-window captures. */
  private replyDebugLogged = new Map<string, number>();
  private lastTelemetryEmit = 0;
  private step: FettecStep = "idle";
  private message = "";
  private stats: FettecBusStats = { ...EMPTY_STATS };

  private statsWindowStart = 0;
  private statsFramesWindow = 0;
  private statsRepliesWindow = 0;
  private statsRxWindow = 0;
  private rxBytesTotal = 0;

  constructor(transport: FettecTransport, options: FettecBusOptions) {
    this.transport = transport;
    this.options = options;
  }

  get connected(): boolean {
    return this.running;
  }

  get currentStep(): FettecStep {
    return this.step;
  }

  get currentDevices(): FettecDevice[] {
    return this.devices;
  }

  get currentTelemetry(): FettecTelemetry[] {
    return this.telemetry;
  }

  get currentStats(): FettecBusStats {
    return this.stats;
  }

  // === Lifecycle ===

  async connect(): Promise<void> {
    const epoch = ++this.epoch;
    this.running = true;
    this.loopRunning = false;
    this.rx = new Uint8Array(0);
    this.tlmSlot = 0;
    this.fastIndexStart = 0;
    this.fastCount = 0;
    this.devices = Array.from({ length: this.options.count }, (_, index) =>
      emptyDevice(this.options.idBase + index, index),
    );
    this.telemetry = Array.from({ length: this.options.count }, (_, index) => emptyTelemetry(index));
    this.deviceRaw = Array.from({ length: this.options.count }, () => new Array<number>(8).fill(-1));
    this.reportedProblems = new Set();
    this.replyDebugLogged = new Map();
    this.stats = { ...EMPTY_STATS, state: "idle" };
    this.resetStatsWindow();

    try {
      this.setStep("cli", "Opening the FC port at 115200 baud…");
      await this.transport.open();
      if (epoch !== this.epoch) return;
      this.pumpPromise = this.pump(epoch);

      this.setStep("cli", "Sending '#' and waiting for the Betaflight CLI banner…");
      await this.transport.write(new TextEncoder().encode("#"));
      await this.waitForBanner(epoch);
      if (epoch !== this.epoch) return;

      const cliLine = this.cliLine();
      this.setStep("passthrough", `CLI: ${cliLine}`);
      await this.transport.write(new TextEncoder().encode(`${cliLine}\n`));
      await this.sleep(FETTEC_CLI_SETTLE_MS);
      if (epoch !== this.epoch) return;
      // Anything the FC printed during the transition is not protocol data.
      this.rx = new Uint8Array(0);

      this.setStep("scan", "Scanning OneWire IDs…");
      await this.scan(epoch);
      if (epoch !== this.epoch) return;

      // Size the fast-throttle frame and the telemetry reply window to the
      // ESCs that are actually on the bus, not to the configured count.
      this.prepareFastWindow();
      if (epoch !== this.epoch) return;

      this.setStep("init", "Configuring fast throttle and telemetry…");
      await this.init(epoch);
      if (epoch !== this.epoch) return;

      this.setStep("ready", `Ready — ${this.devices.filter((device) => device.present).length} ESC(s) on the bus.`);
      this.loopRunning = true;
      this.resetStatsWindow();
      this.loopPromise = this.loop(epoch);
    } catch (error) {
      if (epoch !== this.epoch) return;
      const message = error instanceof Error ? error.message : String(error);
      this.options.onLog(`FETtec connect failed: ${message}`);
      await this.shutdown(false, false, message);
      this.setStep("error", message);
      throw error;
    }
  }

  /** Stop the loop, zero the motors, optionally drop DTR and close the port. */
  async stop(reason = "Disconnected"): Promise<void> {
    await this.shutdown(true, this.options.autoReboot, reason);
  }

  /** Watchdog: stop immediately, zero the motors and surface the reason. */
  async emergencyStop(reason: string): Promise<void> {
    if (!this.running && !this.loopRunning) return;
    this.options.onEmergency(reason);
    await this.shutdown(true, this.options.autoReboot, reason);
  }

  private async shutdown(zero: boolean, reboot: boolean, reason = "Disconnected"): Promise<void> {
    this.epoch += 1;
    this.running = false;
    this.loopRunning = false;
    this.wakeWaiters();

    if (zero) await this.sendZeroFrames();

    const loop = this.loopPromise;
    this.loopPromise = null;
    if (loop) await Promise.race([loop.catch(() => {}), this.sleep(150)]);

    if (reboot) {
      try {
        await this.transport.setDtr(false);
      } catch {
        // Some VCPs do not expose DTR; the UI offers a power-cycle fallback.
      }
    }
    try {
      await this.transport.close();
    } catch {
      // Already closed.
    }
    const pump = this.pumpPromise;
    this.pumpPromise = null;
    if (pump) await Promise.race([pump.catch(() => {}), this.sleep(150)]);

    this.rx = new Uint8Array(0);
    this.step = "stopped";
    this.message = reason;
    this.options.onState("stopped", reason);
    this.emitStats(true);
  }

  private cliLine(): string {
    const override = this.options.cliLine.trim();
    if (override) return override;
    return `serialpassthrough esc_sensor ${this.options.baud} rxtx reset`;
  }

  private async waitForBanner(epoch: number): Promise<void> {
    const deadline = performance.now() + FETTEC_CLI_BANNER_TIMEOUT_MS;
    while (epoch === this.epoch && performance.now() < deadline) {
      const text = new TextDecoder().decode(this.rx);
      if (/CLI|Betaflight|Entering|^#|\r\n#/i.test(text)) {
        this.options.onLog("CLI banner received.");
        return;
      }
      await this.waitChunk(Math.min(100, deadline - performance.now()));
    }
    if (epoch === this.epoch) this.options.onLog("No CLI banner (continuing anyway).");
  }

  // === Scan / init ===

  private async scan(epoch: number): Promise<void> {
    for (let index = 0; index < this.options.count; index++) {
      if (epoch !== this.epoch) return;
      const device = this.devices[index];
      const id = device.id;

      const wake = await this.request(buildConfigFrame(id, MSG.OK), id);
      if (epoch !== this.epoch) return;
      if (!wake) {
        device.error = "No answer on the OneWire bus";
        this.options.onLog(`ID ${id}: no answer.`);
        this.emitDevices();
        continue;
      }

      device.present = true;
      device.source = wake.src === SRC_BOOTLOADER ? "bootloader" : "firmware";
      this.options.onLog(`ID ${id}: ${device.source}.`);

      if (device.source === "bootloader") {
        let started = false;
        for (let attempt = 0; attempt < FETTEC_CONFIG_RETRIES && !started; attempt++) {
          const ack = await this.request(buildConfigFrame(id, MSG.BL_START_FW), id);
          if (ack && ack.src === SRC_ESC) started = true;
          else await this.sleep(FETTEC_BOOTLOADER_SETTLE_MS);
        }
        if (!started) {
          device.error = "ESC stuck in bootloader (BL_START_FW failed)";
          this.options.onLog(`ID ${id}: ${device.error}.`);
          this.emitDevices();
          continue;
        }
        device.source = "firmware";
        await this.sleep(FETTEC_BOOTLOADER_SETTLE_MS);
      }

      // REQ_TYPE / REQ_SW_VER / REQ_SN replies have no message id: the request
      // determines the layout.
      const typeReply = await this.request(buildConfigFrame(id, MSG.REQ_TYPE), id);
      if (typeReply && typeReply.payload.length >= 1) {
        device.type = typeReply.payload[0];
        device.typeName = fettecDeviceName(device.type);
      }

      const versionReply = await this.request(buildConfigFrame(id, MSG.REQ_SW_VER), id);
      if (versionReply && versionReply.payload.length >= 2) {
        device.firmware = `${versionReply.payload[0]}.${versionReply.payload[1]}`;
      }

      const serialReply = await this.request(buildConfigFrame(id, MSG.REQ_SN), id);
      if (serialReply && serialReply.payload.length > 0) {
        device.serial = serialHex(serialReply.payload);
      }

      if (!typeReply && !versionReply && !serialReply) {
        device.error = "Device info requests timed out";
      }
      this.emitDevices();
    }

    if (this.devices.every((device) => !device.present)) {
      throw new Error(
        "No OneWire devices answered. Check the ESC signal wire and power; the FC may not be in passthrough mode.",
      );
    }
  }

  /**
   * Compute the contiguous present ESC range and store it as the fast window.
   * Mirrors the configurator's `minDeviceId` / `maxFT_DeviceId`: the fast
   * throttle frame packs `(last - first + 1)` values starting at the lowest
   * present ID, and the ESCs reply with that many ×2 telemetry bytes. Gaps
   * inside the range are filled with stop values (1000) and warned about.
   */
  private prepareFastWindow(): void {
    let first = -1;
    let last = -1;
    for (let index = 0; index < this.devices.length; index++) {
      if (!this.devices[index].present) continue;
      if (first < 0) first = index;
      last = index;
    }
    this.fastIndexStart = first < 0 ? 0 : first;
    this.fastCount = first < 0 ? 0 : last - first + 1;

    const present = this.devices.filter((device) => device.present).length;
    if (this.fastCount > present) {
      const ids = this.devices
        .filter((device) => device.present)
        .map((device) => device.id)
        .join(", ");
      this.options.onLog(
        `ID gap in the fast window (present IDs ${ids}): telemetry for gap slots is invalid — renumber the ESC IDs to a gapless run.`,
      );
    }
    if (this.fastCount < this.options.count) {
      this.options.onLog(
        `Fast window: ${this.fastCount} ESC(s) from ID ${this.options.idBase + this.fastIndexStart} (configured count ${this.options.count}).`,
      );
    }
  }

  private fastIdBase(): number {
    return this.options.idBase + this.fastIndexStart;
  }

  private async init(epoch: number): Promise<void> {
    const present = this.devices.filter((device) => device.present);
    let configured = 0;
    const fastLen = fastThrottleLen(this.fastCount);
    const fastBase = this.fastIdBase();

    for (const device of present) {
      if (epoch !== this.epoch) return;

      // The configurator never sends SET_TLM_TYPE: fast-slot mode is the
      // firmware default. We send 0 explicitly and tolerate a timeout/NOT_OK
      // so older firmware that does not know msg 27 still works.
      const tlmAck = await this.request(
        buildConfigFrame(device.id, MSG.SET_TLM_TYPE, [TLM_TYPE_FAST_SLOTS]),
        device.id,
      );
      if (!tlmAck) this.options.onLog(`ID ${device.id}: SET_TLM_TYPE not acknowledged (continuing).`);

      let ack: FettecFrame | null = null;
      for (let attempt = 0; attempt < FETTEC_CONFIG_RETRIES && !ack; attempt++) {
        ack = await this.request(
          buildConfigFrame(device.id, MSG.SET_FAST_COM_LENGTH, [fastLen, fastBase, this.fastCount]),
          device.id,
        );
      }
      if (ack) {
        configured += 1;
        device.error = null;
      } else {
        device.error = "No SET_FAST_COM_LENGTH acknowledgement";
        this.options.onLog(`ID ${device.id}: ${device.error}.`);
      }
      this.emitDevices();
    }

    if (configured === 0) {
      throw new Error("No ESC accepted the fast-throttle configuration.");
    }
  }

  /** Send a config frame and wait for a reply from `id` (clears stale RX). */
  private async request(frame: Uint8Array, id: number): Promise<FettecFrame | null> {
    this.rx = new Uint8Array(0);
    try {
      await this.transport.write(frame);
    } catch (error) {
      this.handleTransportError(error);
      return null;
    }
    const deadline = performance.now() + FETTEC_CONFIG_TIMEOUT_MS;
    while (performance.now() < deadline) {
      const { frames, leftover, crcErrors } = extractFrames(this.rx);
      this.rx = leftover;
      this.stats.crcErrors += crcErrors;
      const match = frames.find((candidate) => candidate.id === id);
      if (match) return match;
      await this.waitChunk(Math.min(50, deadline - performance.now()));
    }
    return null;
  }

  // === Cyclic fast-throttle loop ===

  private async loop(epoch: number): Promise<void> {
    let nextAt = performance.now();
    try {
      while (epoch === this.epoch && this.running && this.loopRunning) {
        const now = performance.now();
        if (now < nextAt) {
          await this.sleep(Math.min(FETTEC_LOOP_INTERVAL_MS, nextAt - now));
          continue;
        }
        nextAt += FETTEC_LOOP_INTERVAL_MS;
        if (nextAt < now - FETTEC_LOOP_INTERVAL_MS * 2) nextAt = now + FETTEC_LOOP_INTERVAL_MS;

        const raw = this.fastRawValues(now);
        const slot = this.tlmSlot;
        this.tlmSlot = (this.tlmSlot + 1) % 8;
        const packed = packFastThrottle(raw, slot);

        // Lockstep like the configurator: clear the buffer, send, wait for the
        // echo + telemetry, then schedule the next frame.
        this.rx = new Uint8Array(0);
        const writeAt = performance.now();
        await this.transport.write(packed.frame);
        if (epoch !== this.epoch || !this.loopRunning) return;
        this.stats = { ...this.stats, framesSent: this.stats.framesSent + 1 };
        this.statsFramesWindow += 1;

        const replyTimeout = this.options.replyTimeoutMs ?? FETTEC_REPLY_TIMEOUT_MS;
        const deadline = performance.now() + replyTimeout;
        // First-byte latency over the whole reply window: the one number that
        // separates "echo bytes never arrive / differ" from "arrived too late".
        let firstByteAt = 0;
        let reply = consumeFastReply(this.rx, packed.frame, this.fastCount);
        while (!reply.telemetry && performance.now() < deadline && epoch === this.epoch) {
          await this.waitChunk(Math.min(5, deadline - performance.now()));
          if (this.rx.length > 0 && firstByteAt === 0) firstByteAt = performance.now();
          reply = consumeFastReply(this.rx, packed.frame, this.fastCount);
        }

        if (reply.telemetry) {
          const window = this.rx;
          this.rx = reply.leftover;
          this.stats = {
            ...this.stats,
            replies: this.stats.replies + 1,
            echoFallbacks: this.stats.echoFallbacks + (reply.fallback ? 1 : 0),
          };
          this.statsRepliesWindow += 1;
          if (reply.fallback) this.logReplyCapture("echo-miss", packed.frame, window, writeAt, firstByteAt);
          this.applyTelemetry(reply.telemetry, slot, now);
        } else {
          this.stats = { ...this.stats, timeouts: this.stats.timeouts + 1 };
          this.logReplyCapture("timeout", packed.frame, this.rx, writeAt, firstByteAt);
          // Drop a corrupt/stale buffer so it cannot wedge the parser.
          this.rx = new Uint8Array(0);
        }

        this.maybeEmitTelemetry(now);
        this.emitStats(false);
      }
    } catch (error) {
      if (epoch === this.epoch) this.handleTransportError(error);
    } finally {
      if (epoch === this.epoch) this.loopRunning = false;
    }
  }

  private fastRawValues(nowMs: number): number[] {
    const all = this.options.getRawValues(nowMs);
    const raw = new Array<number>(this.fastCount);
    for (let slot = 0; slot < this.fastCount; slot++) {
      const device = this.devices[this.fastIndexStart + slot];
      raw[slot] = device && device.present ? (all[this.fastIndexStart + slot] ?? 1000) : 1000;
    }
    return raw;
  }

  /**
   * One-line hex + latency capture of a reply window that needed a fallback
   * or timed out. "N B rx +X ms" tells the two failure modes apart: a full
   * byte count with a late "echo-miss" means the ESC echo is not byte-
   * identical (prefix-skip recovers it); "0 B rx no data" means the FC's
   * USB VCP forwarding is slower than the reply timeout — raise it in
   * Settings.
   */
  private logReplyCapture(label: string, frame: Uint8Array, window: Uint8Array, writeAt: number, firstByteAt: number): void {
    const latency = firstByteAt > 0 ? `+${Math.round(firstByteAt - writeAt)} ms` : "no data";
    const capture = window.slice(0, 16);
    const line =
      `Fast reply ${label}: ${window.length} B rx ${latency}, ` +
      `expected echo ${serialHex(frame.subarray(0, 4))}…, got ${serialHex(capture)}${window.length > capture.length ? "…" : ""}.`;
    this.stats = { ...this.stats, rxDebug: line };
    const count = label === "timeout" ? this.stats.timeouts : this.stats.echoFallbacks;
    const seen = this.replyDebugLogged.get(label) ?? 0;
    if (seen < 3 || count % 250 === 0) {
      this.replyDebugLogged.set(label, seen + 1);
      this.options.onLog(line);
    }
  }

  private applyTelemetry(bytes: Uint8Array, slot: number, nowMs: number): void {
    const readings = decodeFastTelemetry(
      bytes,
      this.fastCount,
      slot as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
      this.options.scales,
      this.options.poles,
    );
    for (const reading of readings) {
      const deviceIndex = this.fastIndexStart + reading.escIndex;
      const entry = this.telemetry[deviceIndex];
      if (!entry) continue;
      switch (slot) {
        case 0:
          entry.tempC = reading.tempC;
          break;
        case 1:
          entry.volt = reading.volt;
          break;
        case 2:
          entry.amps = reading.amps;
          break;
        case 3:
          entry.erpm = reading.erpm;
          entry.rpm = reading.rpm;
          break;
        case 4:
          entry.mah = reading.mah;
          break;
        case 5:
        case 6:
        case 7:
          entry.debug[slot - 5] = reading.debug;
          break;
      }
      entry.lastTelemetryMs = nowMs;
      const device = this.devices[deviceIndex];
      if (device) device.lastTelemetryMs = nowMs;

      // Configurator self-diagnosis: a consumption raw of 7357 marks a problem
      // frame; the current-slot raw carries the problem code. Replace the
      // meaningless diagnostic numbers with a clear message (7357 "mah", a
      // 2000-code "20 A" and a coded voltage are not real measurements).
      const raws = this.deviceRaw[deviceIndex];
      if (raws) raws[slot] = reading.raw;
      if (device && raws) {
        const diagnostic = raws[4] === TLM_DIAGNOSTIC_MARKER;
        if (diagnostic) {
          const code = raws[2];
          if (Number.isFinite(code)) {
            const info = fettecProblemInfo(code);
            device.problem = info.message;
            device.problemCode = info.code;
          }
        } else if (device.problem !== null) {
          device.problem = null;
          device.problemCode = null;
        }
      }
    }
    this.emitProblems();
  }

  /** Surface newly-reported ESC self-diagnoses (configurator pops a warning). */
  private emitProblems(): void {
    for (const device of this.devices) {
      if (!device.present || device.problem === null) continue;
      const key = `${device.id}:${device.problemCode}`;
      if (this.reportedProblems.has(key)) continue;
      this.reportedProblems.add(key);
      this.options.onLog(`ID ${device.id}: ${device.problem}.`);
      this.emitDevices();
    }
  }

  private maybeEmitTelemetry(nowMs: number): void {
    if (nowMs - this.lastTelemetryEmit < FETTEC_TELEMETRY_PATCH_MS) return;
    this.lastTelemetryEmit = nowMs;
    this.options.onTelemetry(this.telemetry.map((entry) => ({ ...entry, debug: [...entry.debug] })));
  }

  // === Diagnostics ===

  private resetStatsWindow(): void {
    this.statsWindowStart = performance.now();
    this.statsFramesWindow = 0;
    this.statsRepliesWindow = 0;
    this.statsRxWindow = this.rxBytesTotal;
  }

  private emitStats(force: boolean): void {
    const now = performance.now();
    const elapsed = (now - this.statsWindowStart) / 1000;
    if (!force && elapsed < FETTEC_STATS_INTERVAL_MS / 1000) return;
    const loopHz = elapsed > 0 ? this.statsFramesWindow / elapsed : 0;
    const rxRate = elapsed > 0 ? Math.max(0, this.rxBytesTotal - this.statsRxWindow) / elapsed : 0;
    this.stats = {
      ...this.stats,
      state: this.step,
      loopHz: Math.round(loopHz),
      rxBytesPerSecond: Math.round(rxRate),
      message: this.message,
      updatedAt: Date.now(),
    };
    this.options.onStats({ ...this.stats });
    this.resetStatsWindow();
  }

  private setStep(step: FettecStep, message: string): void {
    this.step = step;
    this.message = message;
    this.stats = { ...this.stats, state: step, message };
    this.options.onState(step, message);
    this.options.onLog(message);
    this.emitStats(true);
  }

  private emitDevices(): void {
    this.options.onDevices(this.devices.map((device) => ({ ...device })));
  }

  // === Transport / buffering ===

  private async pump(epoch: number): Promise<void> {
    while (epoch === this.epoch && this.running) {
      let chunk: Uint8Array | null;
      try {
        chunk = await this.transport.read();
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.handleTransportError(error);
        return;
      }
      if (epoch !== this.epoch || !this.running) return;
      if (chunk === null) {
        this.handleTransportError(new Error("The FC port was closed."));
        return;
      }
      if (chunk.length === 0) continue;
      this.rxBytesTotal += chunk.length;
      this.rx = concatBytes(this.rx, chunk);
      if (this.rx.length > FETTEC_RX_MAX_BYTES) {
        this.rx = this.rx.slice(this.rx.length - FETTEC_RX_MAX_BYTES);
      }
      this.wakeWaiters();
    }
  }

  private handleTransportError(error: unknown): void {
    if (!this.running) return;
    const message = error instanceof Error ? error.message : String(error);
    this.options.onLog(`FETtec link error: ${message}`);
    void this.emergencyStop(`Link lost: ${message}`);
  }

  private wakeWaiters(): void {
    const waiters = this.chunkWaiters;
    this.chunkWaiters = [];
    for (const wake of waiters) wake();
  }

  private waitChunk(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      let timer: ReturnType<typeof setTimeout>;
      const wake = () => {
        clearTimeout(timer);
        finish();
      };
      timer = setTimeout(() => {
        this.chunkWaiters = this.chunkWaiters.filter((waiter) => waiter !== wake);
        finish();
      }, ms);
      this.chunkWaiters.push(wake);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  private async sendZeroFrames(): Promise<void> {
    const count = this.fastCount > 0 ? this.fastCount : this.options.count;
    const values = new Array<number>(count).fill(1000);
    for (let i = 0; i < FETTEC_ZERO_FRAMES; i++) {
      try {
        await this.transport.write(packFastThrottle(values, 0).frame);
      } catch {
        return;
      }
    }
  }
}

export { EMPTY_STATS };
