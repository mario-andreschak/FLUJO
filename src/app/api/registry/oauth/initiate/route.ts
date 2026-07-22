/**
 * Begin OAuth provider sign-in for a registry account (issue #207).
 *
 *   POST -> { provider: 'github' | 'google' }  =>  { authorizationUrl }
 *
 * The browser then navigates to `authorizationUrl` (the hosted registry, #196,
 * brokers the GitHub/Google flow). State + PKCE are stashed server-side by the
 * service; the browser only receives the authorize URL, never a token.
 *
 * Local-only + unlock-gated (mints/stores secrets at rest). NOT on the public
 * allow-list — this is triggered from the local Settings UI, unlike the callback.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { beginOAuth } from '@/backend/services/registry';
import { isRegistryOAuthProvider } from '@/shared/types/registry';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/registry/oauth/initiate/route');

export async function POST(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Empty/invalid body -> treated as a missing provider below.
  }
  const provider = (body as Record<string, unknown>)?.provider;
  if (!isRegistryOAuthProvider(provider)) {
    return NextResponse.json({ error: "provider must be 'github' or 'google'" }, { status: 400 });
  }

  try {
    const redirectUri = `${new URL(request.url).origin}/api/registry/oauth/callback`;
    const { authorizationUrl } = await beginOAuth(provider, redirectUri);
    return NextResponse.json({ authorizationUrl });
  } catch (err) {
    log.error('Failed to initiate registry OAuth sign-in', err);
    return NextResponse.json({ error: 'Failed to initiate OAuth sign-in' }, { status: 500 });
  }
}
