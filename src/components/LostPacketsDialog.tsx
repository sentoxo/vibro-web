// One-time "lost packets detected" modal, desktop parity: shown the first
// time seq gaps appear in a session; the app keeps running (plan D4).

export function LostPacketsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Lost packets detected">
      <div class="modal">
        <div class="modal-title">Lost packets detected</div>
        <div class="modal-body">
          <p>Some sensor packets were lost during the connection.</p>
          <p class="modal-warning">
            The app keeps running normally. This usually means the serial connection dropped or is too slow. Check the
            cable and USB port.
          </p>
          <div class="modal-actions">
            <button class="btn btn-accent" autoFocus onClick={onClose}>
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
