/**
 * Issue #216 — Docked, tabbed MCP Apps canvas surface (`pip` display mode).
 *
 * Pure, framework-free state helpers for the conversation-level canvas (the
 * docked surface rendered by `DevCanvasDock`). Kept side-effect-free and
 * framework-agnostic so the tab/LRU/cap logic is exhaustively unit-testable in
 * isolation (see `__tests__/chat/canvasState.test.ts`), mirroring the pattern of
 * `toolCallPairing.ts`.
 *
 * Identity of a canvas app is `serverName::uri` — no server-specific fields are
 * required (design principle #1 of the issue). Updates for an already-open key
 * feed the SAME live tab (`updateCanvasApp`); they never spawn a second entry.
 */

import { isBuiltInServerName } from '@/utils/shared/mcpConstants';

/** Default number of concurrently-live canvas tabs before LRU eviction. */
export const DEFAULT_CANVAS_TAB_CAP = 16;

/**
 * Cross-conversation consent scope granted for a canvas app. The security
 * boundary is the click-to-open gate; the scope records how far that grant
 * reaches. `undefined` means "this app, this conversation" (the implicit,
 * narrowest grant that opening the tab implies).
 */
export type CanvasConsentScope = 'server-conversation' | 'server-all' | 'all-all';

/** One docked canvas app, keyed by `serverName::uri`. */
export interface CanvasAppEntry {
  /** `${serverName}::${uri}` — the stable identity of this canvas app. */
  key: string;
  serverName: string;
  uri: string;
  /** Raw tool name that most recently fed this app (context/label only). */
  toolName?: string;
  /** JSON string of the latest tool arguments pushed to the app. */
  latestToolArgs?: string;
  /** JSON string / text of the latest tool result pushed to the app. */
  latestResultContent?: string;
  /** Cancellation outcome pushed instead of a result, when applicable. */
  latestToolCancelledReason?: string;
  /** Whether the latest completed tool invocation failed. */
  latestToolIsError?: boolean;
  /** Stable identity of the latest tool delivery, when the transcript has one. */
  latestToolUpdateId?: string | number;
  /** True when new data arrived while this tab was NOT active (badge). */
  unread: boolean;
  /** Drives LRU eviction; bumped whenever the tab is activated. */
  lastActiveAt: number;
  /**
   * Bumped on every live re-feed so a memoized child (McpAppFrame host) can
   * detect "same key, new data" and push it through the existing bridge without
   * a remount.
   */
  updatedAt: number;
  /** Recorded cross-conversation consent scope (if the user widened it). */
  consent?: CanvasConsentScope;
}

/** Conversation-level canvas state (held as React state in `Chat/index.tsx`). */
export interface CanvasState {
  /** Entries keyed by `serverName::uri`. */
  entries: Record<string, CanvasAppEntry>;
  /** Stable tab order (insertion order) so the tab strip does not reshuffle. */
  order: string[];
  /** Currently-focused tab, or null when the dock is empty. */
  activeKey: string | null;
}

/** An empty canvas (dock hidden). */
export const emptyCanvasState: CanvasState = { entries: {}, order: [], activeKey: null };

/** Build the stable identity key for a canvas app. */
export function canvasKey(serverName: string, uri: string): string {
  return `${serverName}::${uri}`;
}

/** Input describing a tool result that carries a `ui://` canvas app link. */
export interface CanvasAppInput {
  serverName: string;
  uri: string;
  toolName?: string;
  /** JSON string of the tool arguments. */
  toolArgs?: string;
  /** JSON string / text of the tool result content. */
  resultContent?: string;
  /** Cancellation outcome sent instead of `resultContent`. */
  cancelledReason?: string;
  /** Whether the completed invocation failed. */
  isError?: boolean;
  /** Stable identity for this invocation, even when its payload is unchanged. */
  updateId?: string | number;
}

/** Result of a mutation that may evict tabs (LRU cap enforcement). */
export interface CanvasMutationResult {
  state: CanvasState;
  /** Keys of tabs evicted by cap enforcement (caller must tear down bridges). */
  evicted: string[];
}

