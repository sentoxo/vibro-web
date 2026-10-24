// Bottom status strip: packets, loss, malformed, wire %, render, version
// (plan §5.3). Replaces the desktop CPU-usage readout.

import { store } from "../state/store";
import { formatInt, formatPercent } from "../core/units";

export function StatusStrip() {
  const diag = store.diagnostics.value;
  const source = store.sourceKind.value;
  return (
    <footer class="status-strip" aria-label="Diagnostics">
      <span>
        packets <b class="tabular">{formatInt(diag.packetRate)}</b>/s
      </span>
      <span class={diag.lostPackets > 0 ? "status-danger" : ""}>
        lost <b class="tabular">{formatInt(diag.lostPackets)}</b>
      </span>
      <span class={diag.malformedLines > 0 ? "status-warning" : ""}>
        malformed <b class="tabular">{formatInt(diag.malformedLines)}</b>
      </span>
      {source === "serial" && (
        <span class={diag.wireUtilization > 0.8 ? "status-warning" : ""}>
          wire <b class="tabular">{formatPercent(diag.wireUtilization)}</b>
        </span>
      )}
      {diag.bufferOverruns > 0 && (
        <span class="status-danger">
          read errors <b class="tabular">{formatInt(diag.bufferOverruns)}</b>
        </span>
      )}
      <span>
        render <b class="tabular">{diag.renderMs.toFixed(1)} ms</b>
      </span>
      <span>
        FPS <b class="tabular">{formatInt(diag.fps)}</b>
      </span>
      <span class="status-spacer" />
      <span class="status-dim">
        v{__APP_VERSION__} · {__BUILD_HASH__}
      </span>
    </footer>
  );
}
