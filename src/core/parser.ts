// Byte-level parser for the `S<sid>,<seq>,<x>,<y>,<z>` serial line protocol.
// Manual integer scanning, no per-line regex (plan §6.6), partial lines are
// buffered across chunks, and the accumulator is capped to bound memory.

export interface ParsedLine {
  sid: number;
  seq: number;
  x: number; // raw counts
  y: number;
  z: number;
  bytes: number; // wire bytes of the complete line (for the data-rate meter)
}

const NEWLINE = 0x0a; // \n
const CARRIAGE = 0x0d; // \r
const S_CODE = 0x53; // 'S'
const COMMA = 0x2c; // ','
const MINUS = 0x2d; // '-'
const SPACE = 0x20;
const TAB = 0x09;

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

/**
 * Parse one complete line (without the trailing \n). Returns null for
 * malformed lines. Grammar mirrors config.SEQ_LINE:
 * `^S(\d),(\d+),(-?\d+),(-?\d+),(-?\d+)\s*$`.
 */
export function parseLine(line: Uint8Array, start: number, end: number): ParsedLine | null {
  let i = start;
  const values: number[] = [];
  if (i >= end || line[i] !== S_CODE) return null;
  i += 1;

  for (let field = 0; field < 5; field++) {
    // Exactly one digit for sid, 1..19 digits for the rest (Number.MAX_SAFE
    // is far above int16 ranges; seq is u32-ish on the wire).
    const isSid = field === 0;
    let negative = false;
    if (!isSid && i < end && line[i] === MINUS) {
      negative = true;
      i += 1;
    }
    let value = 0;
    let digits = 0;
    while (i < end && isDigit(line[i])) {
      value = value * 10 + (line[i] - 0x30);
      digits += 1;
      i += 1;
      if (digits > 19) return null;
    }
    if (digits === 0) return null;
    if (isSid && digits !== 1) return null;
    values.push(negative ? -value : value);
    if (field < 4) {
      if (i >= end || line[i] !== COMMA) return null;
      i += 1;
    }
  }

  // Only trailing whitespace may follow the fifth field.
  while (i < end && (line[i] === SPACE || line[i] === TAB)) i += 1;
  if (i !== end) return null;

  return { sid: values[0], seq: values[1], x: values[2], y: values[3], z: values[4], bytes: end - start + 1 };
}

export interface LineParserEvents {
  onLine(line: ParsedLine): void;
  onMalformed(text: string): void;
  onOverflow(): void;
}

/**
 * Incremental line splitter. Feed raw chunks with `push()`; complete
 * newline-terminated lines are decoded and parsed.
 */
export class LineParser {
  private readonly events: LineParserEvents;
  private buffer: Uint8Array;
  private used = 0;
  malformedLines = 0;
  lastMalformed = "";

  constructor(events: LineParserEvents, maxBytes = 4096) {
    this.events = events;
    this.buffer = new Uint8Array(maxBytes);
  }

  reset(): void {
    this.used = 0;
  }

  push(chunk: Uint8Array): void {
    let pos = 0;
    while (pos < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, pos);
      if (newline < 0) {
        this.append(chunk.subarray(pos));
        break;
      }
      this.append(chunk.subarray(pos, newline));
      pos = newline + 1;
      this.emitLine();
    }
  }

  private append(bytes: Uint8Array): void {
    if (this.used + bytes.length > this.buffer.length) {
      // Oversized line (no newline for `maxBytes`): drop it and resync.
      const text = new TextDecoder().decode(this.buffer.subarray(0, Math.min(this.used, 80)));
      this.malformedLines += 1;
      this.lastMalformed = text;
      this.events.onMalformed(text);
      this.events.onOverflow();
      this.used = 0;
      const keep = Math.min(bytes.length, this.buffer.length);
      this.buffer.set(bytes.subarray(bytes.length - keep));
      this.used = keep;
      return;
    }
    this.buffer.set(bytes, this.used);
    this.used += bytes.length;
  }

  private emitLine(): void {
    if (this.used === 0) return; // empty line, ignore
    let end = this.used;
    if (this.buffer[end - 1] === CARRIAGE) end -= 1; // strip optional \r
    const line = parseLine(this.buffer, 0, end);
    if (line) {
      this.events.onLine(line);
    } else {
      const text = new TextDecoder().decode(this.buffer.subarray(0, Math.min(end, 80)));
      this.malformedLines += 1;
      this.lastMalformed = text;
      this.events.onMalformed(text);
    }
    this.used = 0;
  }
}
