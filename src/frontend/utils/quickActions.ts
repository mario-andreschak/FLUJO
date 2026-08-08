/**
 * Quick-actions intents (#396).
 *
 * The bottom-left quick-actions menu lives in `Navigation`, but the work it
 * triggers belongs to feature pages that own the established flows:
 *
 * - `New Chat` must go through `Chat`'s existing `createNewConversation`
 *   (flow-selection priority, conversation list/current/detail updates and
 *   error handling included) rather than re-implementing the POST.
 * - `MCP App` must go through the existing MCP Apps dashboard / Tool Tester on
 *   `/mcp` rather than reading or invoking anything itself.
 *
 * Two transports are needed because a page can be either *not mounted yet*
 * (the menu was used from another route) or *already on screen* (the menu was
 * used while the target page is mounted, where a `router.push` of the same
 * pathname does not remount anything):
 *
 * - a one-shot **route intent** (`/chat?new=<token>`, `/mcp?app=…`) consumed on
 *   mount, and
 * - a one-shot **window event** for the already-mounted case.
 *
 * Both funnel through {@link consumeQuickActionToken}, so a request is honored
 * exactly once even if both transports were to reach the same page (React
 * Strict Mode double effects, Back/Forward replay, a failed URL cleanup, …).
 */

export const NEW_CHAT_PARAM = 'new';
export const MCP_APP_PARAM = 'app';
export const MCP_APP_URI_PARAM = 'appUri';
/** Param carrying the one-shot token of an `?app=` route intent. */
export const MCP_APP_TOKEN_PARAM = 'appToken';

export const NEW_CHAT_EVENT = 'flujo:quick-action-new-chat';
export const OPEN_MCP_APP_EVENT = 'flujo:quick-action-open-mcp-app';

/** Target of an `MCP App` quick action: an app to preview, or a linked tool. */
export interface McpAppQuickAction {
  serverName: string;
  /** `ui://…` resource of the app to preselect in the MCP Apps dashboard. */
  uri?: string;
  /** Linked tool to open in the existing Tool Tester (never invoked here). */
  toolName?: string;
}

/** A concrete app View that the persistent app-shell host can start directly. */
export interface GlobalMcpAppLaunchRequest extends McpAppQuickAction {
  /** Global launch always targets a discovered app resource, never Tool Tester. */
  uri: string;
}

// The app-shell host is loaded asynchronously. Keep a small bounded queue so a
// click made before its effect subscribes is replayed instead of disappearing.
const GLOBAL_LAUNCH_QUEUE_LIMIT = 32;
const pendingGlobalLaunches: GlobalMcpAppLaunchRequest[] = [];
const globalLaunchHandlers = new Set<(request: GlobalMcpAppLaunchRequest) => void>();

/**
 * Bounded FIFO of already-honored tokens. Bounded because the page can live for
 * a long time and every quick action mints a new token; 100 is far more than
 * the number of transports (2) that can race for the same one.
 */
const CONSUMED_LIMIT = 100;
const consumedTokens = new Set<string>();
const consumedOrder: string[] = [];

/** Mints a token identifying one user request (one click). */
export function createQuickActionToken(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `qa-${Date.now().toString(36)}-${random}`;
}

/** True when `token` looks like a token that has not been honored yet. */
export function isQuickActionTokenPending(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.length > 0 && !consumedTokens.has(token);
}

/**
 * Claims a token. Returns true for the first caller only, so a request that
 * arrives over both transports still produces exactly one conversation / one
 * dashboard open.
 */
export function consumeQuickActionToken(token: string | null | undefined): boolean {
  if (!isQuickActionTokenPending(token)) return false;
  const claimed = token as string;
  consumedTokens.add(claimed);
  consumedOrder.push(claimed);
  while (consumedOrder.length > CONSUMED_LIMIT) {
    const evicted = consumedOrder.shift();
    if (evicted) consumedTokens.delete(evicted);
  }
  return true;
}

/** Route intent for `New Chat` when the chat page is not mounted yet. */
export function newChatPath(token: string): string {
  return `/chat?${NEW_CHAT_PARAM}=${encodeURIComponent(token)}`;
}

/** Route intent that opens the MCP Apps dashboard on a specific app. */
export function mcpAppPath(request: McpAppQuickAction, token: string): string {
  // A linked tool reuses the pre-existing one-shot tool-tester deep link
  // (`?server=&tool=`) that `MCPServerManager` already consumes, so quick
  // actions add no second tool path (and no invocation path at all).
  if (request.toolName) {
    return `/mcp?server=${encodeURIComponent(request.serverName)}&tool=${encodeURIComponent(request.toolName)}`;
  }
  const params = new URLSearchParams({ [MCP_APP_PARAM]: request.serverName });
  if (request.uri) params.set(MCP_APP_URI_PARAM, request.uri);
  params.set(MCP_APP_TOKEN_PARAM, token);
  return `/mcp?${params.toString()}`;
}

function emit<T>(name: string, detail: T): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<T>(name, { detail }));
}

function subscribe<T>(name: string, handler: (detail: T) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event) => handler((event as CustomEvent<T>).detail);
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}

export function emitNewChatRequest(token: string): void {
  emit(NEW_CHAT_EVENT, { token });
}

export function subscribeNewChatRequests(handler: (token: string) => void): () => void {
  return subscribe<{ token?: string } | undefined>(NEW_CHAT_EVENT, (detail) => {
    if (detail?.token) handler(detail.token);
  });
}

export function emitOpenMcpApp(request: McpAppQuickAction, token: string): void {
  emit(OPEN_MCP_APP_EVENT, { ...request, token });
}

export function subscribeOpenMcpApp(
  handler: (request: McpAppQuickAction, token: string) => void,
): () => void {
  return subscribe<(McpAppQuickAction & { token?: string }) | undefined>(
    OPEN_MCP_APP_EVENT,
    (detail) => {
      if (!detail?.serverName || !detail.token) return;
      const { token, ...request } = detail;
      handler(request, token);
    },
  );
}

/** Start/focus an MCP App in the persistent app-shell surface. */
export function emitLaunchGlobalMcpApp(request: GlobalMcpAppLaunchRequest): void {
  if (globalLaunchHandlers.size === 0) {
    pendingGlobalLaunches.push(request);
    while (pendingGlobalLaunches.length > GLOBAL_LAUNCH_QUEUE_LIMIT) pendingGlobalLaunches.shift();
    return;
  }
  for (const handler of globalLaunchHandlers) handler(request);
}

/** Subscribe from the single app-shell owner of globally running MCP Apps. */
export function subscribeLaunchGlobalMcpApp(
  handler: (request: GlobalMcpAppLaunchRequest) => void,
): () => void {
  globalLaunchHandlers.add(handler);
  if (pendingGlobalLaunches.length > 0) {
    const pending = pendingGlobalLaunches.splice(0, pendingGlobalLaunches.length);
    for (const request of pending) handler(request);
  }
  return () => globalLaunchHandlers.delete(handler);
}
