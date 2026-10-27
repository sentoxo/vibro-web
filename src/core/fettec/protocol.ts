// FETtec OneWire protocol (pure): frame building, CRC, fast-throttle packing
// and fast telemetry decoding.
//
// Oracle: the FETtec configurator (`ESC/main.js`, `js/ESC/onewire.js`,
// `js/common/OW_commands.js`, `js/common/OW_devices.js`) and ArduPilot
// `libraries/AP_FETtecOneWire`. The desktop `../vibro/fettec_ctl.py` is NOT an
// oracle (its fast-throttle packer is broken for N >= 3 and it decodes the
// ArduPilot 11-byte telemetry instead of the fast slot telemetry).
//
// Frame layout:
//   [source, id, typeLo, typeHi, length, payload..., crc8]
// `length` counts the whole frame. Replies use source 0x02 (bootloader) or
// 0x03 (firmware); our own (echoed) master frames use 0x01 and are skipped.
//
// CRC: the configurator's `update_crc8` and ArduPilot's `crc8_dvb_update` both
// use polynomial **0x07** for OneWire (ArduPilot's `crc8_dvb_s2` is the one
// that uses 0xD5). The helper below is therefore named `crc8Fettec`.
//
// Reply payloads are *not* prefixed by a message id: the request determines
// the layout (REQ_TYPE → one type byte, REQ_SW_VER → version+subversion,
// REQ_SN → 12 serial bytes, OK → one 0 byte).

export const SRC_MASTER = 0x01;
export const SRC_BOOTLOADER = 0x02;
export const SRC_ESC = 0x03;

export const FRAME_OVERHEAD = 6; // source,id,typeLo,typeHi,length,crc
export const MAX_RX_PAYLOAD = 12;
export const ALL_ID = 0x1f;

export const MSG = {
  OK: 0,
  NOT_OK: 2,
  BL_START_FW: 3,
  REQ_TYPE: 5,
  REQ_SN: 6,
  REQ_SW_VER: 7,
  REQ_TLM: 12,
  BEEP: 13,
  SET_FAST_COM_LENGTH: 26,
  SET_TLM_TYPE: 27,
} as const;

/** Telemetry operation modes for SET_TLM_TYPE. */
export const TLM_TYPE_FAST_SLOTS = 0; // configurator default: 2 bytes per ESC per slot
export const TLM_TYPE_FULL_PER_ESC = 1; // ArduPilot alternative: one full frame per ESC

/**
 * CRC-8 used by the OneWire protocol, polynomial 0x07, seed 0. This is the
 * same function the configurator calls `update_crc8` and ArduPilot calls
 * `crc8_dvb_update` (despite the "dvb" name, FETtec uses 0x07, not 0xD5).
 */
