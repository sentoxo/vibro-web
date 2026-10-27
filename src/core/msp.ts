// MSP v1 encode/decode (plan §2.3 / Appendix B.3).
// Request:  $M< <size> <cmd> <payload...> <xor>
// Response: $M> <size> <cmd> <payload...> <xor>
// XOR covers size, cmd and payload only.

import { MSP_ANALOG, MSP_MOTOR_TELEMETRY, MSP_SET_MOTOR, MOTOR_RECORD_SIZE } from "./constants";

const PREAMBLE_OUT = [0x24, 0x4d, 0x3c]; // "$M<"
const PREAMBLE_IN = [0x24, 0x4d, 0x3e]; // "$M>"

function xorBytes(bytes: ArrayLike<number>, from: number, to: number): number {
  let checksum = 0;
  for (let i = from; i < to; i++) checksum ^= bytes[i] & 0xff;
  return checksum;
}

export function encodeMspPacket(command: number, payload: Uint8Array): Uint8Array {
  if (payload.length > 255) throw new RangeError("MSP v1 payload must be <= 255 bytes");
  const packet = new Uint8Array(3 + 2 + payload.length + 1);
  packet.set(PREAMBLE_OUT, 0);
  packet[3] = payload.length;
  packet[4] = command;
  packet.set(payload, 5);
  packet[packet.length - 1] = xorBytes(packet, 3, packet.length - 1);
  return packet;
}

/** MSP_SET_MOTOR (214): four little-endian u16 throttle values. */
export function setMotorPacket(throttles: number[]): Uint8Array {
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  for (let i = 0; i < 4; i++) view.setUint16(i * 2, throttles[i], true);
  return encodeMspPacket(MSP_SET_MOTOR, payload);
}

/** MSP_MOTOR_TELEMETRY (139) request: `$M< 00 8B 8B`. */
export function telemetryRequestPacket(): Uint8Array {
  return encodeMspPacket(MSP_MOTOR_TELEMETRY, new Uint8Array(0));
}

/** MSP_ANALOG (110) request: `$M< 00 6E 6E`. */
export function analogRequestPacket(): Uint8Array {
  return encodeMspPacket(MSP_ANALOG, new Uint8Array(0));
}

export interface MspAnalog {
  voltage: number; // V (payload unit is 0.1 V)
  current: number; // A (payload unit is 0.01 A)
  mah: number; // mAh drawn
  rssi: number; // 0..255
}

/**
 * MSP_ANALOG (110) payload: u8 voltage (0.1 V), u16 LE mAh, u8 RSSI,
 * u16 LE current (0.01 A) — six bytes in Betaflight. Extra trailing bytes are
 * tolerated (future firmware), short payloads are rejected.
 */
export function parseAnalog(payload: Uint8Array): MspAnalog | null {
  if (payload.length < 6) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    voltage: payload[0] * 0.1,
    mah: view.getUint16(1, true),
    rssi: payload[3],
    current: view.getUint16(4, true) * 0.01,
  };
}

export interface MspResponse {
  command: number;
  payload: Uint8Array;
}

export interface MspParserEvents {
  onResponse(response: MspResponse): void;
  onChecksumError(): void;
}

/**
 * Incremental response parser: buffers partial packets, resyncs on `$M>`,
 * validates XOR and drops checksum failures (desktop `_parse_packet` rules).
 */
export class MspParser {
  private readonly events: MspParserEvents;
  private buffer: number[] = [];
  checksumErrors = 0;

  constructor(events: MspParserEvents) {
    this.events = events;
  }

  reset(): void {
    this.buffer = [];
  }

  push(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length; i++) this.buffer.push(chunk[i]);
    this.drain();
  }

  private drain(): void {
    const buf = this.buffer;
    for (;;) {
      const start = findPreamble(buf, PREAMBLE_IN);
      if (start < 0) {
        // Keep the last 2 bytes; a preamble may be split across chunks.
        buf.splice(0, Math.max(0, buf.length - 2));
        return;
      }
      if (start > 0) buf.splice(0, start);
      if (buf.length < 6) return;
      const payloadSize = buf[3];
      const packetSize = payloadSize + 6;
      if (buf.length < packetSize) return;

      const packet = buf.slice(0, packetSize);
      buf.splice(0, packetSize);
      const checksum = xorBytes(packet, 3, packetSize - 1);
      if (checksum === packet[packetSize - 1]) {
        this.events.onResponse({
          command: packet[4],
          payload: new Uint8Array(packet.slice(5, packetSize - 1)),
        });
      } else {
        this.checksumErrors += 1;
        this.events.onChecksumError();
      }
    }
  }
}

function findPreamble(buf: number[], preamble: number[]): number {
  for (let i = 0; i + preamble.length <= buf.length; i++) {
    if (buf[i] === preamble[0] && buf[i + 1] === preamble[1] && buf[i + 2] === preamble[2]) {
      return i;
    }
  }
  return -1;
}

export interface MotorTelemetry {
  motorCount: number;
  rpm: number | null;
}

/**
 * Parse MSP_MOTOR_TELEMETRY payload for one motor channel (1-based).
 * Record layout verified against Betaflight master msp.c; the desktop only
 * requires the record's first u32 (erpm) to be present, so the length check
 * is `>= offset + 4`, not an exact 13-byte multiple.
 */
export function parseMotorTelemetry(payload: Uint8Array, motorChannel: number): MotorTelemetry | null {
  if (payload.length === 0) return null;
  const motorCount = payload[0];
  if (motorChannel < 1 || motorCount < motorChannel) return null;
  const offset = 1 + (motorChannel - 1) * MOTOR_RECORD_SIZE;
  if (payload.length < offset + 4) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { motorCount, rpm: view.getUint32(offset, true) };
}
