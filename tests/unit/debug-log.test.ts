// The debug-log ring + formatter behind the header's "Download debug log"
// button. The download itself (Blob/anchor) is a browser concern; this covers
// what the exported file contains.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDebugLog,
  debugLogCount,
  debugLogSnapshot,
  formatDebugLog,
  logDebug,
  logInfo,
  logWarn,
} from "../../src/state/debugLog";

describe("debug log ring buffer", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    clearDebugLog();
  });

  it("records scoped, leveled entries and exposes the count", () => {
    logInfo("serial", "connecting");
    logDebug("fettec", "warn", "Fast reply timeout: 0 B rx no data");
    const entries = debugLogSnapshot();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ scope: "serial", level: "info", message: "connecting" });
    expect(entries[1].level).toBe("warn");
    expect(debugLogCount.value).toBe(2);
  });

  it("keeps only the newest 4000 entries (the ring bound)", () => {
    for (let i = 0; i < 4200; i++) logInfo("demo", `event ${i}`);
    const entries = debugLogSnapshot();
    expect(entries).toHaveLength(4000);
    expect(entries.at(-1)!.message).toBe("event 4199");
    expect(entries[0].message).toBe("event 200");
  });

  it("formats a versioned header plus padded local-time lines for the downloaded file", () => {
    logInfo("serial", "hello");
    logWarn("esc", "boom");
    const text = formatDebugLog();
    expect(text).toContain("# Vibro Web");
    expect(text).toContain("entry times are local, UTC");
    expect(text).toContain("2 entries");
    expect(text).toMatch(/^\d\d:\d\d:\d\d\.\d{3} INFO  \[serial\] hello$/m);
    expect(text).toMatch(/^\d\d:\d\d:\d\d\.\d{3} WARN  \[esc\] boom$/m);
  });

  it("clear resets the ring and the reactive count", () => {
    logInfo("demo", "x");
    clearDebugLog();
    expect(debugLogSnapshot()).toHaveLength(0);
    expect(debugLogCount.value).toBe(0);
  });
});
