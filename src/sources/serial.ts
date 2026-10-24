// Web Serial source (plan §6.6): BYOB read loop, byte parser, packet rate /
// loss / data-rate diagnostics, and automatic reconnection with a 1 s backoff.
//
// The hardware is an STM32 USB CDC device (virtual COM port), so the host link
// is USB full speed — the nominal baud rate is line coding only. Diagnostics
// therefore report the measured payload rate in KB/s, not a percentage of a
// made-up baud budget.
//
// Session isolation: every connect starts a new session (monotonic `epoch`).
// Read loops, parsers, handshake timers and statistics timers are bound to the
// epoch they were created for, and a manual connect clears all counters. A late
// chunk or timer from a previous session can therefore never feed the current
// one (that used to produce phantom sequence-loss warnings after a reconnect).

import {
  ACCUMULATOR_MAX_BYTES,
  BAUD_RATE,
  CALL_ALL,
  CALL_ALL_TO_STREAM_MS,
  CH340_VENDOR_ID,
  LOSS_SETTLE_MS,
  NO_DATA_TIMEOUT_MS,
  PACKET_STATS_INTERVAL_MS,
  RECONNECT_INTERVAL_MS,
  SERIAL_BUFFER_BYTES,
  START_STREAM,
  STM32_VENDOR_ID,
  STOP_STREAM,
} from "../core/constants";
import { LineParser, type ParsedLine } from "../core/parser";
import { RateMeter, SeqTracker } from "../core/rate-meter";
import type { Diagnostics, Settings, SourceStatus } from "../core/types";
import { formatUsbIds, ms2PerLsb } from "../core/units";
import { BatchEmitter, type SourceHandlers } from "./source";

export function serialSupported(): boolean {
  // Feature-detect the actual API surface: some browsers expose a placeholder
  // `serial` property without a usable implementation.
  return (
    typeof navigator !== "undefined" &&
    typeof (navigator as unknown as { serial?: { requestPort?: unknown } }).serial?.requestPort === "function"
  );
}

export interface SerialSourceHandlers extends SourceHandlers {
  onDiagnostics(patch: Partial<Diagnostics>): void;
  onFirstPacketLoss(): void;
}

export interface PortSummary {
  port: SerialPort;
  label: string;
  ids: string;
}

export function describePort(port: SerialPort): PortSummary {
  const info = port.getInfo?.() ?? {};
  const ids = formatUsbIds(info.usbVendorId, info.usbProductId);
  const kind =
    info.usbVendorId === STM32_VENDOR_ID ? "STM32 VCP" : info.usbVendorId === CH340_VENDOR_ID ? "CH340" : "Serial";
  const label = ids ? `${kind} (${ids})` : "Serial device";
  return { port, label, ids };
}

export async function getGrantedPorts(): Promise<PortSummary[]> {
  if (!serialSupported()) return [];
  const ports = await navigator.serial.getPorts();
  return ports.map(describePort);
}

export async function requestNewPort(filters?: SerialPortRequestOptions["filters"]): Promise<SerialPort> {
  // Must be called from a user gesture (plan §3.1).
  const options: SerialPortRequestOptions = filters ? { filters } : {};
  return navigator.serial.requestPort(options);
}

export class SerialSource {
  readonly kind = "serial" as const;
  private readonly handlers: SerialSourceHandlers;
  private readonly getSettings: () => Settings;
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader | null = null;
  private running = false;
  private userStop = true;
  /**
   * Session generation. Incremented by every connect attempt and by stop();
   * anything bound to an older value is stale and must not touch state.
   */
  private epoch = 0;
  private firstLineSeen = false;
  /** Until this timestamp, sequence gaps start a new baseline instead of
   * counting as loss (USB CDC backlog drain right after (re)connecting). */
  private settleUntil = 0;
  private noDataTimer: ReturnType<typeof setTimeout> | null = null;
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectWaiter: (() => void) | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private readonly parser: LineParser;
  private readonly seqTracker = new SeqTracker();
  private readonly knownOtherPorts = new Set<SerialPort>();
  private rateMeter: RateMeter;
  private emitter: BatchEmitter;
  private streamErrors = 0;
  private readonly onDisconnectEvent = (event: Event) => {
    const port = (event as Event & { port?: SerialPort }).port;
    if (port === this.port && this.running) {
      this.setStatus("reconnecting", "Sensor disconnected. Reconnecting…");
      // Chrome may leave a pending read hanging after a device loss. Cancel it
      // so the read loop falls through to the reconnect loop immediately.
      void this.reader?.cancel().catch(() => {});
    }
  };

