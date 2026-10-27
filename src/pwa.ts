// Service-worker registration with an update prompt (plan §6.17).

import { signal } from "@preact/signals";
import { registerSW } from "virtual:pwa-register";

export const updateAvailable = signal(false);
export const offlineReady = signal(false);

let reload: (() => Promise<void>) | null = null;

export function registerPwa(): void {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      // v2 API: applying the update is the returned `updateSW` callback.
      reload = () => updateSW(true);
      updateAvailable.value = true;
    },
    onOfflineReady() {
      offlineReady.value = true;
    },
  });
}

export function applyUpdate(): void {
  void reload?.();
  updateAvailable.value = false;
}

export function dismissUpdate(): void {
  updateAvailable.value = false;
}
