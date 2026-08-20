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
const WINDOWS_RESERVED_WORKSPACE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Workspace owned by the UI currently mounted in THIS browsing context.
 *
 * localStorage is shared by every tab. It is useful as the preference for the
 * next page load, but it must never be the live request-routing authority: tab
 * B changing that preference while tab A is still rendering A-owned ids would
 * otherwise retag A's next fetch as B. WorkspaceBootstrap freezes this value
 * before any data-bearing provider mounts and a real navigation replaces it.
 */
let activeWorkspace: string | null = null;

/** Mirrors the server-side allowlist so a corrupted preference can't be sent. */
export function isValidWorkspaceName(value: unknown): value is string {
  return typeof value === 'string'
    && WORKSPACE_NAME_PATTERN.test(value)
    && !WINDOWS_RESERVED_WORKSPACE_NAME.test(value);
}

/**
 * The tab-local active workspace, read synchronously so the first render already
 * has the right value (no flash of the default workspace's data). Before
 * initialization it falls back to the persisted preference, or to default on
 * the server, for a missing/corrupt entry, or in private mode.
 */
export function getSelectedWorkspace(): string {
  if (typeof window === 'undefined') return DEFAULT_WORKSPACE;
  if (activeWorkspace) return activeWorkspace;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    return isValidWorkspaceName(raw) ? raw : DEFAULT_WORKSPACE;
  } catch {
    return DEFAULT_WORKSPACE;
  }
}

/**
 * Add an explicit workspace query parameter to a URL. Unlike the fetch
 * interceptor this is also used for URLs that escape the page (EventSource,
 * clipboard values, OAuth redirects and external MCP configs), so it always
 * writes the workspace — including default-workspace — to keep the link stable.
 */
export function withWorkspaceUrl(
  input: string,
  workspace: string = getSelectedWorkspace(),
): string {
  if (!isValidWorkspaceName(workspace)) workspace = DEFAULT_WORKSPACE;
  const absolute = /^[A-Za-z][A-Za-z\d+.-]*:/.test(input) || input.startsWith('//');
  try {
    const base = typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost';
    const url = new URL(input, base);
    url.searchParams.set(WORKSPACE_QUERY_PARAM, workspace);
    return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return input;
  }
}

export type WorkspacePageRequest =
  | { kind: 'none' }
  | { kind: 'valid'; workspace: string }
  | { kind: 'invalid'; raw: string };

/**
 * Read workspace intent from the browser's top-level page URL. This is used
 * only by WorkspaceBootstrap; API/fetch URLs must never change UI selection.
 */
export function readWorkspacePageRequest(
  href: string = typeof window !== 'undefined' ? window.location.href : 'http://localhost/',
): WorkspacePageRequest {
  try {
    const values = new URL(href, 'http://localhost').searchParams.getAll(WORKSPACE_QUERY_PARAM);
    if (values.length === 0) return { kind: 'none' };
    if (values.length !== 1 || !isValidWorkspaceName(values[0])) {
      return { kind: 'invalid', raw: values.join(',') };
    }
    return { kind: 'valid', workspace: values[0] };
  } catch {
    return { kind: 'invalid', raw: '' };
  }
}

/** Preserve the current deep link while changing its authoritative workspace. */
export function workspacePageUrl(
  workspace: string,
  href: string = typeof window !== 'undefined' ? window.location.href : 'http://localhost/',
): string {
  const safeWorkspace = isValidWorkspaceName(workspace) ? workspace : DEFAULT_WORKSPACE;
  const url = new URL(href, 'http://localhost');
  url.searchParams.set(WORKSPACE_QUERY_PARAM, safeWorkspace);
  return url.toString();
}

/** Workspace-specific browser-storage key for content or secret state. */
export function workspaceStorageKey(key: string): string {
  return `${key}:${getSelectedWorkspace()}`;
}

export const workspaceSessionKey = workspaceStorageKey;
export const workspaceLocalStorageKey = workspaceStorageKey;

/** Prefix form for families discovered by legacy-key prefix scans. */
export function workspacePrefixedStorageKey(key: string): string {
  return `flujo-workspace:${getSelectedWorkspace()}:${key}`;
}

