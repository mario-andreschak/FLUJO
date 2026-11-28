import type { EventStreamHandlers } from '@/frontend/services/chat';

const FALLBACK_REFRESH_MS = 30_000;
const EVENT_DEBOUNCE_MS = 200;
const MIN_EVENT_REFRESH_MS = 5_000;
const RECONNECT_AFTER_RESET_MS = 3_000;

export interface SidebarRefreshOptions {
  /** Reloads the conversation list without a loading state. */
  refresh: () => Promise<unknown>;
  /** Opens the server's sidebar lifecycle stream. */
  subscribe: (handlers: EventStreamHandlers) => { close(): void };
}

/**
 * Keeps the sidebar live from the server's filtered global lifecycle stream.
 * A slow timeout remains as a safety net for non-execution changes (for
 * example, another tab creating or renaming an idle conversation). Unlike an
 * interval, it schedules only after the previous request settles, and all
 * refreshes pause while the tab is hidden. Returns the function that stops it.
 */
export function startSidebarRefresh({ refresh, subscribe }: SidebarRefreshOptions): () => void {
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let eventTimer: ReturnType<typeof setTimeout> | null = null;
  let sidebarEvents: { close(): void } | null = null;
  let disposed = false;
  let lastRefreshStartedAt = 0;

  const clearTimers = () => {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    if (eventTimer) clearTimeout(eventTimer);
    fallbackTimer = null;
    eventTimer = null;
  };
  const scheduleFallback = () => {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    if (disposed || document.visibilityState !== 'visible') return;
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      lastRefreshStartedAt = Date.now();
      void refresh().finally(scheduleFallback);
    }, FALLBACK_REFRESH_MS);
  };
  const refreshFromEvent = () => {
    if (disposed || document.visibilityState !== 'visible') return;
    // One scheduled refresh represents every lifecycle event in its window.
    // This preserves the old five-second worst-case cadence under a large
    // subflow queue instead of turning each child start/done into a scan.
    if (eventTimer) return;
    const sinceLastRefresh = Date.now() - lastRefreshStartedAt;
    const delay = Math.max(EVENT_DEBOUNCE_MS, MIN_EVENT_REFRESH_MS - sinceLastRefresh);
    eventTimer = setTimeout(() => {
      eventTimer = null;
      lastRefreshStartedAt = Date.now();
      void refresh().finally(scheduleFallback);
    }, delay);
  };
  const connect = () => {
    if (sidebarEvents || disposed || document.visibilityState !== 'visible') return;
    sidebarEvents = subscribe({
      onEvent: refreshFromEvent,
      onReset: () => {
        if (disposed) return;
        clearTimers();
        disconnect();
        lastRefreshStartedAt = Date.now();
        void refresh().finally(() => {
          if (disposed || document.visibilityState !== 'visible' || sidebarEvents) return;
          eventTimer = setTimeout(() => { eventTimer = null; connect(); scheduleFallback(); }, RECONNECT_AFTER_RESET_MS);
        });
      },
    });
  };
  const disconnect = () => {
    sidebarEvents?.close();
    sidebarEvents = null;
  };
  const onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') {
      clearTimers();
      disconnect();
      return;
    }
    connect();
    lastRefreshStartedAt = Date.now();
    void refresh().finally(scheduleFallback);
  };

  lastRefreshStartedAt = Date.now(); // the chat screen just started the initial list load
  connect();
  scheduleFallback();
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    disposed = true;
    clearTimers();
    disconnect();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
