import { describe, expect, it } from "vitest";
import { RateMeter, SeqTracker } from "../../src/core/rate-meter";

describe("SeqTracker (desktop handle_sample parity)", () => {
  it("counts gaps and ignores rewinds", () => {
    const tracker = new SeqTracker();
    tracker.onSeq(10);
    expect(tracker.onSeq(11).lost).toBe(0);
    expect(tracker.onSeq(14).lost).toBe(2);
    expect(tracker.lostPackets).toBe(2);
    // A device restart / sequence rewind is not loss.
    expect(tracker.onSeq(1).lost).toBe(0);
    expect(tracker.seqResets).toBe(1);
    expect(tracker.lostPackets).toBe(2);
  });

  it("resetTracking(true) rebaselines without losing session totals", () => {
    const tracker = new SeqTracker();
    tracker.onSeq(10);
    tracker.onSeq(20); // 9 lost
    tracker.resetTracking(true);
    expect(tracker.lastSeq).toBeNull();
    expect(tracker.onSeq(1000).lost).toBe(0); // outage gap ignored
    expect(tracker.lostPackets).toBe(9);
  });

  it("clear() starts a completely fresh session", () => {
    const tracker = new SeqTracker();
    tracker.onSeq(10);
    tracker.onSeq(20);
    tracker.clear();
    expect(tracker.lastSeq).toBeNull();
    expect(tracker.lostPackets).toBe(0);
    expect(tracker.seqResets).toBe(0);
  });
});

describe("RateMeter", () => {
  it("reports packets/s and measured payload bytes/s", () => {
    const meter = new RateMeter(0);
    for (let i = 0; i < 100; i++) meter.onPacket(30);
    const stats = meter.tick(1000);
    expect(stats.packetRate).toBeCloseTo(100, 6);
    expect(stats.avgLineBytes).toBeCloseTo(30, 6);
    expect(stats.bytesPerSecond).toBeCloseTo(3000, 6);
  });

  it("clear() zeroes the window and the reported throughput", () => {
    const meter = new RateMeter(0);
    for (let i = 0; i < 10; i++) meter.onPacket(20);
    meter.tick(1000);
    meter.clear(1000);
    expect(meter.packetRate).toBe(0);
    expect(meter.bytesPerSecond).toBe(0);
    expect(meter.avgLineBytes).toBe(0);
    expect(meter.tick(2000).bytesPerSecond).toBe(0);
  });
});
