// Fake Web Serial implementation injected with page.addInitScript().
// First requestPort() returns the sensor port (streams S-lines once
// `start stream` arrives), second returns the FC port (answers MSP
// telemetry requests). All writes are captured for assertions.
//
// The sensor fake emulates an STM32 USB CDC port: it can be closed/reopened
// (manual reconnect) and a device-loss can be injected (auto-reconnect).

export interface FakeSerialState {
  sensor: FakePortInfo | null;
  fc: FakePortInfo | null;
  fettec: FakePortInfo | null;
  seq: number;
  pumpStarted: boolean;
}

export interface FakePortInfo {
  writes: number[][];
  writeTexts(): string[];
  openCount: number;
}

declare global {
  interface Window {
    __fakeSerial?: FakeSerialState & {
      enqueueSensor(text: string): void;
      lastWrites(port: "sensor" | "fc" | "fettec"): number[][];
      simulateSensorLoss(): void;
      setNextPort(kind: "sensor" | "fc" | "fettec"): void;
      fettecFrames(limit?: number): { values: number[]; slot: number }[];
      fettecSignals(): { dataTerminalReady?: boolean }[];
    };
  }
}

export function installFakeSerial(opts?: { simulateLoss?: boolean }): void {
  const simulateLoss = opts?.simulateLoss ?? true;
  const enc = new TextEncoder();
  // A reopened CDC link resumes with the stream already in flight: emulate the
  // backlog drain dropping a few samples shortly after the first reopened chunk
  // (this is what produced a phantom loss warning on real hardware).
  let pendingReopenGap = 0;

  class FakePort {
    readable: ReadableStream<Uint8Array> | null = null;
    writable: WritableStream<Uint8Array> | null = null;
    writes: number[][] = [];
    signalsLog: { dataTerminalReady?: boolean }[] = [];
    openCount = 0;
    private opened = false;
    // BYOB (bytes) stream: chunks enqueued are Uint8Arrays, read via BYOB reader.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private ctrl: { enqueue(chunk: any): void; error(reason?: unknown): void } | null = null;
    readonly byteStream: boolean;
    readonly onWrite: (chunk: Uint8Array) => void;

    constructor(onWrite: (chunk: Uint8Array) => void, byteStream = false) {
      this.onWrite = onWrite;
      this.byteStream = byteStream;
    }

    private makeStreams(): void {
      this.readable = this.byteStream
        ? // The sensor link reads BYOB mode: a bytes stream fed with Uint8Arrays.
          new ReadableStream<Uint8Array>({
            type: "bytes",
            start: (controller) => {
              this.ctrl = controller as unknown as {
                enqueue(chunk: unknown): void;
                error(reason?: unknown): void;
              };
            },
          })
        : // The FC panel reads default-mode: plain Uint8Array chunks.
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              this.ctrl = controller;
            },
          });
      this.writable = new WritableStream<Uint8Array>({
        write: (chunk: Uint8Array) => {
          this.writes.push(Array.from(chunk));
          this.onWrite(chunk);
        },
      });
    }

    async open(): Promise<void> {
      if (this.opened) throw new DOMException("The port is already open.", "InvalidStateError");
      this.openCount += 1;
      if (this.byteStream && this.openCount > 1) pendingReopenGap = 2;
      this.opened = true;
      this.makeStreams();
    }

    async close(): Promise<void> {
      this.opened = false;
      this.ctrl = null;
      this.readable = null;
      this.writable = null;
    }

    async setSignals(signals: { dataTerminalReady?: boolean }): Promise<void> {
      this.signalsLog.push({ ...signals });
    }

    /** Emulate the cable being yanked: the pending read fails. */
    loseDevice(): void {
      this.opened = false;
      const controller = this.ctrl;
      this.ctrl = null;
      this.readable = null;
      this.writable = null;
      try {
        controller?.error(new DOMException("The device has been lost.", "NetworkError"));
      } catch {
        // Stream already closed.
      }
    }

    getInfo() {
      // STM32 Virtual ComPort (matches the real sensor).
      return { usbVendorId: 0x0483, usbProductId: 0x5740 };
    }

    enqueue(bytes: Uint8Array): void {
      if (!this.opened || !this.ctrl) return;
      // Chrome's byte-stream controller requires ArrayBufferView chunks.
      this.ctrl.enqueue(bytes);
    }

    writeTexts(): string[] {
      return this.writes.map((bytes) => new TextDecoder().decode(Uint8Array.from(bytes)));
    }
  }

  const state: FakeSerialState = { sensor: null, fc: null, fettec: null, seq: 0, pumpStarted: false };
  const fastFrames: { values: number[]; slot: number }[] = [];
  let nextPort: "sensor" | "fc" | "fettec" | null = null;
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const dispatch = (type: string, port: FakePort) => {
    const event = { type, port, target: fakeSerialApi } as unknown as Event;
    for (const listener of listeners.get(type) ?? []) listener(event);
  };

  const sensorWrite = (chunk: Uint8Array) => {
    const text = new TextDecoder().decode(chunk);
    if (text.includes("start stream") && !state.pumpStarted) {
      state.pumpStarted = true;
      // 400 lines/s, one deliberate 3-packet gap at seq 900 (2.25 s in, i.e.
      // past the post-connect settling window).
      setInterval(() => {
        const port = state.sensor as FakePort | null;
        if (!port) return;
        if (pendingReopenGap > 0) {
          pendingReopenGap -= 1;
          // Let the first chunk after reopen establish the baseline, then drop
          // samples on the following chunk (backlog drained mid-stream).
          if (pendingReopenGap === 0) state.seq += 7;
        }
        let out = "";
        for (let i = 0; i < 20; i++) {
          state.seq += 1;
          if (simulateLoss && state.seq === 900) state.seq += 3;
          const t = state.seq / 800;
          const x = Math.round(2048 * Math.sin(2 * Math.PI * 48 * t));
          const y = Math.round(1024 * Math.sin(2 * Math.PI * 120 * t));
          out += `S0,${state.seq},${x},${y},512\n`;
        }
        port.enqueue(enc.encode(out));
      }, 50);
    }
  };

  const fcWrite = (chunk: Uint8Array) => {
    const b = Array.from(chunk);
    const isRequest = (command: number) =>
      b.length === 6 && b[0] === 0x24 && b[1] === 0x4d && b[2] === 0x3c && b[3] === 0 && b[4] === command;
    // `$M< 00 8B 8B` telemetry request → $M> response with 4 motors.
    if (isRequest(0x8b)) {
      const payload = new Uint8Array(1 + 4 * 13);
      payload[0] = 4;
      const view = new DataView(payload.buffer);
      view.setUint32(1, 123456, true);
      view.setUint32(1 + 13, 234567, true);
      view.setUint32(1 + 26, 0, true);
      view.setUint32(1 + 39, 345678, true);
      const resp = [0x24, 0x4d, 0x3e, payload.length, 0x8b, ...payload];
      let xors = 0;
      for (let i = 3; i < resp.length; i++) xors ^= resp[i] & 0xff;
      resp.push(xors);
      (state.fc as FakePort).enqueue(Uint8Array.from(resp));
    } else if (isRequest(0x6e)) {
      // MSP_ANALOG: 16.8 V, 500 mAh, RSSI 80, 21.5 A — the FETtec cross-check
      // compares these against the ESC fast telemetry (16.80 V / 21.5 A).
      const payload = [168, 0xf4, 0x01, 80, 0x66, 0x08];
      const resp = [0x24, 0x4d, 0x3e, payload.length, 0x6e, ...payload];
      let xors = 0;
      for (let i = 3; i < resp.length; i++) xors ^= resp[i] & 0xff;
      resp.push(xors);
      (state.fc as FakePort).enqueue(Uint8Array.from(resp));
    }
  };

  const crc8 = (bytes: ArrayLike<number>): number => {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] & 0xff;
      for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
    return crc;
  };

  /** ESC reply frame (source 0x03) with a valid CRC-8/0x07. */
  const escReply = (id: number, body: number[]): Uint8Array => {
    const frame = [0x03, id, 0, 0, 6 + body.length, ...body];
    frame.push(crc8(frame));
    return Uint8Array.from(frame);
  };

  const u16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];

  const readBits = (frame: Uint8Array, bitOffset: number, count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const bit = bitOffset + i;
      value = (value << 1) | ((frame[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    return value;
  };

  const unpackFast = (frame: Uint8Array): { values: number[]; slot: number } => {
    const n = Math.floor((8 * (frame.length - 1) - 12) / 11);
    const slot = (frame[0] >> 4) & 0x07;
    const v0 = (((frame[0] >> 3) & 1) << 10) | (((frame[1] >> 5) & 0x07) << 7) | ((frame[2] >> 1) & 0x7f);
    const values = [v0];
    for (let i = 1; i < n; i++) values.push(readBits(frame, 23 + (i - 1) * 11, 11));
    return { values, slot };
  };

  /** Fast telemetry model: every ESC follows the bus throttle except index 4,
   * which answers but ignores it (the "FC pin signal" case). */
  const tlmRaw = (index: number, slot: number, throttle: number): number => {
    const ignored = index === 4;
    const spinning = !ignored && throttle > 1009;
    switch (slot) {
      case 0:
        return 30 + index; // °C
      case 1:
        return 1680; // 16.80 V
      case 2:
        return ignored ? 50 : spinning ? (throttle - 1000) * 3 : 0; // 0.01 A
      case 3:
        return spinning ? (throttle - 1000) * 100 : 0; // centi-eRPM
      case 4:
        return 100 + index; // mAh
      default:
        return 0;
    }
  };

  const handleConfig = (port: FakePort, chunk: Uint8Array): void => {
    const id = chunk[1];
    const msg = chunk[5];
    if (id < 1 || id > 8) return;
    let body: number[];
    switch (msg) {
      case 5: // REQ_TYPE
        body = [id % 2 === 0 ? 4 : 1];
        break;
      case 6: // REQ_SN — 12 bytes, no message id in the reply
        body = [0xab, id, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, id];
        break;
      case 7: // REQ_SW_VER
        body = [1, 2];
        break;
      default: // OK / BL_START_FW / SET_TLM_TYPE / SET_FAST_COM_LENGTH ack
        body = [0];
        break;
    }
    port.enqueue(escReply(id, body));
  };

  const fettecWrite = (chunk: Uint8Array) => {
    const port = state.fettec as FakePort | null;
    if (!port) return;
    // CLI banner for the initial '#'. The CLI line itself is swallowed by the
    // real FC (passthrough takes over) and the bus clears RX after settling.
    if (chunk.length <= 2 && chunk[0] === 0x23) {
      port.enqueue(enc.encode("\r\n# "));
      return;
    }
    const text = new TextDecoder().decode(chunk);
    if (text.includes("serialpassthrough")) return;

    if (chunk[0] === 0x01 && chunk.length >= 7 && chunk[4] === chunk.length) {
      handleConfig(port, chunk);
      return;
    }
    if ((chunk[0] & 0x80) !== 0 && chunk.length >= 4) {
      const { values, slot } = unpackFast(chunk);
      fastFrames.push({ values: [...values], slot });
      const telemetry: number[] = [];
      for (let index = 0; index < values.length; index++) {
        telemetry.push(...u16(tlmRaw(index, slot, values[index])));
      }
      // Half-duplex: our own frame comes back first, then count*2 TLM bytes.
      port.enqueue(Uint8Array.from([...chunk, ...telemetry]));
    }
  };

  const fakeSerialApi = {
    async requestPort(): Promise<SerialPort> {
      const kind = nextPort ?? (!state.sensor ? "sensor" : !state.fc ? "fc" : "fettec");
      nextPort = null;
      if (state[kind]) throw new DOMException(`The ${kind} port is already taken`, "InvalidStateError");
      const port = new FakePort(
        kind === "fettec" ? fettecWrite : kind === "fc" ? fcWrite : sensorWrite,
        kind === "sensor",
      );
      state[kind] = port;
      return port as unknown as SerialPort;
    },
    async getPorts(): Promise<SerialPort[]> {
      return state.sensor ? [state.sensor as unknown as SerialPort] : [];
    },
    addEventListener(type: string, listener: (event: Event) => void): void {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener(type: string, listener: (event: Event) => void): void {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as Serial;

  window.__fakeSerial = {
    get sensor() {
      return state.sensor as unknown as FakePortInfo | null;
    },
    get fc() {
      return state.fc as unknown as FakePortInfo | null;
    },
    get fettec() {
      return state.fettec as unknown as FakePortInfo | null;
    },
    get seq() {
      return state.seq;
    },
    get pumpStarted() {
      return state.pumpStarted;
    },
    enqueueSensor(text: string) {
      (state.sensor as FakePort)?.enqueue(enc.encode(text));
    },
    lastWrites(port: "sensor" | "fc" | "fettec") {
      return (state[port] as FakePort)?.writes ?? [];
    },
    simulateSensorLoss() {
      const port = state.sensor as FakePort | null;
      if (!port) return;
      port.loseDevice();
      dispatch("disconnect", port);
    },
    setNextPort(kind: "sensor" | "fc" | "fettec") {
      nextPort = kind;
    },
    fettecFrames(limit = 200) {
      return fastFrames.slice(-limit).map((frame) => ({ values: [...frame.values], slot: frame.slot }));
    },
    fettecSignals() {
      return ((state.fettec as FakePort | null)?.signalsLog ?? []).map((signals) => ({ ...signals }));
    },
  };

  // navigator.serial is a readonly accessor on Navigator.prototype — a plain
  // assignment fails silently; shadow it with an own getter instead.
  Object.defineProperty(navigator, "serial", {
    get: () => fakeSerialApi,
    configurable: true,
  });
}
