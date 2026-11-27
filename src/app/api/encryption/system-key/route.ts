import { NextRequest, NextResponse } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { readBoundedBody } from '@/utils/http/boundedBody';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { getSystemSecret, markRecoveryKeySaved } from '@/utils/encryption/systemKey';

export const runtime = 'nodejs';

function json(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * The recovery key of FLUJO's system key (#1443). It opens every workspace of
 * this data folder, so it is shown only on this computer, only to an admin
 * when people sign in (see routeCapabilities), and only while unlocked.
 *
 * `{ action: 'reveal' }` returns it; `{ action: 'saved' }` records that the
 * owner keeps it somewhere safe, so Settings stops asking.
 */
async function POST_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request, { strictLoopback: true });
  if (notLocal) return notLocal;
  const locked = await assertUnlocked();
  if (locked) return locked;
  let action: unknown;
  try {
    const body: unknown = JSON.parse((await readBoundedBody(request, 256)).toString('utf8'));
    action = body && typeof body === 'object' ? (body as { action?: unknown }).action : undefined;
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  if (action === 'reveal') {
    const secret = await getSystemSecret().catch(() => null);
    if (!secret) return json({ error: 'This FLUJO keeps no key in the system store, so there is no recovery key.' }, 404);
    return json({ recoveryKey: secret });
  }
  if (action === 'saved') return json({ saved: await markRecoveryKeySaved() });
  return json({ error: 'Invalid action.' }, 400);
}

export const POST = withWorkspaceRoute(POST_handler);