export function crc8Fettec(data: ArrayLike<number>, seed = 0): number {
  let crc = seed & 0xff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/** Backwards-compatible alias for the plan's original name. */
export const crc8Dvb = crc8Fettec;

export interface FettecFrame {
  src: number;
  id: number;
  /** Bytes after the length byte, i.e. msg id followed by the payload. */
  payload: Uint8Array;
}

export function frameMessage(frame: FettecFrame): number {
  return frame.payload.length > 0 ? frame.payload[0] : -1;
}

export function framePayload(frame: FettecFrame): Uint8Array {
  return frame.payload.subarray(1);
}

/** Build a master (0x01) config frame to one ESC. */
export function buildConfigFrame(id: number, msg: number, payload: ArrayLike<number> = []): Uint8Array {
  const bodyLength = 1 + payload.length; // msg id + payload
  const length = FRAME_OVERHEAD + bodyLength; // header + body + crc
  const frame = new Uint8Array(length);
  frame[0] = SRC_MASTER;
  frame[1] = id & 0xff;
  frame[2] = 0;
  frame[3] = 0;
  frame[4] = length;
  frame[5] = msg & 0xff;
  frame.set(payload, 6);
  frame[length - 1] = crc8Fettec(frame.subarray(0, length - 1));
  return frame;
}

export interface ExtractResult {
  frames: FettecFrame[];
  leftover: Uint8Array;
  crcErrors: number;
}

/**
 * Pull valid ESC/bootloader frames out of a byte buffer. Own (echoed) frames,
 * noise and truncated frames are skipped by construction: a candidate only
 * becomes a frame when the length is plausible and the CRC matches.
 */
export function extractFrames(buffer: Uint8Array): ExtractResult {
  const frames: FettecFrame[] = [];
  let crcErrors = 0;
  let i = 0;
  while (i < buffer.length) {
    const src = buffer[i];
    if ((src === SRC_BOOTLOADER || src === SRC_ESC) && i + 5 <= buffer.length) {
      const length = buffer[i + 4];
      if (length >= FRAME_OVERHEAD && length <= FRAME_OVERHEAD + MAX_RX_PAYLOAD) {
        if (i + length > buffer.length) break; // incomplete: keep the tail
        if (crc8Fettec(buffer.subarray(i, i + length - 1)) === buffer[i + length - 1]) {
          frames.push({
            src,
            id: buffer[i + 1],
            payload: buffer.slice(i + 5, i + length - 1),
          });
          i += length;
          continue;
        }
        crcErrors += 1;
      }
    }
    i += 1;
  }
  return { frames, leftover: buffer.slice(i), crcErrors };
}

/** Bytes of the fast-throttle command before the CRC byte. */
export function fastThrottleCommandLen(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("fast throttle needs at least one ESC");
  // 12 fixed bits (8 header + 4 telemetry request) + 11 bits per ESC.
  return Math.ceil((12 + 11 * n) / 8);
}

/**
 * Full fast-throttle frame length, including the trailing CRC. This is the
 * value SET_FAST_COM_LENGTH must carry (N=8 → 14, N=2 → 6, N=1 → 4).
 * (`ceil((12 + 11·N)/8)` is the command length *before* the CRC.)
 */
export function fastThrottleLen(n: number): number {
  return fastThrottleCommandLen(n) + 1;
}

export interface PackedFastThrottle {
  frame: Uint8Array;
  commandLength: number;
  tlmSlot: number;
}

/**
 * Pack 11-bit throttle values (one per ESC, IDs contiguous from `minId`) into
 * the configurator's fast-throttle frame.
 *
 * Byte 0: 1AAABCCC — bit 7 = slot-mode flag (the configurator always sets it
 *         in fast-slot mode; ArduPilot's full-TLM mode instead puts an ESC ID
 *         in bits 4..7), A = telemetry slot 0..7, B = MSB of ESC 0 throttle,
 *         C = master source 0x01.
 * Byte 1: AAABBBBB — A = next 3 throttle bits, B = ALL_ID (0x1F).
 * The remaining bits are the rest of ESC 0 and every following ESC, MSB-first,
 * followed by the CRC. Padding bits at the end are zero.
 */
export function packFastThrottle(values: ArrayLike<number>, tlmSlot = 0): PackedFastThrottle {
  const n = values.length;
  if (n < 1) throw new RangeError("fast throttle needs at least one ESC");
  const commandLength = fastThrottleCommandLen(n);
  const frame = new Uint8Array(commandLength + 1);
  const slot = tlmSlot & 0x07;
  const v0 = clampRaw(values[0]);

  frame[0] = 0x80 | (slot << 4) | (((v0 >> 10) & 0x01) << 3) | SRC_MASTER;
  frame[1] = (((v0 >> 7) & 0x07) << 5) | ALL_ID;

  let bitsToAddLeft = 12 + 11 * n - 16;
  let throttleIndex = 0;
  let bitsLeftFromCommand = 7;
  let actByte = 2;
  let bitsFromByteLeft = 8;

  while (bitsToAddLeft > 0) {
    if (bitsFromByteLeft >= bitsLeftFromCommand) {
      frame[actByte] |=
        (clampRaw(values[throttleIndex]) & ((1 << bitsLeftFromCommand) - 1)) <<
        (bitsFromByteLeft - bitsLeftFromCommand);
      bitsToAddLeft -= bitsLeftFromCommand;
      bitsFromByteLeft -= bitsLeftFromCommand;
      throttleIndex += 1;
      bitsLeftFromCommand = 11;
      if (bitsToAddLeft === 0) {
        actByte += 1;
        bitsFromByteLeft = 8;
      }
    } else {
      frame[actByte] |=
        (clampRaw(values[throttleIndex]) >> (bitsLeftFromCommand - bitsFromByteLeft)) & ((1 << bitsFromByteLeft) - 1);
      bitsToAddLeft -= bitsFromByteLeft;
      bitsLeftFromCommand -= bitsFromByteLeft;
      actByte += 1;
      bitsFromByteLeft = 8;
      if (bitsLeftFromCommand === 0) {
        throttleIndex += 1;
        bitsLeftFromCommand = 11;
      }
    }
  }

  frame[commandLength] = crc8Fettec(frame.subarray(0, commandLength));
  return { frame, commandLength, tlmSlot: slot };
}

function clampRaw(value: number): number {
  if (!Number.isFinite(value)) return 1000;
  return Math.min(2000, Math.max(0, Math.round(value)));
}

/** Read `count` bits MSB-first from a byte array (bit 0 = MSB of byte 0). */
function readBits(bytes: Uint8Array, bitOffset: number, count: number): number {
  let value = 0;
  for (let i = 0; i < count; i++) {
    const bit = bitOffset + i;
    const byte = bytes[bit >> 3] ?? 0;
    value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1);
  }
  return value;
}

