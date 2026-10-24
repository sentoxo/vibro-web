// Save plumbing: browser download (default) + optional File System Access
// folder picker (Chromium), with session collision tracking (plan §6.14).

import type { Settings } from "../core/types";
import { resolveStem, stemFor } from "../core/naming";

/** Stems used this session; the export filename convention appends `_02`. */
export const takenStems = new Set<string>();

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function saveWithPicker(blob: Blob, filename: string): Promise<boolean> {
  if (typeof window.showSaveFilePicker !== "function") return false;
  const dot = filename.lastIndexOf(".");
  const extension = filename.slice(dot + 1);
  const handle = await window.showSaveFilePicker({
    suggestedName: filename,
    types: [
      {
        description: extension === "png" ? "PNG image" : "DVB1 burst file",
        accept: { [extension === "png" ? "image/png" : "application/octet-stream"]: [`.${extension}`] },
      },
    ],
  });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return true;
}

export async function saveBlob(blob: Blob, filename: string, settings: Settings): Promise<void> {
  if (settings.saveMode === "folder") {
    try {
      if (await saveWithPicker(blob, filename)) return;
    } catch (error) {
      // AbortError means the user cancelled; do not silently download.
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // Other picker failures (permissions, unsupported) fall back to download.
    }
  }
  downloadBlob(blob, filename);
}

/** Collision-aware stem for this session (mirrors the desktop `_02` rule). */
export function nextStem(base: string, index: number, power: number): string {
  const stem = resolveStem(stemFor(base, index, power), takenStems);
  takenStems.add(stem);
  return stem;
}
