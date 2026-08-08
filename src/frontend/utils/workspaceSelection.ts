"use client";

/**
 * Client-side workspace selection (#406).
 *
 * Three responsibilities, deliberately kept in one small module so there is a
 * single source of truth for "which workspace is the UI looking at":
 *
 *  1. Persist the selection per browser (SSR-safe, synchronous, same
 *     `flujo-` localStorage convention as useUiPreference).
 *  2. Attach the selection to every same-origin API request, by wrapping
 *     `window.fetch` the same way the encryption-lock interceptor does. Doing it
 *     centrally is what makes "every workspace-sensitive client request includes
 *     the selection" true by construction instead of by 200 call-site edits that
 *     one future feature will forget.
 *  3. Notify subscribers when the selection changes, so views can drop the
 *     previous workspace's data instead of showing it under the new tab.
 */

export const DEFAULT_WORKSPACE = 'default-workspace';
export const WORKSPACE_STORAGE_KEY = 'flujo-ui:workspace';
export const WORKSPACE_CHANGED_EVENT = 'flujo:workspace-changed';
export const WORKSPACE_QUERY_PARAM = 'workspace';

const WORKSPACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Mirrors the server-side allowlist so a corrupted preference can't be sent. */
export function isValidWorkspaceName(value: unknown): value is string {
  return typeof value === 'string' && WORKSPACE_NAME_PATTERN.test(value);
}

/**
 * The selected workspace, read synchronously so the first render already has the
 * right value (no flash of the default workspace's data). Falls back to the
 * default on the server, on a missing/corrupt entry, or in private mode.
 */
export function getSelectedWorkspace(): string {
  if (typeof window === 'undefined') return DEFAULT_WORKSPACE;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    return isValidWorkspaceName(raw) ? raw : DEFAULT_WORKSPACE;
  } catch {
    return DEFAULT_WORKSPACE;
  }
}

/**
 * Persist and broadcast a new selection. Invalid names are ignored rather than
 * stored, so a bad value can never wedge the UI on an unusable workspace.
 */
export function setSelectedWorkspace(workspace: string): void {
  if (typeof window === 'undefined' || !isValidWorkspaceName(workspace)) return;
  try {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, workspace);
  } catch {
    /* a workspace selection we can't persist is still usable this session */
  }
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_CHANGED_EVENT, { detail: { workspace } }),
  );
}

/** Subscribe to selection changes. Returns an unsubscribe function. */
export function onWorkspaceChanged(listener: (workspace: string) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ workspace?: string }>).detail;
    listener(detail?.workspace ?? getSelectedWorkspace());
  };
  window.addEventListener(WORKSPACE_CHANGED_EVENT, handler);
  return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, handler);
}

let installed = false;

/**
 * Which requests carry the workspace: same-origin `/api/...` and `/v1/...`
 * calls. Cross-origin requests (model providers, the MCP registry) must never
 * receive FLUJO's internal workspace name, and static assets don't care.
 */
function shouldAnnotate(url: URL): boolean {
  if (typeof window === 'undefined') return false;
  if (url.origin !== window.location.origin) return false;
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/');
}

function resolveUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === 'string') return new URL(input, window.location.href);
    if (input instanceof URL) return input;
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return new URL(input.url, window.location.href);
    }
  } catch {
    /* opaque or malformed URL: leave the request untouched */
  }
  return null;
}

/**
 * Install the workspace fetch interceptor. Idempotent, and a no-op on the
 * server. An explicit `?workspace=` supplied by the caller always wins, so a
 * component that deliberately targets another workspace is never overridden.
 */
export function installWorkspaceInterceptor(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') {
    return;
  }
  installed = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const workspace = getSelectedWorkspace();
    // The default workspace is the server's default too, so leaving the
    // parameter off keeps request URLs (and any HTTP caching keyed on them)
    // exactly as they were before workspaces existed.
    if (workspace === DEFAULT_WORKSPACE) return originalFetch(input, init);

    const url = resolveUrl(input);
    if (!url || !shouldAnnotate(url) || url.searchParams.has(WORKSPACE_QUERY_PARAM)) {
      return originalFetch(input, init);
    }

    url.searchParams.set(WORKSPACE_QUERY_PARAM, workspace);
    if (typeof Request !== 'undefined' && input instanceof Request) {
      // Rebuild the Request so body/method/headers/signal survive the rewrite.
      return originalFetch(new Request(url.toString(), input), init);
    }
    return originalFetch(url.toString(), init);
  };
}

/**
 * Deterministic tab colors. Must stay in sync with `workspaceColor` in
 * `src/utils/workspace.ts` — the server sends the color in /api/workspaces, but
 * this keeps the UI correct before that response lands.
 */
export const WORKSPACE_COLORS = [
  '#6656E8',
  '#10A8C3',
  '#2E9E5B',
  '#D2761B',
  '#C2417E',
  '#7A57C9',
  '#1F86D0',
  '#B4453A',
] as const;

export function workspaceColor(workspace: string): string {
  if (workspace === DEFAULT_WORKSPACE) return WORKSPACE_COLORS[0];
  let hash = 0x811c9dc5;
  for (let i = 0; i < workspace.length; i++) {
    hash ^= workspace.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return WORKSPACE_COLORS[hash % WORKSPACE_COLORS.length];
}

export interface WorkspaceInfo {
  name: string;
  color: string;
  isDefault: boolean;
}
