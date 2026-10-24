// Packet rate, sequence-loss tracking and wire utilization (plan §6.6).

import { WIRE_BITS_PER_BYTE } from "./constants";

/** Sequence-gap tracking identical to the desktop `handle_sample` logic. */
export class SeqTracker {
  lastSeq: number | null = null;
  lostPackets = 0;
  seqResets = 0;

  onSeq(seq: number): { lost: number; reset: boolean } {
    let lost = 0;
    let reset = false;
    if (this.lastSeq !== null) {
      const gap = seq - this.lastSeq;
      if (gap > 1) {
        lost = gap - 1;
        this.lostPackets += lost;
      } else if (gap <= 0) {
        // Sequence rewound (e.g. device restart); not counted as loss.
        this.seqResets += 1;
        reset = true;
      }
    }
    this.lastSeq = seq;
    return { lost, reset };
  }

  /** Reconnect resets seq tracking to avoid a huge fake loss count. */
  resetTracking(keepTotals = true): void {
    this.lastSeq = null;
    if (!keepTotals) {
      this.lostPackets = 0;
      this.seqResets = 0;
    }
  }

  clear(): void {
    this.lastSeq = null;
    this.lostPackets = 0;
    this.seqResets = 0;
  }
}

/**
 * Sliding 1 s packet-rate meter with wire utilization. `onPacket` is called
 * with the wire size of each valid line; `tick` runs once per second.
 */
export class RateMeter {
  private packets = 0;
  private bytes = 0;
  private windowStartMs: number;
  packetRate = 0; // packets/s of the most recently completed window
  avgLineBytes = 0;
  private readonly baudRate: number;
  private readonly bitsPerByte: number;

  constructor(baudRate: number, nowMs: number, bitsPerByte = WIRE_BITS_PER_BYTE) {
    this.baudRate = baudRate;
    this.bitsPerByte = bitsPerByte;
    this.windowStartMs = nowMs;
  }

  onPacket(lineBytes: number): void {
    this.packets += 1;
    this.bytes += lineBytes;
  }

  tick(nowMs: number): { packetRate: number; wireUtilization: number; avgLineBytes: number } {
    const elapsedS = Math.max(0.001, (nowMs - this.windowStartMs) / 1000);
    this.packetRate = this.packets / elapsedS;
    this.avgLineBytes = this.packets > 0 ? this.bytes / this.packets : 0;
    this.packets = 0;
    this.bytes = 0;
    this.windowStartMs = nowMs;
    const wireUtilization = (this.packetRate * this.avgLineBytes * this.bitsPerByte) / this.baudRate;
    return {
      packetRate: this.packetRate,
      wireUtilization,
      avgLineBytes: this.avgLineBytes,
    };
  }

  get wireUtilization(): number {
    return (this.packetRate * this.avgLineBytes * this.bitsPerByte) / this.baudRate;
  }

  clear(nowMs: number): void {
    this.packets = 0;
    this.bytes = 0;
    this.packetRate = 0;
    this.avgLineBytes = 0;
    this.windowStartMs = nowMs;
  }
}
