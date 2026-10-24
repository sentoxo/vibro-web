// Web Serial source (plan §6.6): BYOB read loop, byte parser, packet rate /
// loss / data-rate diagnostics, and automatic reconnection with a 1 s backoff.
//
// The hardware is an STM32 USB CDC device (virtual COM port), so the host link
// is USB full speed — the nominal baud rate is line coding only. Diagnostics
// therefore report the measured payload rate in KB/s, not a percentage of a
// made-up baud budget.

import {
  ACCUMULATOR_MAX_BYTES,
  BAUD_RATE,
  CALL_ALL,
  CALL_ALL_TO_STREAM_MS,
  CH340_VENDOR_ID,
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
  private firstLineSeen = false;
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
    this.userStop = true;
    this.running = false;
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
    this.userStop = false;
    this.running = true;
    this.setStatus("connecting", "Opening port…");
    try {
      await this.openPort();
    } catch (error) {
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
    if (!this.running || this.userStop) {
      await this.closePort(false);
      return;
    }
    // A manual connect starts a fresh session: every counter (including the
    // packet-loss total) begins at zero and the first sequence id is a new
    // baseline. Disconnecting and connecting again without unplugging the
    // sensor must never report the samples produced while detached as loss.
    this.seqTracker.clear();
    this.streamErrors = 0;
    this.prepareStream();
    void this.readLoop();
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
  private prepareStream(): void {
    this.firstLineSeen = false;
    this.parser.reset();
    this.rateMeter.clear(performance.now());
    this.armNoDataTimer();
    this.startStatsTimer();
    void this.writeInit();
  }

  private armNoDataTimer(): void {
    if (this.noDataTimer !== null) clearTimeout(this.noDataTimer);
    this.noDataTimer = setTimeout(() => {
      if (!this.firstLineSeen && this.running) {
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

  private async writeInit(): Promise<void> {
    // Desktop handshake: `call all` (motor query), then `start stream` after
    // ~3 s. The stream command is fire-and-forget so opening stays responsive.
    await this.writeText(CALL_ALL);
    if (this.streamTimer !== null) clearTimeout(this.streamTimer);
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      if (this.running && !this.userStop) void this.writeText(START_STREAM).catch(() => {});
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
    try {
      if (this.reader) {
        this.reader.cancel().catch(() => {});
        this.reader = null;
      }
    } catch {
      // ignore
    }
    try {
      if (this.port) await this.port.close();
    } catch {
      // Port may already be closed by the browser.
    }
  }

  private async readLoop(): Promise<void> {
    navigator.serial?.addEventListener?.("disconnect", this.onDisconnectEvent);
    try {
      while (this.running && !this.userStop) {
        // The device can vanish between attempts (or right after open). Do not
        // silently idle: fall into the reconnect loop instead.
        if (!this.port) break;
        if (!this.port.readable) {
          await this.reconnect();
          continue;
        }
        const reader = this.port.readable.getReader({ mode: "byob" });
        this.reader = reader;
        try {
          while (this.running) {
            const { value, done } = await reader.read(new Uint8Array(SERIAL_BUFFER_BYTES));
            if (done) break;
            this.parser.push(value);
            this.emitter.flush(performance.now());
          }
        } catch (error) {
          // Buffer overrun / framing / break / device-loss errors: count and
          // reconnect (a lost device rejects the pending read).
          this.streamErrors += 1;
          this.handlers.onDiagnostics({ bufferOverruns: this.streamErrors });
          this.setStatus(
            "reconnecting",
            `Serial read error: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // Reader already released.
          }
          if (this.reader === reader) this.reader = null;
        }
        if (!this.running || this.userStop) break;
        await this.reconnect();
      }
    } finally {
      navigator.serial?.removeEventListener?.("disconnect", this.onDisconnectEvent);
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
  private async reconnect(): Promise<void> {
    if (!this.getSettings().autoReconnect || !this.port) {
      this.setStatus("idle", "Sensor disconnected");
      this.running = false;
      return;
    }
    let attempt = 0;
    while (this.running && !this.userStop) {
      attempt += 1;
      const candidate = await this.findReconnectPort();
      if (candidate) this.port = candidate;
      try {
        await this.openPort();
        if (!this.running || this.userStop) {
          await this.closePort(false);
          return;
        }
        this.seqTracker.resetTracking(true);
        this.prepareStream();
        this.setStatus("connecting", "Reconnected — waiting for data…");
        return;
      } catch {
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

  private startStatsTimer(): void {
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = setInterval(() => {
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
  }

  private handleLine(line: ParsedLine): void {
    this.rateMeter.onPacket(line.bytes);
    if (!this.firstLineSeen) {
      this.firstLineSeen = true;
      if (this.noDataTimer !== null) clearTimeout(this.noDataTimer);
      this.setStatus("streaming", "Streaming");
    }
    if (line.sid !== 0) return; // only sensor 0 is buffered (desktop parity)

    const { lost } = this.seqTracker.onSeq(line.seq);
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
