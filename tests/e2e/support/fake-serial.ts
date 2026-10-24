// Fake Web Serial implementation injected with page.addInitScript().
// First requestPort() returns the sensor port (streams S-lines once
// `start stream` arrives), second returns the FC port (answers MSP
// telemetry requests). All writes are captured for assertions.

export interface FakeSerialState {
  sensor: FakePortInfo | null;
  fc: FakePortInfo | null;
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
      lastWrites(port: "sensor" | "fc"): number[][];
    };
  }
}

export function installFakeSerial(opts?: { simulateLoss?: boolean }): void {
  const simulateLoss = opts?.simulateLoss ?? true;
  const enc = new TextEncoder();

  class FakePort {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    writes: number[][] = [];
    openCount = 0;
    private opened = false;
    // BYOB (bytes) stream: chunks enqueued are ArrayBuffers, read via BYOB reader.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private ctrl: { enqueue(chunk: any): void } | null = null;
    readonly onWrite: (chunk: Uint8Array) => void;

    constructor(onWrite: (chunk: Uint8Array) => void, byteStream = false) {
      this.onWrite = onWrite;
      this.readable = byteStream
        ? // The sensor link reads BYOB mode: a bytes stream fed with ArrayBuffers.
          new ReadableStream<Uint8Array>({
            type: "bytes",
            start: (controller) => {
              this.ctrl = controller as unknown as { enqueue(chunk: any): void };
            },
          })
        : // The FC panel reads default-mode: plain Uint8Array chunks.
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              this.ctrl = controller as unknown as { enqueue(chunk: any): void };
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
      this.openCount += 1;
      this.opened = true;
    }

    async close(): Promise<void> {
      this.opened = false;
    }

    getInfo() {
      return { usbVendorId: 0x1a86, usbProductId: 0x7523 };
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

  const state: FakeSerialState = { sensor: null, fc: null, seq: 0, pumpStarted: false };

  const sensorWrite = (chunk: Uint8Array) => {
    const text = new TextDecoder().decode(chunk);
    if (text.includes("start stream") && !state.pumpStarted) {
      state.pumpStarted = true;
      // 400 lines/s, one deliberate 3-packet gap at seq 500.
      setInterval(() => {
        const port = state.sensor as FakePort | null;
        if (!port) return;
        let out = "";
        for (let i = 0; i < 20; i++) {
          state.seq += 1;
          if (simulateLoss && state.seq === 500) state.seq += 3;
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
    // `$M< 00 8B 8B` telemetry request → $M> response with 4 motors.
    if (b.length === 6 && b[0] === 0x24 && b[1] === 0x4d && b[2] === 0x3c && b[3] === 0 && b[4] === 0x8b) {
      const payload = new Uint8Array(1 + 4 * 13);
      payload[0] = 4;
      const view = new DataView(payload.buffer);
      view.setUint32(1, 123456, true);
      view.setUint32(1 + 13, 234567, true);
      view.setUint32(1 + 26, 0, true);
      view.setUint32(1 + 39, 345678, true);
      const resp = [0x24, 0x4d, 0x3e, payload.length, 0x8b, ...payload];
      let xors = 0;
      for (let i = 3; i < resp.length - 1; i++) xors ^= resp[i] & 0xff;
      resp.push(xors);
      (state.fc as FakePort).enqueue(Uint8Array.from(resp));
    }
  };

  window.__fakeSerial = {
    get sensor() {
      return state.sensor as unknown as FakePortInfo | null;
    },
    get fc() {
      return state.fc as unknown as FakePortInfo | null;
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
    lastWrites(port: "sensor" | "fc") {
      return (state[port] as FakePort)?.writes ?? [];
    },
  };

  const fakeSerialApi = {
    async requestPort(): Promise<SerialPort> {
      if (!state.sensor) {
        state.sensor = new FakePort(sensorWrite, true);
        return state.sensor as unknown as SerialPort;
      }
      if (!state.fc) {
        state.fc = new FakePort(fcWrite);
        return state.fc as unknown as SerialPort;
      }
      throw new DOMException("No more fake ports", "NotFoundError");
    },
    async getPorts(): Promise<SerialPort[]> {
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Serial;

  // navigator.serial is a readonly accessor on Navigator.prototype — a plain
  // assignment fails silently; shadow it with an own getter instead.
  Object.defineProperty(navigator, "serial", {
    get: () => fakeSerialApi,
    configurable: true,
  });
}
