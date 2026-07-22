/**
 * OAuth provider callback for registry-account sign-in (issue #207).
 *
 *   GET ?code=...&state=...  (or ?error=...)  =>  302 /settings?registry_oauth=...
 *
 * This is the browser's top-level redirect target after the hosted registry
 * (#196) finishes the GitHub/Google round-trip, so it arrives CROSS-ORIGIN and
 * therefore must be on the middleware public allow-list (exact path only) and
 * must NOT call `assertLocalRequest`. It IS still unlock-gated: completing the
 * exchange stores encrypted tokens at rest.
 *
 * Security: the `state` is validated + consumed server-side (single-use) by the
 * service. No token value is ever returned in the response body — on success the
 * browser is redirected back to Settings, which re-fetches masked status.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { completeOAuth } from '@/backend/services/registry';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/registry/oauth/callback/route');

function redirectToSettings(request: NextRequest, outcome: 'success' | 'error'): NextResponse {
  return NextResponse.redirect(new URL(`/settings?registry_oauth=${outcome}`, request.url));
}

export async function GET(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;

  try {
    const { searchParams } = new URL(request.url);
    if (searchParams.get('error')) {
      log.warn('Registry OAuth provider returned an error.');
      return redirectToSettings(request, 'error');
    }

    const code = searchParams.get('code') || '';
    const state = searchParams.get('state') || '';
    const result = await completeOAuth(code, state);
    return redirectToSettings(request, result.status === 'authenticated' ? 'success' : 'error');
  } catch (err) {
    log.error('Unexpected error in registry OAuth callback', err);
    return redirectToSettings(request, 'error');
  }
}
