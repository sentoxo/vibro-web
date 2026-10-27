// Props-off confirmation before any motor command (plan §5.6, D13).
// The FETtec variant adds the OneWire-specific hazards: the FC enters serial
// passthrough (MSP is dead), its motor pins are held high, the ESCs need
// continuous frames (250 ms failsafe) and the FC reboots on disconnect.

import { useState } from "preact/compat";

export function SafetyDialog({
  onConfirm,
  onCancel,
  mode = "msp",
}: {
  onConfirm: () => void;
  onCancel: () => void;
  mode?: "msp" | "fettec";
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const fettec = mode === "fettec";
  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="ESC safety warning">
      <div class="modal modal-danger">
        <div class="modal-title modal-title-danger">Props off</div>
        <div class="modal-body">
          <p>
            This sends motor commands to your flight controller. <b>Remove all propellers before testing.</b>
          </p>
          {fettec ? (
            <>
              <p class="modal-warning">
                FETtec passthrough puts the Betaflight FC into a raw serial pipe and drives the ESCs over the OneWire
                bus. MSP is unavailable until you disconnect. The FC holds its motor pins high during passthrough, so
                the ESCs may also see an FC pin signal.
              </p>
              <p class="modal-warning">
                FETtec ESCs stop after ~250 ms without throttle frames. A closed tab, crashed page or lost port stops
                the motors; the FC reboots when the port is released. Use the big STOP to ramp down.
              </p>
            </>
          ) : (
            <p class="modal-warning">
              ESC control is untested on this hardware. Motor commands are sent only on start, power change and stop —
              some ESCs and motor modes expect continuous frames and may behave unexpectedly. Use at your own risk.
            </p>
          )}
          <label class="checkbox-row">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged((event.target as HTMLInputElement).checked)}
            />
            <span>Props are removed and I accept the risk.</span>
          </label>
          <div class="modal-actions">
            <button class="btn btn-danger" disabled={!acknowledged} onClick={onConfirm}>
              {fettec ? "I understand — enable FETtec control" : "I understand — enable ESC control"}
            </button>
            <button class="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
