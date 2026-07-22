import { assertLocalRequest } from '@/utils/http/localRequest';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { probeOAuthSupport } from '@/utils/mcp/oauthProbe';
import { json } from '../_helpers';

const log = createLogger('app/api/mcp/oauth-capability/route');

// Node runtime: probeOAuthSupport uses Node fetch + AbortSignal.timeout and reaches an
// arbitrary remote host, which the edge runtime restricts.
export const runtime = 'nodejs';

/**
 * POST /api/mcp/oauth-capability
 *
 * Best-effort check of whether a remote MCP endpoint advertises OAuth (RFC 9728), used by
 * the "Remote" tab to hint at OAuth before the user reaches the full configuration form.
 * Body: `{ serverUrl: string }`. Runs server-side (like test-connection) because the probe
 * reaches out to the remote host, so it must not be driven by cross-origin callers.
 */
export async function POST(request: NextRequest) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  // Gated like the rest of the add-server flow: probing is only reachable once unlocked.
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  let serverUrl: string | undefined;
  try {
    ({ serverUrl } = (await request.json()) as { serverUrl?: string });
  } catch (error) {
    log.error('Failed to parse request body', error);
    return json({ error: 'Invalid request body' }, 400);
  }

  if (!serverUrl || typeof serverUrl !== 'string') {
    return json({ error: 'Missing serverUrl' }, 400);
  }

  const result = await probeOAuthSupport(serverUrl);
  return json(result);
}