  constructor(handlers: SerialSourceHandlers, getSettings: () => Settings) {
    this.handlers = handlers;
    this.getSettings = getSettings;
    this.rateMeter = new RateMeter(performance.now());
    this.emitter = new BatchEmitter(512, handlers);
    this.parser = new LineParser(
      {
        onLine: (line) => this.handleLine(line),
        onMalformed: () =>
          this.handlers.onDiagnostics({
            malformedLines: this.parser.malformedLines,
            lastMalformed: this.parser.lastMalformed,
          }),
        onOverflow: () => this.handlers.onDiagnostics({ bufferOverruns: ++this.streamErrors }),
      },
      ACCUMULATOR_MAX_BYTES,
    );
  }

  get grantedPort(): SerialPort | null {
    return this.port;
  }

  usePort(port: SerialPort): void {
    this.port = port;
    void this.rememberOtherPorts();
    void this.openAndStream();
  }

  async start(): Promise<void> {
    if (!this.port) throw new Error("No granted serial port to open");
    await this.openAndStream();
  }

  async stop(): Promise<void> {
    // Invalidate the active session first: a pending read, handshake timer or
    // stats tick from now on is stale and must be ignored.
    this.epoch += 1;
    this.userStop = true;
    this.running = false;
    navigator.serial?.removeEventListener?.("disconnect", this.onDisconnectEvent);
    this.clearTimers();
    await this.closePort(true);
    this.setStatus("idle", "Disconnected");
  }

  async forgetPort(): Promise<void> {
    if (this.port) await this.port.forget();
  }

  private clearTimers(): void {
    if (this.noDataTimer !== null) clearTimeout(this.noDataTimer);
    if (this.streamTimer !== null) clearTimeout(this.streamTimer);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.noDataTimer = null;
    this.streamTimer = null;
    this.reconnectTimer = null;
    this.statsTimer = null;
    // Wake a reconnect loop that is sleeping between attempts, so `stop()`
    // never leaves a dangling promise (or a second read loop on reconnect).
    const waiter = this.reconnectWaiter;
    this.reconnectWaiter = null;
    waiter?.();
  }

  private setStatus(state: SourceStatus["state"], message: string): void {
    const label = this.port ? describePort(this.port).label : "Sensor";
    this.handlers.onStatus({ state, deviceLabel: label, message });
  }

  private async openAndStream(): Promise<void> {
    if (!this.port) return;
    const epoch = ++this.epoch;
    this.userStop = false;
    this.running = true;
    // Registered once per source (addEventListener dedupes the same function);
    // `stop()` removes it. Per-loop registration would let a finishing loop
    // remove the listener that the new session depends on.
    navigator.serial?.addEventListener?.("disconnect", this.onDisconnectEvent);
    this.setStatus("connecting", "Opening port…");
    try {
      await this.openPort();
    } catch (error) {
      if (epoch !== this.epoch) return; // superseded by stop()/another connect
      // Port busy / permission denied.
      this.setStatus(
        "error",
        `Cannot open port: ${error instanceof Error ? error.message : String(error)}. ` +
          "Close other apps using the device (e.g. the Python app) and check serial permissions.",
      );
      this.running = false;
      await this.closePort(false);
      return;
    }
    if (epoch !== this.epoch) {
      // Superseded: stop() won the race. Close what we just opened, but never
      // touch a newer session's port (userStop is false in that case).
      if (this.userStop) await this.closePort(false);
      return;
    }
    if (!this.running || this.userStop) {
      await this.closePort(false);
      return;
    }
    // A manual connect starts a completely fresh session: every counter
    // (including the packet-loss total) begins at zero and the first sequence
    // id is a new baseline. Disconnecting and connecting again without
    // unplugging the sensor must never report the samples produced while
    // detached as loss, and must never show the lost-packet warning.
    this.seqTracker.clear();
    this.streamErrors = 0;
    this.prepareSession(epoch);
    void this.readLoop(epoch);
  }

  private async openPort(): Promise<void> {
    const port = this.port;
    if (!port) throw new Error("No granted serial port to open");
    // A lost device can leave a half-open handle; close before opening so
    // `open()` does not fail with "The port is already open".
    if (port.readable || port.writable) {
      try {
        await port.close();
      } catch {
        // Already closed by the browser.
      }
    }
    await port.open({ baudRate: BAUD_RATE, bufferSize: SERIAL_BUFFER_BYTES });
  }

  /** Reset per-connection parser/rate state and start the handshake timers. */
  private prepareSession(epoch: number): void {
    this.firstLineSeen = false;
    this.settleUntil = 0;
    // Samples buffered from the previous session must not leak into this one.
    this.emitter.count = 0;
    this.parser.reset();
    this.rateMeter.clear(performance.now());
    this.armNoDataTimer(epoch);
    this.startStatsTimer(epoch);
    void this.writeInit(epoch);
  }

