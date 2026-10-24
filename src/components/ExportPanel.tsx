// Export controls: PNG snapshot, DVB1 snapshot, paired export, filename
// preview, destination (download / folder picker), collisions (plan §6.14).

import { useState } from "preact/compat";
import { store } from "../state/store";
import { nextStem, saveBlob } from "../state/exporter";
import { resolveStem, sanitizeBase, stemFor } from "../core/naming";
import { composeDashboardPng } from "../charts/export-png";
import { writeDvb1 } from "../core/dvb1";
import { takenStems } from "../state/exporter";
import { pushToast } from "../state/toasts";
import type { Settings } from "../core/types";

export function ExportPanel() {
  const [base, setBase] = useState("snapshot");
  const [index, setIndex] = useState(1);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const settings = store.settings.value;
  const power = Math.round(store.esc.value.power);

  const preview = resolveStem(stemFor(sanitizeBase(base), index, power), takenStems);

  const exportPng = async (stem: string): Promise<void> => {
    const blob = await composeDashboardPng();
    await saveBlob(blob, `${stem}.png`, settings);
  };

  const exportBin = async (stem: string): Promise<void> => {
    const data = store.snapshotData();
    const bytes = writeDvb1(data.samples, {
      sampleRate: data.sampleRate,
      timestampNs: data.timestampNs,
      sequence: data.sequence,
    });
    const blob = new Blob([bytes as unknown as BlobPart], { type: "application/octet-stream" });
    await saveBlob(blob, `${stem}.bin`, settings);
  };

  const run = async (kind: "png" | "bin" | "both") => {
    setStatus(null);
    const stem = nextStem(base, index, power);
    const failures: string[] = [];
    if (kind === "png" || kind === "both") {
      try {
        await exportPng(stem);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        failures.push(`PNG failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (kind === "bin" || kind === "both") {
      try {
        await exportBin(stem);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        failures.push(`snapshot failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (failures.length > 0) {
      const message = `Partial save (${stem}): ${failures.join("; ")}`;
      setStatus({ text: message, ok: false });
      pushToast({ kind: "error", title: "Export", message });
      return;
    }
    const saved =
      kind === "both"
        ? `${stem}.png and ${stem}.bin saved`
        : `${stem}.${kind === "png" ? "png" : "bin"} saved${kind === "bin" ? " (2 seconds)" : ""}`;
    setStatus({ text: saved, ok: true });
    if (settings.saveMode === "download")
      pushToast({ kind: "success", title: "Export", message: "Saved to Downloads." });
  };

  const setSaveMode = (saveMode: Settings["saveMode"]) => store.patchSettings({ saveMode });

  return (
    <div class="export-panel">
      <div class="section-label">Export</div>
      <label class="field-row">
        <span>Base name</span>
        <input
          class="input"
          value={base}
          onInput={(event) => setBase((event.target as HTMLInputElement).value)}
          placeholder="snapshot"
        />
      </label>
      <label class="field-row">
        <span>Index</span>
        <input
          class="input"
          type="number"
          min={1}
          max={99}
          value={index}
          onInput={(event) => setIndex(Number((event.target as HTMLInputElement).value) || 1)}
        />
      </label>
      <label class="field-row">
        <span>Destination</span>
        <select
          class="input"
          value={settings.saveMode}
          onChange={(event) => setSaveMode((event.target as HTMLSelectElement).value as Settings["saveMode"])}
        >
          <option value="download">Downloads</option>
          <option value="folder">Choose folder (Chromium)</option>
        </select>
      </label>
      <div class="export-preview">
        <code>
          {preview}.png · {preview}.bin
        </code>
      </div>
      <div class="export-buttons">
        <button class="btn" onClick={() => void run("png")}>
          Save PNG
        </button>
        <button class="btn" onClick={() => void run("bin")}>
          Save snapshot
        </button>
        <button class="btn btn-accent" onClick={() => void run("both")}>
          Save PNG + snapshot
        </button>
      </div>
      {status && (
        <div class={`export-status ${status.ok ? "export-status-ok" : "export-status-error"}`}>{status.text}</div>
      )}
    </div>
  );
}
