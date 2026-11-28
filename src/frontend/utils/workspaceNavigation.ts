export interface WorkspaceRouteRouter {
  push: (href: string) => void;
}

export interface WorkspaceRouteLocation {
  href: string;
  assign: (href: string) => void;
}

export interface WorkspaceRouteHistory {
  pushState: (data: unknown, unused: string, url: string) => void;
}

/**
 * Navigate inside the app without losing an explicit workspace page context.
 *
 * Next's same-page router transition can leave the address bar unchanged when
 * the current page was opened with `?workspace=...`: its private search state
 * advances, while `useSearchParams()` continues to see the old browser URL.
 *
 * - Another page, or another workspace: a normal same-origin navigation.
 *   WorkspaceBootstrap freezes and validates explicit workspace links before
 *   mounting data-bearing providers, so the reload is the safest ownership
 *   boundary.
 * - The same page in the same workspace (for example opening the editor on
 *   `/flows`): the browser's own `history.pushState`, which Next syncs with
 *   `useSearchParams()`. A reload here would throw away what only lives in the
 *   page, such as a new agent that is not saved yet.
 */
export function navigateWorkspaceRoute(
  router: WorkspaceRouteRouter,
  target: string,
  location: WorkspaceRouteLocation | undefined =
    typeof window === 'undefined' ? undefined : window.location,
  history: WorkspaceRouteHistory | undefined =
    typeof window === 'undefined' ? undefined : window.history,
): void {
  if (!location) {
    router.push(target);
    return;
  }

  const currentUrl = new URL(location.href);
  const targetUrl = new URL(target, currentUrl.origin);
  const currentPath = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
  const targetPath = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;

  if (currentPath === targetPath) return;
  if (currentUrl.searchParams.has('workspace')) {
    const samePage = currentUrl.pathname === targetUrl.pathname
      && currentUrl.searchParams.get('workspace') === targetUrl.searchParams.get('workspace');
    if (samePage && history) history.pushState(null, '', targetPath);
    else location.assign(targetPath);
    return;
  }
  router.push(targetPath);
}