/**
 * Persist and broadcast the preference for the next navigation. This deliberately
 * does not mutate the mounted tab's active request workspace. Invalid names are
 * ignored rather than stored, so a bad value cannot wedge the UI.
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
let storageListenerInstalled = false;
let repairedCorruptSelection = false;
let fetchBeforeWorkspaceInterceptor: typeof window.fetch | null = null;
let workspaceFetchInterceptor: typeof window.fetch | null = null;
let workspaceStorageListener: ((event: StorageEvent) => void) | null = null;

/**
 * Which requests carry the workspace: same-origin `/api/...` and `/v1/...`
 * calls. Cross-origin requests (model providers, the MCP registry) must never
 * receive FLUJO's internal workspace name, and static assets don't care.
 */
function shouldAnnotate(url: URL): boolean {
  if (typeof window === 'undefined') return false;
  if (url.origin !== window.location.origin) return false;
  return url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/v1/')
    || url.pathname === '/mcp-flows'
    || url.pathname.startsWith('/mcp-proxy/');
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

  fetchBeforeWorkspaceInterceptor = window.fetch;
  const originalFetch = fetchBeforeWorkspaceInterceptor.bind(window);
  workspaceFetchInterceptor = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const workspace = getSelectedWorkspace();
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
  window.fetch = workspaceFetchInterceptor;
}

/**
 * Resolve where a tab should navigate after another tab changes the persisted
 * preference. The active workspace is passed explicitly for deterministic
 * tests; in production it is the frozen workspace of the currently mounted UI.
 */
export function workspaceStorageNavigationUrl(
  storedValue: string | null,
  currentWorkspace: string = getSelectedWorkspace(),
  href: string = typeof window !== 'undefined' ? window.location.href : 'http://localhost/',
): string | null {
  const nextWorkspace = isValidWorkspaceName(storedValue)
    ? storedValue
    : DEFAULT_WORKSPACE;
  return nextWorkspace === currentWorkspace
    ? null
    : workspacePageUrl(nextWorkspace, href);
}

/**
 * Install all browser-side workspace guards before any data provider mounts.
 * The URL wins for a deep link and is frozen as this tab's active request
 * workspace. Corrupt localStorage is repaired synchronously when there is no
 * URL override. A native `storage` event is emitted only in *other* tabs; those
 * tabs navigate to a URL that agrees with the new preference while their old
 * UI keeps routing requests to its frozen workspace until unload.
 */
export function initializeWorkspaceSelection(): { repaired: boolean } {
  if (typeof window === 'undefined') return { repaired: false };

  const pageRequest = readWorkspacePageRequest();
  let storedWorkspace = DEFAULT_WORKSPACE;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (isValidWorkspaceName(raw)) {
      storedWorkspace = raw;
    } else if (raw !== null && pageRequest.kind !== 'valid') {
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, DEFAULT_WORKSPACE);
      repairedCorruptSelection = true;
    }
  } catch {
    /* URL/default selection remains usable when localStorage is unavailable. */
  }

  if (activeWorkspace === null) {
    activeWorkspace = pageRequest.kind === 'valid'
      ? pageRequest.workspace
      : storedWorkspace;
  }

  installWorkspaceInterceptor();
  if (!storageListenerInstalled) {
    storageListenerInstalled = true;
    workspaceStorageListener = (event: StorageEvent) => {
      if (event.key !== WORKSPACE_STORAGE_KEY || event.oldValue === event.newValue) return;
      if (event.storageArea) {
        try {
          if (event.storageArea !== window.localStorage) return;
        } catch {
          // A privacy/security policy may block the localStorage getter. There
          // is no trustworthy shared preference to follow in that environment.
          return;
        }
      }
      const destination = workspaceStorageNavigationUrl(event.newValue);
      if (destination) window.location.assign(destination);
    };
    window.addEventListener('storage', workspaceStorageListener);
  }

  const repaired = repairedCorruptSelection;
  repairedCorruptSelection = false;
  return { repaired };
}

/** Test seam for the module-level browsing-context guards. */
export function __resetWorkspaceSelectionForTests(): void {
  activeWorkspace = null;
  repairedCorruptSelection = false;
  if (typeof window === 'undefined') return;
  if (workspaceStorageListener) {
    window.removeEventListener('storage', workspaceStorageListener);
  }
  workspaceStorageListener = null;
  storageListenerInstalled = false;
  if (
    workspaceFetchInterceptor
    && fetchBeforeWorkspaceInterceptor
    && window.fetch === workspaceFetchInterceptor
  ) {
    window.fetch = fetchBeforeWorkspaceInterceptor;
  }
  workspaceFetchInterceptor = null;
  fetchBeforeWorkspaceInterceptor = null;
  installed = false;
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
  roots: string[];
}
