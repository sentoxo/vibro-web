// Non-blocking toast queue (plan §5.2). Replaces the desktop blocking
// lost-packets modal.

import { signal } from "@preact/signals";
import { logDebug } from "./debugLog";

export type ToastKind = "info" | "success" | "warn" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  dedupeKey?: string;
  ttlMs: number;
}

export const toasts = signal<Toast[]>([]);

let nextId = 1;

export function pushToast(toast: Omit<Toast, "id" | "ttlMs"> & { ttlMs?: number }): void {
  const ttlMs = toast.ttlMs ?? (toast.kind === "error" ? 8000 : 5000);
  if (toast.dedupeKey && toasts.peek().some((t) => t.dedupeKey === toast.dedupeKey)) {
    return; // already visible; do not spam
  }
  const level = toast.kind === "success" ? "info" : toast.kind;
  logDebug("toast", level, `${toast.title}: ${toast.message ?? ""}`.trim());
  const entry: Toast = { ...toast, id: nextId++, ttlMs };
  toasts.value = [...toasts.peek(), entry];
  if (ttlMs > 0) setTimeout(() => dismissToast(entry.id), ttlMs);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.peek().filter((t) => t.id !== id);
}

export function clearToasts(): void {
  toasts.value = [];
}
