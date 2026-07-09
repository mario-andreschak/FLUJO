"use client";

/**
 * Frontend side of issue #77 (Stage 2/4 of the #16 custom-encryption fix).
 *
 * The backend returns HTTP 423 `{ "error": "encryption_locked" }` on every gated
 * route while FLUJO is in USER encryption mode and not yet unlocked. This module
 * installs a one-time global `fetch` wrapper that watches for those 423 responses
 * and routes the user back to the lock screen — no matter which part of the app
 * made the call — by clearing the UI auth flag and dispatching a window event
 * that `EncryptionAuthDialog` listens for.
 */

export const ENCRYPTION_LOCKED_EVENT = 'flujo:encryption-locked';
/**
 * Dispatched (by `EncryptionAuthDialog`) after the user successfully unlocks
 * USER-mode encryption. Consumers that fell back to defaults while the backend
 * was locked (returning 423) — e.g. `StorageContext` settings hydration — can
 * listen for this to re-read their data now that gated routes will succeed.
 */
export const ENCRYPTION_UNLOCKED_EVENT = 'flujo:encryption-unlocked';
export const LOCKED_ERROR_CODE = 'encryption_locked';

let installed = false;

/** Clear the UI auth flags and signal the lock screen to re-open. */
function handleLocked(): void {
  try {
    sessionStorage.removeItem('encryption_authenticated');
    sessionStorage.removeItem('encryption_token');
  } catch {
    /* sessionStorage may be unavailable; ignore */
  }
  window.dispatchEvent(new CustomEvent(ENCRYPTION_LOCKED_EVENT));
}

/**
 * Install the global 423 interceptor. Idempotent and a no-op on the server.
 */
export function installEncryptionLockInterceptor(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') {
    return;
  }
  installed = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const response = await originalFetch(...args);
    if (response.status === 423) {
      handleLocked();
    }
    return response;
  };
}
