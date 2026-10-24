import { describe, expect, it } from "vitest";
import {
  encodeMspPacket,
  MspParser,
  parseMotorTelemetry,
  setMotorPacket,
  telemetryRequestPacket,
  type MspResponse,
} from "../../src/core/msp";

function bytes(arr: number[]): Uint8Array {
  return Uint8Array.from(arr);
}

describe("encoding", () => {
  it("SET_MOTOR (214) packet matches the desktop byte layout", () => {
    const packet = setMotorPacket([1000, 1500, 2000, 1000]);
    // $M< len=8 code=214, 4x u16 LE, xor over len..payload
    expect([...packet.subarray(0, 5)]).toEqual([0x24, 0x4d, 0x3c, 0x08, 0xd6]);
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    expect(view.getUint16(5, true)).toBe(1000);
    expect(view.getUint16(7, true)).toBe(1500);
    expect(view.getUint16(9, true)).toBe(2000);
    expect(view.getUint16(11, true)).toBe(1000);
    let ck = 0;
    for (const b of packet.subarray(3, packet.length - 1)) ck ^= b;
    expect(packet[packet.length - 1]).toBe(ck);
    expect(packet.length).toBe(14);
  });

  it("telemetry request is `$M< 00 8B 8B` (size 0, cmd 139, ck 0x8B)", () => {
    expect([...telemetryRequestPacket()]).toEqual([0x24, 0x4d, 0x3c, 0x00, 0x8b, 0x8b]);
  });

  it("encodeMspPacket rejects oversize payloads", () => {
    expect(() => encodeMspPacket(1, new Uint8Array(256))).toThrow(RangeError);
  });
});

describe("MspParser", () => {
  function makeResponse(command: number, payload: Uint8Array): Uint8Array {
    // Responses use the $M> preamble; encodeMspPacket emits $M< (requests).
    const packet = encodeMspPacket(command, payload);
    packet[2] = 0x3e; // '>'
    return packet;
  }

  function collect() {
    const responses: MspResponse[] = [];
    let checksumErrors = 0;
    const parser = new MspParser({
      onResponse: (r) => responses.push(r),
      onChecksumError: () => checksumErrors++,
    });
    return { parser, responses, checksumErrors: () => checksumErrors };
  }

  it("parses a complete response", () => {
    const { parser, responses } = collect();
    const payload = new Uint8Array(1 + 4 * 13);
    payload[0] = 4;
    parser.push(makeResponse(139, payload));
    expect(responses).toHaveLength(1);
    expect(responses[0].command).toBe(139);
    expect(responses[0].payload.length).toBe(1 + 4 * 13);
  });

  it("reassembles packets split across chunks", () => {
    const { parser, responses } = collect();
    const packet = makeResponse(139, Uint8Array.from([2, 0, 0, 0, 0, 1, 0, 0, 0]));
    for (let i = 0; i < packet.length; i++) parser.push(packet.subarray(i, i + 1));
    expect(responses).toHaveLength(1);
  });

  it("resyncs on $M> after junk and drops checksum errors", () => {
    const { parser, responses, checksumErrors } = collect();
    const packet = makeResponse(139, Uint8Array.from([1, 10, 0, 0, 0]));
    const junk = bytes([0xff, 0x24, 0x4d, 0x00, 0x24, 0x4d]);
    const combined = new Uint8Array(junk.length + packet.length);
    combined.set(junk, 0);
    combined.set(packet, junk.length);
    parser.push(combined);
    expect(responses).toHaveLength(1);

    const corrupted = Uint8Array.from(packet);
    corrupted[corrupted.length - 1] ^= 0xff;
    parser.push(corrupted);
    expect(checksumErrors()).toBe(1);
    expect(responses).toHaveLength(1);
  });
});

describe("parseMotorTelemetry", () => {
  function telemetryPayload(erpm: number[]): Uint8Array {
    const payload = new Uint8Array(1 + erpm.length * 13);
    payload[0] = erpm.length;
    const view = new DataView(payload.buffer);
    erpm.forEach((value, i) => view.setUint32(1 + i * 13, value, true));
    return payload;
  }

  it("reads the u32 erpm of the requested 1-based channel", () => {
    const payload = telemetryPayload([1111, 2222, 3333, 4444]);
    expect(parseMotorTelemetry(payload, 3)).toEqual({ motorCount: 4, rpm: 3333 });
    expect(parseMotorTelemetry(payload, 1)?.rpm).toBe(1111);
  });

  it("returns null for missing channels / short payloads", () => {
    const payload = telemetryPayload([1111]);
    expect(parseMotorTelemetry(payload, 2)).toBeNull();
    expect(parseMotorTelemetry(new Uint8Array(0), 1)).toBeNull();
    // Channel 2 record present only partially (desktop: needs offset+4 bytes).
    const partial = telemetryPayload([1111, 2222]).subarray(0, 1 + 13 + 3);
    expect(parseMotorTelemetry(partial, 2)).toBeNull();
    const enough = telemetryPayload([1111, 2222]);
    expect(parseMotorTelemetry(enough, 2)?.rpm).toBe(2222);
  });

  it("tolerates trailing extra bytes (loose desktop check)", () => {
    const payload = telemetryPayload([5000]);
    const extended = new Uint8Array(payload.length + 7);
    extended.set(payload, 0);
    expect(parseMotorTelemetry(extended, 1)?.rpm).toBe(5000);
  });
});
