// Non-blocking notifications with actions (plan §5.6).

import { toasts, dismissToast } from "../state/toasts";

export function ToastStack() {
  return (
    <div class="toast-stack" role="status" aria-live="polite">
      {toasts.value.map((toast) => (
        <div class={`toast toast-${toast.kind}`} key={toast.id}>
          <div class="toast-body">
            <div class="toast-title">{toast.title}</div>
            {toast.message && <div class="toast-message">{toast.message}</div>}
          </div>
          <div class="toast-actions">
            {toast.onAction && toast.actionLabel && (
              <button
                class="btn btn-small"
                onClick={() => {
                  toast.onAction?.();
                  dismissToast(toast.id);
                }}
              >
                {toast.actionLabel}
              </button>
            )}
            <button
              class="btn btn-icon btn-small"
              aria-label="Dismiss notification"
              onClick={() => dismissToast(toast.id)}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
