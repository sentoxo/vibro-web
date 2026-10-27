// "New version available — Reload" prompt (plan §6.17).

import { updateAvailable, applyUpdate, dismissUpdate } from "../pwa";

export function UpdatePrompt() {
  if (updateAvailable.value) {
    return (
      <div class="update-prompt" role="alert">
        <span>New version available. Reload to update.</span>
        <button class="btn btn-accent btn-small" onClick={applyUpdate}>
          Reload
        </button>
        <button class="btn btn-icon btn-small" aria-label="Dismiss update" onClick={dismissUpdate}>
          ×
        </button>
      </div>
    );
  }
  return null;
}
