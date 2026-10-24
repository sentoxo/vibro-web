import { describe, expect, it } from "vitest";
import { meanOf, rmsZeroCentered, rmsZeroMean, RmsHistory, vectorRms } from "../../src/core/stats";

describe("rms", () => {
  it("rmsZeroCentered = sqrt(mean(x^2))", () => {
    expect(rmsZeroCentered([1, -1, 1, -1])).toBeCloseTo(1, 12);
    expect(rmsZeroCentered([3, 4])).toBeCloseTo(Math.sqrt(12.5), 12);
    expect(rmsZeroCentered([])).toBe(0);
  });

  it("rmsZeroMean removes DC first", () => {
    expect(rmsZeroMean([101, 99, 101, 99], 4, 100)).toBeCloseTo(1, 12);
  });

  it("meanOf", () => {
    expect(meanOf([1, 2, 3, 4])).toBeCloseTo(2.5, 12);
    expect(meanOf([])).toBe(0);
  });

  it("vectorRms combines axes as a resultant (desktop ISO rule)", () => {
    expect(vectorRms(3, 4, 0)).toBeCloseTo(5, 12);
    expect(vectorRms(1, 1, 1)).toBeCloseTo(Math.sqrt(3), 12);
  });
});

describe("RmsHistory", () => {
  it("prunes outside the window and computes avg/min/max", () => {
    const history = new RmsHistory(10);
    history.push(0, 1);
    history.push(5000, 3);
    history.push(9000, 5);
    expect(history.avgMinMax()).toEqual({ avg: 3, min: 1, max: 5 });

    history.push(12000, 7); // t=0 falls out of the 10 s window
    expect(history.size).toBe(3);
    expect(history.avgMinMax()).toEqual({ avg: 5, min: 3, max: 7 });
  });

  it("empty history reports zeros", () => {
    expect(new RmsHistory(10).avgMinMax()).toEqual({ avg: 0, min: 0, max: 0 });
  });

  it("clear empties the window", () => {
    const history = new RmsHistory(10);
    history.push(0, 2);
    history.clear();
    expect(history.size).toBe(0);
  });

  it("series downsamples to at most maxPoints", () => {
    const history = new RmsHistory(100);
    for (let i = 0; i < 100; i++) history.push(i * 100, i);
    expect(history.series(10)).toHaveLength(10);
    expect(history.series(200)).toHaveLength(100);
  });
});
