// In-app debug log: a ring buffer of timestamped, scoped entries that the
// header's debug button exports as a .log file. It exists to debug field
// reports (FETtec reply-window captures, serial handshakes, session
// lifecycle) without asking users to open DevTools. Every entry is mirrored
// to the browser console as well.

import { signal } from "@preact/signals";

export type DebugLevel = "debug" | "info" | "warn" | "error";

export interface DebugEntry {
  ts: number;
  level: DebugLevel;
  scope: string;
  message: string;
}

const MAX_ENTRIES = 4000;

const entries: DebugEntry[] = [];

/** Reactive entry count (for the download button's title). */
export const debugLogCount = signal(0);

const CONSOLE_MIRROR: Record<DebugLevel, (message: string) => void> = {
  debug: (message) => console.debug(message),
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export function logDebug(scope: string, level: DebugLevel, message: string): void {
  entries.push({ ts: Date.now(), level, scope, message });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  debugLogCount.value = entries.length;
  CONSOLE_MIRROR[level](`[${scope}] ${message}`);
}

export function logInfo(scope: string, message: string): void {
  logDebug(scope, "info", message);
}

export function logWarn(scope: string, message: string): void {
  logDebug(scope, "warn", message);
}

export function logError(scope: string, message: string): void {
  logDebug(scope, "error", message);
}

export function debugLogSnapshot(): DebugEntry[] {
  return [...entries];
}

export function clearDebugLog(): void {
  entries.length = 0;
  debugLogCount.value = 0;
}

/** "UTC+1" style label for the machine's current offset (DST included). */
function tzLabel(): string {
  const off = -new Date().getTimezoneOffset() / 60;
  return `UTC${off >= 0 ? "+" : "-"}${Math.abs(off)}`;
}

/** Wall-clock HH:MM:SS.mmm — the same clock the user sees on the taskbar. */
function localClock(ts: number): string {
  const d = new Date(ts);
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function formatDebugLog(): string {
  const header = [
    `# Vibro Web ${__APP_VERSION__} (${__BUILD_HASH__}) debug log`,
    `# generated ${new Date().toISOString()} (entry times are local, ${tzLabel()})`,
    typeof navigator !== "undefined" ? `# ua ${navigator.userAgent}` : "# ua node",
    typeof location !== "undefined" ? `# url ${location.href}` : "",
    `# ${entries.length} entries`,
  ].filter(Boolean);
  const lines = entries.map((entry) => {
    return `${localClock(entry.ts)} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}`;
  });
  return `${header.join("\n")}\n${lines.join("\n")}\n`;
}

/** Renders the log as a text file and triggers the browser download. */
export function downloadDebugLog(): string {
  const name = `vibro-debug-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
  const blob = new Blob([formatDebugLog()], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  logInfo("debug", `debug log downloaded: ${name} (${entries.length} entries)`);
  return name;
}
