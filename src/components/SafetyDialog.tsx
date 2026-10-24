// Props-off confirmation before any motor command (plan §5.6, D13).

import { useState } from "preact/compat";

export function SafetyDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="ESC safety warning">
      <div class="modal modal-danger">
        <div class="modal-title modal-title-danger">Props off</div>
        <div class="modal-body">
          <p>
            This sends motor commands to your flight controller. <b>Remove all propellers before testing.</b>
          </p>
          <p class="modal-warning">
            ESC control is untested on this hardware. Motor commands are sent only on start, power change and stop —
            some ESCs and motor modes expect continuous frames and may behave unexpectedly. Use at your own risk.
          </p>
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
              I understand — enable ESC control
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
