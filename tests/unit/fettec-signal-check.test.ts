import { describe, expect, it } from "vitest";
import {
  classifySignalCheck,
  DEFAULT_CHECK_THRESHOLDS,
  runSignalCheck,
  summarizeSignalCheck,
  type SignalCheckIo,
  type SignalSample,
} from "../../src/core/fettec/signalCheck";
import type { FettecCheckResult } from "../../src/core/fettec/types";

const NOW = 10_000;

function sample(erpm: number | null, amps: number | null, last: number | null = NOW): SignalSample {
  return { erpm, amps, lastTelemetryMs: last };
}

function result(escIndex: number, verdict: FettecCheckResult["verdict"]): FettecCheckResult {
  return {
    escIndex,
    verdict,
    baselineErpm: 0,
    pulseErpm: 0,
    baselineAmps: 0,
    pulseAmps: 0,
    note: "",
  };
}

describe("classifySignalCheck", () => {
  it("reports no-onewire when telemetry is missing or stale", () => {
    expect(classifySignalCheck(sample(null, null, null), sample(null, null, null), NOW).verdict).toBe("no-onewire");
    const stale = NOW - DEFAULT_CHECK_THRESHOLDS.staleMs - 1;
    expect(classifySignalCheck(sample(0, 0, stale), sample(0, 0, stale), NOW).verdict).toBe("no-onewire");
  });

  it("reports onewire when ERPM follows the bus pulse", () => {
    const classified = classifySignalCheck(sample(0, 0), sample(DEFAULT_CHECK_THRESHOLDS.erpm, 0), NOW);
    expect(classified.verdict).toBe("onewire");
    expect(classified.note).toContain("followed");
  });

  it("reports onewire when only current follows the pulse", () => {
    expect(classifySignalCheck(sample(0, 0), sample(0, DEFAULT_CHECK_THRESHOLDS.amps + 0.1), NOW).verdict).toBe(
      "onewire",
    );
  });

  it("reports fc-pin when the ESC answers but ignores bus throttle", () => {
    const classified = classifySignalCheck(sample(100, 0.1), sample(120, 0.1), NOW);
    expect(classified.verdict).toBe("fc-pin");
    expect(classified.note).toContain("inferred");
  });

  it("reports the ESC self-diagnosis instead of trusting its problem codes", () => {
    // A no-motor channel reports code 2000 (→ bogus 20 A); the pulse must not
    // be read as a current spike that would fake an "onewire" verdict.
    const baseline: SignalSample = { erpm: 0, amps: 20, lastTelemetryMs: NOW, problem: "No motor detected" };
    const pulse: SignalSample = { erpm: 0, amps: 20, lastTelemetryMs: NOW, problem: "No motor detected" };
    const classified = classifySignalCheck(baseline, pulse, NOW);
    expect(classified.verdict).toBe("unknown");
    expect(classified.note).toMatch(/self-diagnosis/i);
    expect(classified.note).toMatch(/no motor detected/);
  });

  it("uses the pulse value alone when no baseline exists", () => {
    expect(classifySignalCheck(sample(null, null), sample(1000, 0), NOW).verdict).toBe("onewire");
    expect(classifySignalCheck(sample(null, null), sample(0, 0), NOW).verdict).toBe("fc-pin");
  });
});

describe("summarizeSignalCheck", () => {
  it("summarises all-onewire, all-fc-pin and all-missing cases", () => {
    const allOne = summarizeSignalCheck([result(0, "onewire"), result(1, "onewire")]);
    expect(allOne.summary).toBe("2 motors on the OneWire bus.");
    expect(allOne.allOneWire).toBe(true);

    const allFc = summarizeSignalCheck([result(0, "fc-pin"), result(1, "fc-pin")]);
    expect(allFc.summary).toContain("fed from the FC pins");
    expect(allFc.allOneWire).toBe(false);

    const allMissing = summarizeSignalCheck([result(0, "no-onewire")]);
    expect(allMissing.summary).toContain("No OneWire devices answered");
  });

  it("summarises mixed wiring", () => {
    const summary = summarizeSignalCheck([result(0, "onewire"), result(1, "fc-pin"), result(2, "no-onewire")]);
    expect(summary.summary).toBe("Mixed wiring: 1 on OneWire, 1 on FC pins (inferred), 1 not on the bus.");
    expect(summary.allOneWire).toBe(false);
  });

  it("handles an empty result set", () => {
    expect(summarizeSignalCheck([]).summary).toBe("No motors checked.");
  });
});

describe("runSignalCheck", () => {
  it("pulses one motor at a time, classifies and leaves everything at zero", async () => {
    let active = -1;
    let started = false;
    const calls: string[] = [];
    const io: SignalCheckIo = {
      count: 2,
      power: 10,
      read: (index) => {
        // Motor 0 answers and follows the bus; motor 1 answers but ignores it.
        if (index === 0) return sample(active === 0 && started ? 1200 : 0, 0);
        return sample(50, 0);
      },
      setMotor: (index, percent) => {
        calls.push(`motor:${index}:${percent}`);
        active = percent > 0 ? index : -1;
      },
      setAll: (percent) => {
        calls.push(`all:${percent}`);
        if (percent === 0) active = -1;
      },
      start: () => {
        calls.push("start");
        started = true;
      },
      stop: () => {
        calls.push("stop");
        started = false;
      },
      wait: async () => {},
      now: () => NOW,
      aborted: () => false,
    };

    const summary = await runSignalCheck(io);
    expect(summary.results.map((entry) => entry.verdict)).toEqual(["onewire", "fc-pin"]);
    expect(summary.allOneWire).toBe(false);
    // Always zeroed at the end.
    expect(calls.slice(-2)).toEqual(["all:0", "stop"]);
    expect(calls).toContain("motor:0:10");
    expect(calls).toContain("motor:1:10");
  });

  it("stops early when the user disconnects", async () => {
    let aborted = false;
    const io: SignalCheckIo = {
      count: 3,
      power: 10,
      read: () => sample(null, null, null),
      setMotor: () => {},
      setAll: () => {},
      start: () => {},
      stop: () => {},
      wait: async () => {
        aborted = true;
      },
      now: () => NOW,
      aborted: () => aborted,
    };
    const summary = await runSignalCheck(io);
    expect(summary.results).toEqual([]);
  });
});