  private armNoDataTimer(epoch: number): void {
    if (this.noDataTimer !== null) clearTimeout(this.noDataTimer);
    this.noDataTimer = setTimeout(() => {
      this.noDataTimer = null;
      if (epoch === this.epoch && !this.firstLineSeen && this.running) {
        this.setStatus("connecting", "No data — check the device and that it is not open in another app.");
      }
    }, NO_DATA_TIMEOUT_MS);
  }

  private async writeText(text: string): Promise<void> {
    if (!this.port?.writable) return;
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(text));
    } finally {
      writer.releaseLock();
    }
  }

  private async writeInit(epoch: number): Promise<void> {
    // Desktop handshake: `call all` (motor query), then `start stream` after
    // ~3 s. The stream command is fire-and-forget so opening stays responsive.
    await this.writeText(CALL_ALL);
    if (epoch !== this.epoch) return;
    if (this.streamTimer !== null) clearTimeout(this.streamTimer);
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      if (epoch === this.epoch && this.running && !this.userStop) void this.writeText(START_STREAM).catch(() => {});
    }, CALL_ALL_TO_STREAM_MS);
  }

  private async writeStop(): Promise<void> {
    // Best effort; never awaited forever (plan §6.6).
    if (!this.port?.writable) return;
    try {
      await Promise.race([this.writeText(STOP_STREAM), new Promise((resolve) => setTimeout(resolve, 500))]).catch(
        () => {},
      );
    } catch {
      // Device already gone; ignore.
    }
  }

  private async closePort(sendStop: boolean): Promise<void> {
    if (sendStop) await this.writeStop();
    const reader = this.reader;
    this.reader = null;
    if (reader) {
      // Wait for the pending read to unwind so the port can actually close
      // (Chrome refuses to close a port whose readable is still locked).
      try {
        await Promise.race([reader.cancel(), new Promise((resolve) => setTimeout(resolve, 250))]);
      } catch {
        // Read already failed (device loss).
      }
    }
    try {
      if (this.port) await this.port.close();
    } catch {
      // Port may already be closed by the browser.
    }
  }

  private async readLoop(epoch: number): Promise<void> {
    while (epoch === this.epoch && this.running && !this.userStop) {
      // The device can vanish between attempts (or right after open). Do not
      // silently idle: fall into the reconnect loop instead.
      if (!this.port) break;
      if (!this.port.readable) {
        await this.reconnect(epoch);
        return;
      }
      const reader = this.port.readable.getReader({ mode: "byob" });
      this.reader = reader;
      try {
        while (epoch === this.epoch && this.running) {
          const { value, done } = await reader.read(new Uint8Array(SERIAL_BUFFER_BYTES));
          if (done) break;
          // A chunk delivered after the session ended belongs to the old
          // session; drop it instead of feeding it to the new one.
          if (epoch !== this.epoch) return;
          this.parser.push(value);
          this.emitter.flush(performance.now());
        }
      } catch (error) {
        if (epoch !== this.epoch) return;
        // Buffer overrun / framing / break / device-loss errors: count and
        // reconnect (a lost device rejects the pending read).
        this.streamErrors += 1;
        this.handlers.onDiagnostics({ bufferOverruns: this.streamErrors });
        this.setStatus("reconnecting", `Serial read error: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Reader already released.
        }
        if (this.reader === reader) this.reader = null;
      }
      if (epoch !== this.epoch || !this.running || this.userStop) break;
      await this.reconnect(epoch);
      return;
    }
  }

  /**
   * Find a usable handle for the sensor. After an unplug/replug Chrome creates
   * a new SerialPort object, so retrying the stale one can fail forever; ask
   * `getPorts()` for the current handle and match the USB identity.
   */
  private async findReconnectPort(): Promise<SerialPort | null> {
    const previous = this.port;
    if (!navigator.serial?.getPorts) return previous;
    try {
      const ports = await navigator.serial.getPorts();
      if (ports.length === 0) return previous;
      const info = previous?.getInfo?.() ?? {};
      const matches = ports.filter((port) => {
        const candidate = port.getInfo?.() ?? {};
        return candidate.usbVendorId === info.usbVendorId && candidate.usbProductId === info.usbProductId;
      });
      // Identical USB identities are common (an STM32 sensor and an STM32 FC).
      // Never steal another granted port (e.g. the ESC link), and prefer a
      // freshly-created handle over the stale one from before the replug.
      const candidates = matches.filter((port) => !this.knownOtherPorts.has(port) && !port.readable && !port.writable);
      const fresh = candidates.find((port) => port !== previous);
      if (fresh) return fresh;
      if (candidates.length > 0) return candidates[0];
      if (previous && matches.includes(previous)) return previous;
      if (matches.length > 0) return matches[0];
      return ports.length === 1 ? ports[0] : previous;
    } catch {
      return previous;
    }
  }

  /** Remember other granted ports (the FC link) so reconnection never grabs them. */
  private async rememberOtherPorts(): Promise<void> {
    try {
      const ports = await navigator.serial.getPorts();
      for (const port of ports) {
        if (port !== this.port) this.knownOtherPorts.add(port);
      }
    } catch {
      // Permission list unavailable; identity matching still applies.
    }
  }

  /**
   * Automatic reconnect: keep trying once a second for as long as the user has
   * not disconnected (the desktop worker retries until stopped too). Session
   * totals are kept, but the first packet after the outage is a new baseline so
   * data produced while detached is never counted as lost.
   */
  private async reconnect(epoch: number): Promise<void> {
    if (epoch !== this.epoch) return;
    if (!this.getSettings().autoReconnect || !this.port) {
      this.setStatus("idle", "Sensor disconnected");
      this.running = false;
      return;
    }
    let attempt = 0;
    while (epoch === this.epoch && this.running && !this.userStop) {
      attempt += 1;
      const candidate = await this.findReconnectPort();
      if (epoch !== this.epoch) return;
      if (candidate) this.port = candidate;
      try {
        await this.openPort();
        if (epoch !== this.epoch) {
          if (this.userStop) await this.closePort(false);
          return;
        }
        if (!this.running || this.userStop) {
          await this.closePort(false);
          return;
        }
        // Same stream, new link: keep loss totals, but re-baseline the sequence
        // so the outage gap is not reported as loss.
        this.seqTracker.resetTracking(true);
        const next = ++this.epoch;
        this.prepareSession(next);
        this.setStatus("connecting", "Reconnected — waiting for data…");
        void this.readLoop(next);
        return;
      } catch {
        if (epoch !== this.epoch) return;
        this.setStatus(
          "reconnecting",
          attempt === 1 ? "Sensor disconnected. Reconnecting…" : `Waiting for sensor… (attempt ${attempt})`,
        );
        await this.waitForRetry(RECONNECT_INTERVAL_MS);
      }
    }
  }

  /** Sleep between reconnect attempts; `stop()` resolves it immediately. */
  private waitForRetry(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.reconnectWaiter = resolve;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectWaiter = null;
        resolve();
      }, ms);
    });
  }

  private startStatsTimer(epoch: number): void {
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    const timer = setInterval(() => {
      // A timer from a closed session must never patch the current diagnostics
      // (it could resurrect an old lost-packet count after a reconnect).
      if (epoch !== this.epoch) {
        clearInterval(timer);
        return;
      }
      const stats = this.rateMeter.tick(performance.now());
      this.handlers.onDiagnostics({
        packetRate: Math.round(stats.packetRate),
        measuredHz: Math.round(stats.packetRate),
        wireBytesPerSecond: stats.bytesPerSecond,
        avgLineBytes: stats.avgLineBytes,
        lostPackets: this.seqTracker.lostPackets,
        seqResets: this.seqTracker.seqResets,
      });
    }, PACKET_STATS_INTERVAL_MS);
    this.statsTimer = timer;
  }

  private handleLine(line: ParsedLine): void {
    this.rateMeter.onPacket(line.bytes);
    if (!this.firstLineSeen) {
      this.firstLineSeen = true;
      // A freshly opened (or reopened) USB CDC link may still be draining its
      // backlog and dropping samples while the host catches up. Gaps observed
      // during this settling window belong to session startup, not loss.
      this.settleUntil = performance.now() + LOSS_SETTLE_MS;
      if (this.noDataTimer !== null) {
        clearTimeout(this.noDataTimer);
        this.noDataTimer = null;
      }
      this.setStatus("streaming", "Streaming");
    }
    if (line.sid !== 0) return; // only sensor 0 is buffered (desktop parity)

    const { lost } = this.seqTracker.onSeq(line.seq, performance.now() >= this.settleUntil);
    if (lost > 0) {
      this.handlers.onDiagnostics({ lostPackets: this.seqTracker.lostPackets });
      this.handlers.onFirstPacketLoss();
    }

    const factor = ms2PerLsb(this.getSettings().lsbPerG);
    this.emitter.add(line.x * factor, line.y * factor, line.z * factor, line.seq);
    if (this.emitter.count >= this.emitter.x.length) {
      this.emitter.flush(performance.now());
    }
  }
}
