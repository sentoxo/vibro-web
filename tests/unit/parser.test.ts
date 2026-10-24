// Serial line parser tests: grammar parity with config.SEQ_LINE.

import { describe, expect, it } from "vitest";
import { LineParser, parseLine, type ParsedLine } from "../../src/core/parser";

const enc = new TextEncoder();

function parse(text: string): ParsedLine | null {
  const bytes = enc.encode(text);
  return parseLine(bytes, 0, bytes.length);
}

describe("parseLine", () => {
  it("parses a valid sensor-0 line", () => {
    expect(parse("S0,12345,256,-1024,4095")).toEqual({
      sid: 0,
      seq: 12345,
      x: 256,
      y: -1024,
      z: 4095,
      bytes: 24, // wire bytes: line + 1 for the newline (desktop len(line)+1)
    });
  });

  it("parses other sids (counted, not buffered by the source)", () => {
    const line = parse("S1,7,1,2,3");
    expect(line?.sid).toBe(1);
    expect(line?.seq).toBe(7);
  });

  it("accepts trailing spaces/tabs", () => {
    expect(parse("S0,1,0,0,0 \t ")).not.toBeNull();
  });

  it("rejects malformed lines", () => {
    expect(parse("")).toBeNull();
    expect(parse("A0,1,2,3,4")).toBeNull(); // wrong prefix
    expect(parse("S10,1,2,3,4")).toBeNull(); // sid must be one digit
    expect(parse("S0,1,2,3")).toBeNull(); // missing field
    expect(parse("S0,1,2,3,4,5")).toBeNull(); // extra field
    expect(parse("S0,1,2,3,x")).toBeNull(); // non-numeric
    expect(parse("S0,1,+2,3,4")).toBeNull(); // '+' not in grammar
    expect(parse("S0,1,2,3,4x")).toBeNull(); // trailing junk
    expect(parse("seq:1,x:2")).toBeNull();
  });

  it("parses boundary integers", () => {
    const line = parse("S0,4294967295,-32768,32767,0");
    expect(line).toEqual({ sid: 0, seq: 4294967295, x: -32768, y: 32767, z: 0, bytes: 29 });
  });
});

describe("LineParser", () => {
  function collect(maxBytes = 4096) {
    const lines: ParsedLine[] = [];
    const malformed: string[] = [];
    let overflows = 0;
    const parser = new LineParser(
      {
        onLine: (l) => lines.push(l),
        onMalformed: (t) => malformed.push(t),
        onOverflow: () => overflows++,
      },
      maxBytes,
    );
    return { parser, lines, malformed, overflows: () => overflows };
  }

  it("splits lines across chunk boundaries", () => {
    const { parser, lines } = collect();
    parser.push(enc.encode("S0,1,10,20,"));
    parser.push(enc.encode("30\nS0,2,40,50,"));
    parser.push(enc.encode("60\r\nS0,3,70,80,90\n"));
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(lines[1].z).toBe(60);
  });

  it("counts malformed lines and keeps parsing", () => {
    const { parser, lines, malformed } = collect();
    parser.push(enc.encode("junk line\nS0,1,1,1,1\n"));
    expect(malformed).toEqual(["junk line"]);
    expect(lines).toHaveLength(1);
  });

  it("resyncs after an oversized unterminated line", () => {
    const { parser, lines, malformed, overflows } = collect(32);
    parser.push(enc.encode("x".repeat(100)));
    parser.push(enc.encode("\nS0,1,1,1,1\n"));
    expect(overflows()).toBe(1);
    expect(malformed.length).toBeGreaterThanOrEqual(1);
    expect(lines).toHaveLength(1);
  });

  it("ignores empty lines", () => {
    const { parser, lines, malformed } = collect();
    parser.push(enc.encode("\n\nS0,1,1,1,1\n\n"));
    expect(lines).toHaveLength(1);
    expect(malformed).toHaveLength(0);
  });
});
