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
