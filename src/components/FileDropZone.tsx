// Drag/drop + browse for DVB1 files, parse progress and errors (plan §5.2).

import { useRef, useState } from "preact/compat";
import { store } from "../state/store";
import { pushToast } from "../state/toasts";

export function FileDropZone({ compact = false }: { compact?: boolean }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const busy = store.busy.value;

  const load = async (file: File) => {
    try {
      const loaded = await store.openFile(file);
      pushToast({
        kind: "success",
        title: "File loaded",
        message: `${loaded.fileName}: ${loaded.bursts.length} burst(s)`,
      });
    } catch (error) {
      pushToast({
        kind: "error",
        title: "File error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void load(file);
  };

  return (
    <div
      class={`file-drop ${dragging ? "file-drop-active" : ""} ${compact ? "file-drop-compact" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
      }}
      role="button"
      tabIndex={0}
      aria-label="Open DVB1 file"
    >
      <input
        ref={inputRef}
        type="file"
        accept=".bin,.dvb,application/octet-stream"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = (event.target as HTMLInputElement).files?.[0];
          if (file) void load(file);
          (event.target as HTMLInputElement).value = "";
        }}
      />
      {busy ? (
        <span class="file-drop-busy">Parsing file…</span>
      ) : (
        <>
          <span class="file-drop-title">Open DVB1 file</span>
          <span class="file-drop-hint">Drop a .bin / .dvb file here or click to browse</span>
        </>
      )}
    </div>
  );
}