/** Sorted membership list in stable tab order. */
export function canvasEntries(state: CanvasState): CanvasAppEntry[] {
  return state.order
    .map((k) => state.entries[k])
    .filter((e): e is CanvasAppEntry => Boolean(e));
}

/** True when any tab has an unread (background-update) badge. */
export function hasUnread(state: CanvasState): boolean {
  return canvasEntries(state).some((e) => e.unread);
}

/**
 * Enforce the live-tab cap by evicting least-recently-active tabs. The
 * `protectKey` (typically the just-activated tab) is never evicted. Returns the
 * trimmed state plus the evicted keys so the caller can tear down their bridges
 * and LOG the eviction (issue requirement — never silently drop).
 */
export function enforceCap(
  state: CanvasState,
  cap: number = DEFAULT_CANVAS_TAB_CAP,
  protectKey?: string,
): CanvasMutationResult {
  const limit = Math.max(1, Math.floor(cap));
  if (state.order.length <= limit) return { state, evicted: [] };

  const entries = { ...state.entries };
  let order = [...state.order];
  const evicted: string[] = [];

  while (order.length > limit) {
    // Least-recently-active evictable key (never the protected/active tab).
    let victim: string | null = null;
    let victimAt = Infinity;
    for (const k of order) {
      if (k === protectKey) continue;
      const at = entries[k]?.lastActiveAt ?? 0;
      if (at < victimAt) {
        victimAt = at;
        victim = k;
      }
    }
    if (!victim) break; // only the protected tab left — cannot evict further
    delete entries[victim];
    order = order.filter((k) => k !== victim);
    evicted.push(victim);
  }

  let activeKey = state.activeKey;
  if (activeKey && !entries[activeKey]) {
    activeKey = order.length ? order[order.length - 1] : null;
  }
  return { state: { entries, order, activeKey }, evicted };
}

/**
 * Open (or re-open) a canvas app and FOCUS it. For external apps this is the
 * click-to-mount consent action; trusted first-party apps may reach it through
 * `syncCanvasAppResult`. It adds the entry if new, refreshes its payload, marks
 * it read, bumps its recency, and enforces the tab cap while protecting the
 * just-opened tab.
 */
export function openCanvasApp(
  state: CanvasState,
  input: CanvasAppInput,
  now: number = Date.now(),
  cap: number = DEFAULT_CANVAS_TAB_CAP,
): CanvasMutationResult {
  const key = canvasKey(input.serverName, input.uri);
  const existing = state.entries[key];
  const entry: CanvasAppEntry = {
    key,
    serverName: input.serverName,
    uri: input.uri,
    toolName: input.toolName ?? existing?.toolName,
    latestToolArgs: input.toolArgs ?? existing?.latestToolArgs,
    latestResultContent: input.cancelledReason !== undefined
      ? undefined
      : input.resultContent ?? existing?.latestResultContent,
    latestToolCancelledReason: input.cancelledReason !== undefined
      ? input.cancelledReason
      : input.resultContent !== undefined
        ? undefined
        : existing?.latestToolCancelledReason,
    latestToolIsError: input.cancelledReason !== undefined
      ? undefined
      : input.isError !== undefined
        ? input.isError
        : input.resultContent !== undefined
          ? false
          : existing?.latestToolIsError,
    latestToolUpdateId: input.updateId ?? existing?.latestToolUpdateId,
    unread: false,
    lastActiveAt: now,
    updatedAt: now,
    consent: existing?.consent,
  };
  const entries = { ...state.entries, [key]: entry };
  const order = existing ? state.order : [...state.order, key];
  const opened: CanvasState = { entries, order, activeKey: key };
  return enforceCap(opened, cap, key);
}

