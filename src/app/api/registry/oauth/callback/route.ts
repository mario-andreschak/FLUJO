import { withWorkspaceRoute } from '@/app/api/_workspace';
/**
 * OAuth provider callback for registry-account sign-in (issue #207).
 *
 *   GET ?code=...&state=...  (or ?error=...)  =>  302 /packages?registry_oauth=...
 *
 * This is the browser's top-level redirect target after the hosted registry
 * (#196) finishes the GitHub/Google round-trip, so it arrives CROSS-ORIGIN and
 * therefore must be on the middleware public allow-list (exact path only) and
 * must NOT call `assertLocalRequest`. It IS still unlock-gated: completing the
 * exchange stores encrypted tokens at rest.
 *
 * Security: the `state` is validated + consumed server-side (single-use) by the
 * service. No token value is ever returned in the response body — on success the
 * browser is redirected back to Packages, which re-fetches masked status.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { completeOAuth, pendingOAuthWorkspace } from '@/backend/services/registry';
import { createLogger } from '@/utils/logger';
import { runWithWorkspace, workspaceExists } from '@/utils/workspace';

const log = createLogger('app/api/registry/oauth/callback/route');

function redirectToPackages(
  request: NextRequest,
  outcome: 'success' | 'error',
  workspace?: string,
): NextResponse {
  const url = new URL('/packages', request.url);
  url.searchParams.set('registry_oauth', outcome);
  if (workspace) url.searchParams.set('workspace', workspace);
  return NextResponse.redirect(url);
}

async function GET_handler(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const state = searchParams.get('state') || '';
    const workspace = pendingOAuthWorkspace(state);
    if (!workspace || !(await workspaceExists(workspace))) {
      return redirectToPackages(request, 'error');
    }

    return runWithWorkspace(workspace, async () => {
      const lock = await assertUnlocked();
      if (lock) return lock as NextResponse;
      if (searchParams.get('error')) {
        log.warn('Registry OAuth provider returned an error.');
        return redirectToPackages(request, 'error', workspace);
      }

      const code = searchParams.get('code') || '';
      const result = await completeOAuth(code, state);
      return redirectToPackages(
        request,
        result.status === 'authenticated' ? 'success' : 'error',
        workspace,
      );
    });
  } catch (err) {
    log.error('Unexpected error in registry OAuth callback', err);
    return redirectToPackages(request, 'error');
  }
}

export const GET = withWorkspaceRoute(GET_handler);
