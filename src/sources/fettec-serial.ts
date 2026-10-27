// Web Serial adapter for the FETtec bus. The host side of the Betaflight VCP
// is opened at 115200 (line coding only); the ESC bus baud (2 Mbit by default)
// is set by the CLI `serialpassthrough` command.
//
// One persistent writer is acquired on open: the MSP panel's
// getWriter-per-write pattern can drop a command when a telemetry poll holds
// the lock, which is fatal for the FETtec 100 Hz throttle stream.

import { FETTEC_CLI_BAUD, SERIAL_BUFFER_BYTES } from "../core/constants";
import type { FettecTransport } from "../core/fettec/bus";
import { describePort } from "./serial";

export class SerialFettecTransport implements FettecTransport {
  private readonly port: SerialPort;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  constructor(port: SerialPort) {
    this.port = port;
  }

  get label(): string {
    return describePort(this.port).label;
  }

  async open(): Promise<void> {
    // A lost device can leave a half-open handle; close before opening so
    // `open()` does not fail with "The port is already open".
    if (this.port.readable || this.port.writable) {
      try {
        await this.port.close();
      } catch {
        // Already closed by the browser.
      }
    }
    await this.port.open({ baudRate: FETTEC_CLI_BAUD, bufferSize: SERIAL_BUFFER_BYTES });
    if (!this.port.writable || !this.port.readable) throw new Error("FC port opened without readable/writable streams");
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("FC port is not open");
    await this.writer.write(bytes);
  }

  async read(): Promise<Uint8Array | null> {
    const reader = this.reader;
    if (!reader) return null;
    const { value, done } = await reader.read();
    if (done) return null;
    return value ?? null;
  }

  async setDtr(value: boolean): Promise<void> {
    // Betaflight only leaves passthrough after a reboot, which the `reset`
    // argument triggers when DTR drops. Some VCPs reject setSignals.
    await this.port.setSignals?.({ dataTerminalReady: value });
  }

  async close(): Promise<void> {
    const reader = this.reader;
    this.reader = null;
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // Read already failed (device loss).
      }
      try {
        reader.releaseLock();
      } catch {
        // Already released.
      }
    }
    const writer = this.writer;
    this.writer = null;
    if (writer) {
      try {
        writer.releaseLock();
      } catch {
        // Already released.
      }
    }
    try {
      await this.port.close();
    } catch {
      // Port may already be closed by the browser.
    }
  }
}
