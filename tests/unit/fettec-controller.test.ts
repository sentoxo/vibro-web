import { describe, expect, it } from "vitest";
import {
  FETTEC_DEADBAND_HIGH,
  FETTEC_DEADBAND_LOW,
  FETTEC_RAW_STOP,
  FettecController,
  fettecPercentForRaw,
  fettecRawForPercent,
  isFettecDeadband,
} from "../../src/core/fettec/controller";

describe("FETtec raw mapping", () => {
  it("maps 0 % to 1000 and 100 % to the 11-bit endpoint", () => {
    expect(fettecRawForPercent(0)).toBe(1000);
    expect(fettecRawForPercent(100)).toBe(2000);
    expect(fettecRawForPercent(30)).toBe(1300);
  });

  it("clamps out of range and uses banker's rounding", () => {
    expect(fettecRawForPercent(150)).toBe(2000);
    expect(fettecRawForPercent(-150)).toBe(1000);
    expect(fettecRawForPercent(-20)).toBe(1000);
    // 1000 + 0.05*10 = 1000.5 → ties-to-even → 1000
    expect(fettecRawForPercent(0.05)).toBe(1000);
    // 1000 + 0.15*10 = 1001.5 → 1002
    expect(fettecRawForPercent(0.15)).toBe(1002);
  });

  it("converts back and flags the dead band", () => {
    expect(fettecPercentForRaw(1300)).toBe(30);
    expect(fettecPercentForRaw(5000)).toBe(100);
    expect(isFettecDeadband(FETTEC_RAW_STOP)).toBe(true);
    expect(isFettecDeadband(FETTEC_DEADBAND_LOW - 1)).toBe(false);
    expect(isFettecDeadband(FETTEC_DEADBAND_HIGH + 1)).toBe(false);
  });
});

describe("FettecController", () => {
  it("validates the ESC count", () => {
    expect(() => new FettecController(0)).toThrow(RangeError);
    expect(() => new FettecController(9)).toThrow(RangeError);
    expect(new FettecController(8).count).toBe(8);
  });

  it("starts at zero and ramps 5 % every 50 ms", () => {
    const controller = new FettecController(2);
    controller.setAll(12);
    expect(controller.start()).toBe(true);
    expect(controller.phase).toBe("ramping");
    expect(controller.rawValues()).toEqual([1000, 1000]);

    controller.tick(1000); // establish the ramp clock, no step yet
    controller.tick(1050);
    expect(controller.currentValues()).toEqual([5, 5]);
    expect(controller.rawValues()).toEqual([1050, 1050]);
    controller.tick(1100);
    expect(controller.currentValues()).toEqual([10, 10]);
    controller.tick(1150);
    expect(controller.currentValues()).toEqual([12, 12]);
    expect(controller.phase).toBe("running");
    expect(controller.running).toBe(true);
    expect(controller.ramping).toBe(false);
    expect(controller.power).toBe(12);
    expect(controller.currentPower).toBe(12);
  });

  it("ramps multiple missed steps in one tick", () => {
    const controller = new FettecController(1);
    controller.setAll(30);
    controller.start();
    controller.tick(1000);
    controller.tick(1200); // four 50 ms steps
    expect(controller.currentValues()).toEqual([20]);
  });

  it("stop targets zero and ignores motor changes until the ramp completes", () => {
    const controller = new FettecController(1);
    controller.setAll(10);
    controller.start();
    controller.tick(1000);
    controller.tick(1050);
    controller.tick(1100);
    expect(controller.currentValues()).toEqual([10]);

    expect(controller.stop()).toBe(true);
    expect(controller.armed).toBe(false); // STOP releases the START latch
    expect(controller.phase).toBe("ramping");
    expect(controller.targetValues()).toEqual([0]);
    controller.setMotor(0, 50); // a stop ramp always wins
    expect(controller.targetValues()).toEqual([0]);

    controller.tick(1150); // re-establish the ramp clock after stop()
    controller.tick(1200);
    expect(controller.currentValues()).toEqual([5]);
    controller.tick(1250);
    expect(controller.currentValues()).toEqual([0]);
    expect(controller.phase).toBe("idle");
    expect(controller.running).toBe(false);
    expect(controller.ramping).toBe(false);
    expect(controller.rawValues()).toEqual([1000]);
  });

  it("START latches: 0 % and back up needs no second START", () => {
    const controller = new FettecController(1);
    controller.setMotor(0, 20);
    controller.start();
    controller.tick(1000);
    for (const now of [1050, 1100, 1150, 1200]) controller.tick(now);
    expect(controller.currentValues()).toEqual([20]);

    // slider back to 0 %: it ramps down and the latch keeps the session live
    controller.setMotor(0, 0);
    expect(controller.phase).toBe("ramping");
    controller.tick(1250); // the target change re-established the ramp clock
    for (const now of [1300, 1350, 1400, 1450]) controller.tick(now);
    expect(controller.currentValues()).toEqual([0]);
    expect(controller.rawValues()).toEqual([1000]); // the ESC stop value
    expect(controller.running).toBe(true);
    expect(controller.phase).toBe("running");

    // ... and straight back up, without touching START again
    controller.setMotor(0, 15);
    expect(controller.phase).toBe("ramping");
    controller.tick(1500);
    for (const now of [1550, 1600, 1650]) controller.tick(now);
    expect(controller.currentValues()).toEqual([15]);
    expect(controller.running).toBe(true);
  });

  it("START with every slider at 0 % arms the bus so later moves drive the motors", () => {
    const controller = new FettecController(2);
    expect(controller.start()).toBe(true);
    expect(controller.armed).toBe(true);
    expect(controller.phase).toBe("running");
    expect(controller.running).toBe(true);
    expect(controller.currentPower).toBe(0);
    expect(controller.rawValues()).toEqual([1000, 1000]);

    controller.setAll(10);
    expect(controller.phase).toBe("ramping");
    controller.tick(1000);
    controller.tick(1050);
    expect(controller.currentValues()).toEqual([5, 5]);
  });

  it("disarmed sliders command the targets only; nothing turns before START", () => {
    const controller = new FettecController(2);
    controller.setAll(25);
    controller.setMotor(0, 40);
    expect(controller.targetValues()).toEqual([40, 25]);
    expect(controller.currentValues()).toEqual([0, 0]);
    expect(controller.rawValues()).toEqual([1000, 1000]);
    expect(controller.phase).toBe("idle");
    expect(controller.running).toBe(false);
    expect(controller.armed).toBe(false);

    controller.start();
    expect(controller.phase).toBe("ramping");
    controller.tick(1000);
    controller.tick(1050);
    expect(controller.currentValues()).toEqual([5, 5]);
  });

  it("emergencyStop zeroes the values immediately", () => {
    const controller = new FettecController(2);
    controller.setAll(40);
    controller.start();
    controller.tick(1000);
    controller.tick(1100);
    expect(controller.currentValues()).toEqual([10, 10]);
    controller.emergencyStop();
    expect(controller.currentValues()).toEqual([0, 0]);
    expect(controller.targetValues()).toEqual([0, 0]);
    expect(controller.phase).toBe("idle");
    expect(controller.armed).toBe(false);
    expect(controller.rawValues()).toEqual([1000, 1000]);
  });

  it("clamps negative motor values to stop (0..100 % only)", () => {
    const controller = new FettecController(1);
    controller.setMotor(0, -25);
    expect(controller.targetValues()).toEqual([0]);
    controller.setMotor(0, 25);
    controller.start();
    controller.tick(1000);
    controller.tick(1250);
    expect(controller.rawValues()).toEqual([1250]);
    expect(controller.power).toBe(25);
  });
});