/** Inverse of `packFastThrottle` (used by tests and the e2e fake bus). */
export function unpackFastThrottle(frame: Uint8Array): { values: number[]; tlmSlot: number } {
  if (frame.length < 4) throw new RangeError("fast throttle frame too short");
  const commandLength = frame.length - 1;
  // Recover the total ESC count from the command length:
  // commandLength = ceil((12 + 11n)/8)  =>  n = floor((8*commandLength - 12)/11)
  const n = Math.floor((8 * commandLength - 12) / 11);
  if (n < 1) throw new RangeError("fast throttle frame has no ESC values");
  const tlmSlot = (frame[0] >> 4) & 0x07;
  // ESC 0's 11 bits are split around the ALL_ID field: bit 10 in byte 0,
  // bits 9..7 in byte 1, bits 6..0 in byte 2 bits 7..1.
  const v0 = (((frame[0] >> 3) & 1) << 10) | (((frame[1] >> 5) & 0x07) << 7) | ((frame[2] >> 1) & 0x7f);
  const values = [v0];
  // ESC 1 starts at byte 2 bit 0 (bit offset 23) and the rest are contiguous.
  for (let i = 1; i < n; i++) values.push(readBits(frame, 23 + (i - 1) * 11, 11));
  return { values, tlmSlot };
}

// === Fast telemetry (2 bytes per ESC, big-endian) ===

export const TLM_SLOTS = ["temp", "voltage", "current", "erpm", "consumption", "debug1", "debug2", "debug3"] as const;
export type TlmSlot = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface FettecTelemetryScales {
  temp: number;
  voltage: number;
  current: number;
  erpm: number;
  consumption: number;
}

/**
 * Defaults follow ArduPilot `handle_message_telem`: voltage/current are
 * centi-units, ERPM is centi-eRPM (×100), consumption is mAh. The FETtec GUI
 * shows the raw numbers, so every factor is overridable in settings.
 */
export const DEFAULT_TLM_SCALES: FettecTelemetryScales = {
  temp: 1,
  voltage: 0.01,
  current: 0.01,
  erpm: 100,
  consumption: 1,
};

export interface FastTelemetryReading {
  escIndex: number;
  slot: TlmSlot;
  raw: number;
  tempC: number | null;
  volt: number | null;
  amps: number | null;
  erpm: number | null;
  rpm: number | null;
  mah: number | null;
  debug: number | null;
}

/**
 * Decode one fast-telemetry reply: `count` big-endian u16 values in ESC-ID
 * order, all carrying the same slot. Slot 0 (temperature) and slot 2 (current)
 * are signed; `rpm` is mechanical RPM = erpm × 2 / poles.
 */
export function decodeFastTelemetry(
  bytes: Uint8Array,
  count: number,
  slot: TlmSlot,
  scales: FettecTelemetryScales = DEFAULT_TLM_SCALES,
  poles = 12,
): FastTelemetryReading[] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError("telemetry needs at least one ESC");
  if (slot < 0 || slot > 7) throw new RangeError("telemetry slot must be 0..7");
  const out: FastTelemetryReading[] = [];
  if (bytes.length < count * 2) return out;
  const safePoles = Number.isFinite(poles) && poles >= 2 ? poles : 12;

  for (let index = 0; index < count; index++) {
    let raw = (bytes[index * 2] << 8) | bytes[index * 2 + 1];
    if ((slot === 0 || slot === 2) && raw > 0x7fff) raw -= 0x10000;

    const reading: FastTelemetryReading = {
      escIndex: index,
      slot,
      raw,
      tempC: null,
      volt: null,
      amps: null,
      erpm: null,
      rpm: null,
      mah: null,
      debug: null,
    };
    switch (slot) {
      case 0:
        reading.tempC = raw * scales.temp;
        break;
      case 1:
        reading.volt = raw * scales.voltage;
        break;
      case 2:
        reading.amps = raw * scales.current;
        break;
      case 3:
        reading.erpm = raw * scales.erpm;
        reading.rpm = (reading.erpm * 2) / safePoles;
        break;
      case 4:
        reading.mah = raw * scales.consumption;
        break;
      case 5:
      case 6:
      case 7:
        reading.debug = raw;
        break;
    }
    out.push(reading);
  }
  return out;
}

