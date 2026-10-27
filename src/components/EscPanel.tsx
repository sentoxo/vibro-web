// ESC control shell: MSP (desktop-parity) or FETtec OneWire over Betaflight
// passthrough. The two paths are mutually exclusive because passthrough turns
// the FC VCP into a raw OneWire pipe (MSP is dead there). Switching modes
// unmounts the active panel, whose cleanup stops the motors and closes the
// port.
//
// FettecPanel is lazy-loaded so the entry bundle stays under the 150 kB CI cap.

import { lazy, Suspense } from "preact/compat";
import { store } from "../state/store";
import { MspEscPanel } from "./MspEscPanel";

const FettecPanel = lazy(() => import("./FettecPanel"));

export function EscPanel() {
  const mode = store.esc.value.mode;
  return (
    <div class="esc-panel">
      <div class="section-label esc-label">
        ESC control
        <span class="badge badge-warn" title="No FC/ESC hardware was available during development">
          untested hardware
        </span>
      </div>

      <div class="esc-mode-switch" role="group" aria-label="ESC mode">
        <button
          class={`btn btn-small ${mode === "msp" ? "btn-accent" : ""}`}
          aria-pressed={mode === "msp"}
          onClick={() => store.patchEsc({ mode: "msp" })}
        >
          MSP
        </button>
        <button
          class={`btn btn-small ${mode === "fettec" ? "btn-accent" : ""}`}
          aria-pressed={mode === "fettec"}
          onClick={() => store.patchEsc({ mode: "fettec" })}
        >
          FETtec passthrough
        </button>
      </div>

      {mode === "msp" ? (
        <MspEscPanel />
      ) : (
        <Suspense fallback={<div class="esc-dim">Loading FETtec panel…</div>}>
          <FettecPanel />
        </Suspense>
      )}
    </div>
  );
}
