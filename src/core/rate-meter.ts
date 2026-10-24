// Packet rate, sequence-loss tracking and measured data rate (plan §6.6).
// Web Serial talks to an STM32 USB CDC device: the host link is USB full
// speed, not the nominal UART baud rate, so the useful figure is the measured
// payload rate (KB/s) rather than a fabricated percentage of a baud budget.

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
 * Sliding 1 s packet-rate meter. `onPacket` is called with the wire size of
 * each valid line; `tick` runs once per second and reports packets/s plus the
 * measured payload throughput in bytes/s.
 */
export class RateMeter {
  private packets = 0;
  private bytes = 0;
  private windowStartMs: number;
  packetRate = 0; // packets/s of the most recently completed window
  avgLineBytes = 0;
  bytesPerSecond = 0;

  constructor(nowMs: number) {
    this.windowStartMs = nowMs;
  }

  onPacket(lineBytes: number): void {
    this.packets += 1;
    this.bytes += lineBytes;
  }

  tick(nowMs: number): { packetRate: number; bytesPerSecond: number; avgLineBytes: number } {
    const elapsedS = Math.max(0.001, (nowMs - this.windowStartMs) / 1000);
    this.packetRate = this.packets / elapsedS;
    this.avgLineBytes = this.packets > 0 ? this.bytes / this.packets : 0;
    this.packets = 0;
    this.bytes = 0;
    this.windowStartMs = nowMs;
    this.bytesPerSecond = this.packetRate * this.avgLineBytes;
    return {
      packetRate: this.packetRate,
      bytesPerSecond: this.bytesPerSecond,
      avgLineBytes: this.avgLineBytes,
    };
  }

  clear(nowMs: number): void {
    this.packets = 0;
    this.bytes = 0;
    this.packetRate = 0;
    this.avgLineBytes = 0;
    this.bytesPerSecond = 0;
    this.windowStartMs = nowMs;
  }
}