// === Device type names (subset of the configurator's DEVICE_types) ===

const DEVICE_NAMES: Record<number, string> = {
  0: "none",
  1: "FETtec ESC 35A",
  2: "FETtec ESC 50A",
  3: "FETtec ESC 7A",
  4: "FETtec PRO ESC 80A",
  5: "FETtec PRO ESC 60A",
  6: "FETtec ESC 45A",
  7: "FETtec ESC 45A HV",
  8: "FETtec AIO 15A ESC",
  9: "FETtec PRO ESC 45A",
  10: "FETtec AIO 35A ESC",
  11: "FETtec ESC 65A",
  12: "FETtec ESC 50A HV",
  13: "FETtec ESC 65A WING",
  14: "FETtec Desert proof AIO ESC",
  64: "ESC 15A",
  65: "ESC 15A",
  68: "ESC 25A",
  69: "ESC 25A",
  72: "ESC 35A",
  73: "ESC 35A",
  74: "ESC 35A",
  75: "ESC 35A",
  78: "ESC 45A",
  79: "ESC 45A",
  80: "ESC 45A",
  81: "ESC 45A",
  82: "ESC 45A",
  83: "ESC 45A",
  86: "ESC 55A",
  87: "ESC 55A",
  88: "ESC 55A",
  89: "ESC 55A",
  90: "ESC 55A",
  91: "ESC 55A",
  93: "ESC 60A",
  94: "ESC 65A",
  95: "ESC 65A",
  96: "ESC 65A",
  97: "ESC 65A",
  98: "ESC 65A",
  99: "ESC 65A",
  102: "ESC 80A",
  103: "ESC 80A",
  104: "ESC 80A",
  105: "ESC 80A",
  106: "ESC 80A",
  107: "ESC 85A",
  108: "ESC 100A",
  109: "ESC 100A",
  110: "ESC 100A",
  111: "ESC 100A",
  114: "WING ESC 150A",
  127: "FETtec AIO 15A FC",
  128: "FETtec FC G4",
  129: "FETtec OSD",
  130: "FETtec FC F7",
  131: "FETtec AIO 15A G4 FC",
  132: "T-Motor FC G4",
  133: "GEPRC FC G4",
  134: "MAMBA FC G4",
  135: "NewBeeDrone G4 FC",
  136: "FETtec Desert proof AIO FC",
  200: "FETtec SFOC ESC 25A",
  201: "FETtec SFOC ESC 50A",
  202: "FETtec SFOC ESC 65A",
  203: "FETtec SFOC WING ESC 65A",
  204: "FETtec SFOC 16A",
  207: "FETtec SFOC 50A 4in1",
  208: "FETtec SFOC 50A 4in1",
  230: "ESC DEFAULT G0",
};

export function fettecDeviceName(type: number): string {
  return DEVICE_NAMES[type] ?? `ESC type ${type}`;
}

// === Byte-buffer helpers used by the bus ===

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  if (b.length === 0) return a.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Index of `needle` in `haystack`, or -1. */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from;
  outer: for (let i = Math.max(0, from); i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export interface FastReply {
  /** The count*2 telemetry bytes, or null when the reply is not complete yet. */
  telemetry: Uint8Array | null;
  /** Bytes that were not consumed. */
  leftover: Uint8Array;
  /** The echoed frame was not found in a reasonable window; caller should resync. */
  desync: boolean;
}

/**
 * Half-duplex fast-throttle reply: the host's own frame is echoed back, then
 * the ESCs append `count*2` telemetry bytes. Find the echo (CRC-validated by
 * the fact that it is our exact frame), then take the telemetry block.
 */
export function consumeFastReply(buffer: Uint8Array, echo: Uint8Array, count: number): FastReply {
  const tlmBytes = count * 2;
  const at = indexOfBytes(buffer, echo);
  if (at < 0) {
    // Keep waiting; if the buffer keeps growing without an echo, drop one byte
    // so a corrupt/missing echo cannot wedge the parser forever.
    if (buffer.length > echo.length + tlmBytes + 64) {
      return { telemetry: null, leftover: buffer.slice(1), desync: true };
    }
    return { telemetry: null, leftover: buffer, desync: false };
  }
  const start = at + echo.length;
  if (buffer.length < start + tlmBytes) {
    return { telemetry: null, leftover: buffer, desync: false };
  }
  return {
    telemetry: buffer.slice(start, start + tlmBytes),
    leftover: buffer.slice(start + tlmBytes),
    desync: false,
  };
}
