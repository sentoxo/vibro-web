import { describe, expect, it } from "vitest";
import { resolveNames, resolveStem, sanitizeBase, stemFor } from "../../src/core/naming";

describe("stemFor", () => {
  it("formats {base}{index:02d}_{power} like the desktop", () => {
    expect(stemFor("run", 3, 42)).toBe("run03_42");
    expect(stemFor("test", 1, 0)).toBe("test01_0");
    expect(stemFor("", 5, 12)).toBe("snapshot05_12");
  });

  it("rounds power half-to-even (Python int(round))", () => {
    expect(stemFor("a", 1, 42.5)).toBe("a01_42");
    expect(stemFor("a", 1, 43.5)).toBe("a01_44");
  });

  it("clamps index to 1..99 and power to 0..100", () => {
    expect(stemFor("a", 0, 150)).toBe("a01_100");
    expect(stemFor("a", 100, -3)).toBe("a99_0");
  });
});

describe("sanitizeBase", () => {
  it("strips paths, .png/.bin suffixes and control chars", () => {
    expect(sanitizeBase("C:\\logs\\run.png")).toBe("run");
    expect(sanitizeBase("deep/path/to/data.bin")).toBe("data");
    expect(sanitizeBase("  spaced  ")).toBe("spaced");
    expect(sanitizeBase("weird\u0000name.png")).toBe("weirdname");
    expect(sanitizeBase(".png")).toBe("snapshot");
    expect(sanitizeBase("keep.bin.png")).toBe("keep.bin");
  });
});

describe("resolveStem", () => {
  it("adds _02, _03 ... collision suffixes", () => {
    const taken = new Set(["run01_5", "run01_5_02"]);
    expect(resolveStem("run01_5", taken)).toBe("run01_5_03");
    expect(resolveStem("fresh", new Set())).toBe("fresh");
  });

  it("resolveNames pairs png and bin on the same stem", () => {
    const taken = new Set(["run01_0"]);
    const { stem, filename } = resolveNames("run", 1, 0, taken);
    expect(stem).toBe("run01_0_02");
    expect(filename).toBe("run01_0_02.png");
  });
});
