import { describe, expect, it } from "vitest";
import { FETTEC_RPM_SOURCE_AUTO, FETTEC_RPM_SOURCE_MEAN } from "../../src/core/constants";
import { fettecMarkerRpmHz, isFettecRpmSourceAuto, pickFettecRpmMotor } from "../../src/core/fettec/rpmSource";

const allHealthy = (count: number) => new Array<boolean>(count).fill(true);
const rpms = (values: number[]): (number | null)[] => values.map((value) => value);

describe("FETtec RPM marker source", () => {
  it("Auto follows the motor with the highest commanded throttle", () => {
    const source = {
      source: FETTEC_RPM_SOURCE_AUTO,
      targets: [10, 30, 20],
      rpms: rpms([600, 2400, 1800]),
      healthy: allHealthy(3),
    };
    expect(pickFettecRpmMotor(source)).toBe(1);
    expect(fettecMarkerRpmHz(source)).toBeCloseTo(2400 / 60, 6);
  });

  it("Auto ties break on the highest measured eRPM, then on the lowest index", () => {
    // "apply to all 20 %" on a 4in1 with a prop only on M3: the marker must sit
    // on the channel that is physically spinning, not dilute over all of them.
    const tied = {
      source: FETTEC_RPM_SOURCE_AUTO,
      targets: [20, 20, 20, 20],
      rpms: rpms([0, 0, 4450, 0]),
      healthy: allHealthy(4),
    };
    expect(pickFettecRpmMotor(tied)).toBe(2);
    expect(fettecMarkerRpmHz(tied)).toBeCloseTo(4450 / 60, 6);

    const quiet = { source: FETTEC_RPM_SOURCE_AUTO, targets: [20, 20], rpms: rpms([0, 0]), healthy: allHealthy(2) };
    expect(pickFettecRpmMotor(quiet)).toBe(0);
  });

  it("Auto ignores self-diagnosing channels (no motor): their slots carry codes", () => {
    const broken = {
      source: FETTEC_RPM_SOURCE_AUTO,
      targets: [30, 10],
      rpms: rpms([2000, 900]),
      healthy: [false, true],
    };
    expect(pickFettecRpmMotor(broken)).toBe(1);
    expect(fettecMarkerRpmHz(broken)).toBeCloseTo(900 / 60, 6);
  });

  it("Auto keeps the source of a spinning channel once the throttle is gone", () => {
    const coasting = { source: FETTEC_RPM_SOURCE_AUTO, targets: [0, 0], rpms: rpms([0, 500]), healthy: allHealthy(2) };
    expect(pickFettecRpmMotor(coasting)).toBe(1);

    const stopped = { source: FETTEC_RPM_SOURCE_AUTO, targets: [0, 0], rpms: rpms([0, 0]), healthy: allHealthy(2) };
    expect(pickFettecRpmMotor(stopped)).toBe(-1);
    expect(fettecMarkerRpmHz(stopped)).toBe(0);
  });

  it("Mean averages only healthy channels (the 4in1 single-prop case)", () => {
    const mean = {
      source: FETTEC_RPM_SOURCE_MEAN,
      targets: [20, 20, 20, 20],
      rpms: rpms([4450, 0, 0, 0]),
      healthy: [true, false, false, false],
    };
    expect(pickFettecRpmMotor(mean)).toBe(-1);
    expect(fettecMarkerRpmHz(mean)).toBeCloseTo(4450 / 60, 6); // not 4450/4
  });

  it("a pinned motor wins, and reads 0 Hz when that channel is not measuring", () => {
    const pinned = { source: 3, targets: [10, 10, 30, 10], rpms: rpms([600, 700, 2400, 800]), healthy: allHealthy(4) };
    expect(pickFettecRpmMotor(pinned)).toBe(2);

    const broken = { ...pinned, healthy: [true, true, false, true] };
    expect(pickFettecRpmMotor(broken)).toBe(2);
    expect(fettecMarkerRpmHz(broken)).toBe(0);

    // ESC count shrank below the pinned motor: fall back to the mean.
    const beyond = { source: 8, targets: [10, 10], rpms: rpms([600, 800]), healthy: allHealthy(2) };
    expect(pickFettecRpmMotor(beyond)).toBe(-1);
    expect(fettecMarkerRpmHz(beyond)).toBeCloseTo(700 / 60, 6);
  });

  it("null telemetry (no reply yet) reads as 0 rpm, not as a crash", () => {
    const silent = {
      source: FETTEC_RPM_SOURCE_AUTO,
      targets: [25, 25],
      rpms: [null, null],
      healthy: allHealthy(2),
    };
    expect(pickFettecRpmMotor(silent)).toBe(0);
    expect(fettecMarkerRpmHz(silent)).toBe(0);
  });

  it("Auto is the default source value", () => {
    expect(isFettecRpmSourceAuto(FETTEC_RPM_SOURCE_AUTO)).toBe(true);
    expect(isFettecRpmSourceAuto(FETTEC_RPM_SOURCE_MEAN)).toBe(false);
    expect(isFettecRpmSourceAuto(2)).toBe(false);
  });
});
