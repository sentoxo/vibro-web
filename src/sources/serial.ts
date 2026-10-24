// Web Serial source (plan §6.6): BYOB read loop, byte parser, packet rate /
// loss / wire diagnostics, auto-reconnect with 1 s backoff.

import {
  ACCUMULATOR_MAX_BYTES,
  BAUD_RATE,
  CALL_ALL,
  CALL_ALL_TO_STREAM_MS,
  CH340_VENDOR_ID,
  NO_DATA_TIMEOUT_MS,
  PACKET_STATS_INTERVAL_MS,
  RECONNECT_GIVEUP_MS,
  RECONNECT_INTERVAL_MS,
  SERIAL_BUFFER_BYTES,
  START_STREAM,
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
  isCh340: boolean;
}

export function describePort(port: SerialPort): PortSummary {
  const info = port.getInfo?.() ?? {};
  const ids = formatUsbIds(info.usbVendorId, info.usbProductId);
  const isCh340 = info.usbVendorId === CH340_VENDOR_ID;
  const label = ids ? `${isCh340 ? "CH340" : "Serial"} (${ids})` : "Serial device";
  return { port, label, ids, isCh340 };
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
  private reconnectDeadline = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private readonly parser: LineParser;
  private readonly seqTracker = new SeqTracker();
  private rateMeter: RateMeter;
  private emitter: BatchEmitter;
  private streamErrors = 0;
  private readonly onDisconnectEvent = (event: Event) => {
    const port = (event as Event & { port?: SerialPort }).port;
    if (port === this.port && this.running) {
      this.setStatus("reconnecting", "Sensor disconnected. Reconnecting…");
    }
  };

  constructor(handlers: SerialSourceHandlers, getSettings: () => Settings) {
    this.handlers = handlers;
    this.getSettings = getSettings;
    this.rateMeter = new RateMeter(BAUD_RATE, performance.now());
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
      await this.port.open({
        baudRate: BAUD_RATE,
        bufferSize: SERIAL_BUFFER_BYTES,
      });
      this.firstLineSeen = false;
      this.parser.reset();
      this.seqTracker.resetTracking(true);
      this.rateMeter.clear(performance.now());
      await this.writeInit();
      this.startStatsTimer();
      this.noDataTimer = setTimeout(() => {
        if (!this.firstLineSeen) {
          this.setStatus("connecting", "No data — check the device and that it is not open in another app.");
        }
      }, NO_DATA_TIMEOUT_MS);
      void this.readLoop();
    } catch (error) {
      // Port busy / permission denied.
      this.handlers.onDiagnostics({});
      this.setStatus(
        "error",
        `Cannot open port: ${error instanceof Error ? error.message : String(error)}. ` +
          "Close other apps using the device (e.g. the Python app) and check serial permissions.",
      );
      this.running = false;
      await this.closePort(false);
    }
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
    while (this.port?.readable && this.running) {
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
        // Buffer overrun / framing / break errors: count, toast, reconnect.
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
      if (!this.running || this.userStop) break;
      await this.reconnect();
    }
    navigator.serial?.removeEventListener?.("disconnect", this.onDisconnectEvent);
  }

  private async reconnect(): Promise<void> {
    if (!this.getSettings().autoReconnect || !this.port) {
      this.setStatus("idle", "Sensor disconnected");
      this.running = false;
      return;
    }
    this.reconnectDeadline = performance.now() + RECONNECT_GIVEUP_MS;
    this.setStatus("reconnecting", "Sensor disconnected. Reconnecting…");
    await new Promise<void>((resolve) => {
      const attempt = async () => {
        if (!this.running || this.userStop) return resolve();
        try {
          await this.port!.open({
            baudRate: BAUD_RATE,
            bufferSize: SERIAL_BUFFER_BYTES,
          });
          this.firstLineSeen = false;
          this.parser.reset();
          // Reconnect resets seq tracking (no fake loss spike); session
          // totals are kept (plan §6.6).
          this.seqTracker.resetTracking(true);
          this.rateMeter.clear(performance.now());
          await this.writeInit();
          resolve();
        } catch {
          if (performance.now() >= this.reconnectDeadline) {
            this.setStatus("error", "Sensor not available — click Reconnect.");
            this.running = false;
            resolve();
          } else {
            this.reconnectTimer = setTimeout(attempt, RECONNECT_INTERVAL_MS);
          }
        }
      };
      this.reconnectTimer = setTimeout(attempt, RECONNECT_INTERVAL_MS);
    });
  }

  private startStatsTimer(): void {
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = setInterval(() => {
      const stats = this.rateMeter.tick(performance.now());
      this.handlers.onDiagnostics({
        packetRate: Math.round(stats.packetRate),
        measuredHz: Math.round(stats.packetRate),
        wireUtilization: stats.wireUtilization,
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
