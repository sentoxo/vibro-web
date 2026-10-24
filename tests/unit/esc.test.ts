import { describe, expect, it } from "vitest";
import { clampPower, EscController, motorCommandForPower, throttleForPower, ZERO_THROTTLE } from "../../src/core/esc";

describe("throttle mapping", () => {
  it("maps 0..100 % to 1000..2000", () => {
    expect(throttleForPower(0)).toBe(1000);
    expect(throttleForPower(30)).toBe(1300);
    expect(throttleForPower(100)).toBe(2000);
    expect(throttleForPower(-5)).toBe(1000);
    expect(throttleForPower(150)).toBe(2000);
  });

  it("uses banker's rounding for .5 LSB ties (Python int(round))", () => {
    expect(throttleForPower(0.05)).toBe(1000); // 0.5 -> 0
    expect(throttleForPower(0.15)).toBe(1002); // 1.5 -> 2
    expect(throttleForPower(0.25)).toBe(1002); // 2.5 -> 2
    expect(throttleForPower(12.5)).toBe(1125); // 125 exact
  });

  it("drives all four channels equally", () => {
    expect(motorCommandForPower(42)).toEqual([1420, 1420, 1420, 1420]);
    expect(ZERO_THROTTLE).toEqual([1000, 1000, 1000, 1000]);
    expect(clampPower(120)).toBe(100);
  });
});

describe("EscController", () => {
  function makeEsc(available = true) {
    const sent: number[][] = [];
    const esc = new EscController((throttles) => {
      if (!available) return false;
      sent.push([...throttles]);
      return true;
    });
    return { esc, sent };
  }

  it("start sends the throttle for the current power", () => {
    const { esc, sent } = makeEsc();
    esc.setPower(30); // idle: no send
    expect(sent).toHaveLength(0);
    expect(esc.start()).toBe(true);
    expect(sent).toEqual([[1300, 1300, 1300, 1300]]);
    expect(esc.running).toBe(true);
  });

  it("power change while running resends; while idle it does not", () => {
    const { esc, sent } = makeEsc();
    esc.start();
    expect(sent).toHaveLength(1);
    esc.setPower(55);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual([1550, 1550, 1550, 1550]);
  });

  it("stop ramps down in 5 % steps every call, ending at zero throttle", () => {
    const { esc, sent } = makeEsc();
    esc.setPower(12);
    esc.start();
    sent.length = 0;

    expect(esc.stop()).toBe(true);
    const steps: number[] = [];
    while (esc.phase === "ramping") {
      esc.stepRamp();
      if (sent.length > 0) steps.push(sent[sent.length - 1][0]);
    }
    expect(steps).toEqual([1120, 1070, 1020, 1000]);
    expect(esc.power).toBe(0);
    expect(esc.running).toBe(false);
  });

  it("stop from idle with FC connected ramps from current power (desktop parity)", () => {
    const { esc, sent } = makeEsc();
    esc.setPower(7);
    expect(esc.stop()).toBe(true);
    esc.stepRamp(); // sends 1070
    expect(sent[0]).toEqual([1070, 1070, 1070, 1070]);
  });

  it("start cancels an in-progress ramp", () => {
    const { esc, sent } = makeEsc();
    esc.setPower(20);
    esc.start();
    esc.stop();
    esc.stepRamp(); // ramp send
    esc.start();
    expect(esc.running).toBe(true);
    expect(sent[sent.length - 1]).toEqual([1200, 1200, 1200, 1200]);
  });

  it("failed sends park the controller (FC down)", () => {
    const esc = new EscController(() => false);
    expect(esc.start()).toBe(false);
    expect(esc.running).toBe(false);
    esc.setPower(10);
    esc.stop();
    esc.stepRamp();
    expect(esc.phase).toBe("idle");
  });

  it("emergencyStop zeroes the motors and the state", () => {
    const { esc, sent } = makeEsc();
    esc.setPower(50);
    esc.start();
    esc.emergencyStop();
    expect(sent[sent.length - 1]).toEqual(ZERO_THROTTLE);
    expect(esc.phase).toBe("idle");
    expect(esc.power).toBe(0);
  });
});
