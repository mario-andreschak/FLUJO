export interface WorkspaceRouteRouter {
  push: (href: string) => void;
}

export interface WorkspaceRouteLocation {
  href: string;
  assign: (href: string) => void;
}

/**
 * Navigate inside the app without losing an explicit workspace page context.
 *
 * Next's same-page router transition can leave the address bar unchanged when
 * the current page was opened with `?workspace=...`: its private search state
 * advances, while `useSearchParams()` continues to see the old browser URL.
 * Use a normal same-origin navigation for that case. WorkspaceBootstrap is
 * designed to freeze and validate explicit workspace links before mounting
 * data-bearing providers, so the reload is also the safest ownership boundary.
 */
export function navigateWorkspaceRoute(
  router: WorkspaceRouteRouter,
  target: string,
  location: WorkspaceRouteLocation | undefined =
    typeof window === 'undefined' ? undefined : window.location,
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
    location.assign(targetPath);
    return;
  }
  router.push(targetPath);
}