/**
 * Live re-feed for an ALREADY-OPEN canvas app (Phase 6). If the key is not
 * open, this is a no-op — new data for a not-yet-docked app is surfaced by the
 * bubble launcher, never auto-mounted. Feeding the ACTIVE tab updates silently;
 * feeding a BACKGROUND tab sets its unread badge. Never creates/evicts tabs and
 * never steals focus (owner decision #1: badge-only).
 */
export function updateCanvasApp(
  state: CanvasState,
  input: CanvasAppInput,
  now: number = Date.now(),
): CanvasState {
  const key = canvasKey(input.serverName, input.uri);
  const existing = state.entries[key];
  if (!existing) return state;

  const isActive = state.activeKey === key;
  const entry: CanvasAppEntry = {
    ...existing,
    toolName: input.toolName ?? existing.toolName,
    latestToolArgs: input.toolArgs ?? existing.latestToolArgs,
    latestResultContent: input.cancelledReason !== undefined
      ? undefined
      : input.resultContent ?? existing.latestResultContent,
    latestToolCancelledReason: input.cancelledReason !== undefined
      ? input.cancelledReason
      : input.resultContent !== undefined
        ? undefined
        : existing.latestToolCancelledReason,
    latestToolIsError: input.cancelledReason !== undefined
      ? undefined
      : input.isError !== undefined
        ? input.isError
        : input.resultContent !== undefined
          ? false
          : existing.latestToolIsError,
    latestToolUpdateId: input.updateId ?? existing.latestToolUpdateId,
    updatedAt: now,
    unread: isActive ? false : true,
    lastActiveAt: isActive ? now : existing.lastActiveAt,
  };
  return { ...state, entries: { ...state.entries, [key]: entry } };
}

/**
 * Route an observed tool result into the canvas.
 *
 * First-party apps shipped by FLUJO are trusted to mount directly in the PiP
 * canvas (#331), so their first result opens a tab without the click-to-mount
 * gate. Third-party apps remain consent-gated and are ignored until the user
 * explicitly opens them. Once any app is open, later results re-feed its
 * existing bridge as before.
 */
export function syncCanvasAppResult(
  state: CanvasState,
  input: CanvasAppInput,
  now: number = Date.now(),
  cap: number = DEFAULT_CANVAS_TAB_CAP,
): CanvasMutationResult {
  const key = canvasKey(input.serverName, input.uri);
  if (state.entries[key]) {
    return { state: updateCanvasApp(state, input, now), evicted: [] };
  }
  if (!isBuiltInServerName(input.serverName)) {
    return { state, evicted: [] };
  }
  return openCanvasApp(state, input, now, cap);
}

/** Focus a tab: mark it read and bump its recency (LRU). No-op if absent. */
export function setActiveCanvasTab(
  state: CanvasState,
  key: string,
  now: number = Date.now(),
): CanvasState {
  const existing = state.entries[key];
  if (!existing) return state;
  const entry: CanvasAppEntry = { ...existing, unread: false, lastActiveAt: now };
  return { ...state, entries: { ...state.entries, [key]: entry }, activeKey: key };
}

/** Clear the unread badge on a tab. No-op if absent or already read. */
export function markRead(state: CanvasState, key: string): CanvasState {
  const existing = state.entries[key];
  if (!existing || !existing.unread) return state;
  return {
    ...state,
    entries: { ...state.entries, [key]: { ...existing, unread: false } },
  };
}

/**
 * Close a tab (tears down its bridge, caller-side). If the closed tab was
 * active, focus falls to the most-recently-active surviving tab.
 */
export function closeCanvasApp(state: CanvasState, key: string): CanvasState {
  if (!state.entries[key]) return state;
  const entries = { ...state.entries };
  delete entries[key];
  const order = state.order.filter((k) => k !== key);

  let activeKey = state.activeKey;
  if (activeKey === key) {
    activeKey = null;
    let best = -Infinity;
    for (const k of order) {
      const at = entries[k]?.lastActiveAt ?? 0;
      if (at >= best) {
        best = at;
        activeKey = k;
      }
    }
  }
  return { entries, order, activeKey };
}
