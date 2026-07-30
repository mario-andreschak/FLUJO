import type { NextRequest } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { json } from '@/app/api/mcp/_helpers';

const log = createLogger('app/api/mcp/flujo/resources/read/route');

export async function POST(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;

  let body: { uri?: unknown };
  try {
    body = (await request.json()) as { uri?: unknown };
  } catch {
    return json({ error: 'Request body must be valid JSON.' }, 400);
  }
  const uri = typeof body.uri === 'string' ? body.uri.trim() : '';
  if (!uri || !uri.startsWith('flujo://run/')) {
    return json({ error: 'A valid flujo://run/ resource URI is required.' }, 400);
  }

  try {
    // internalReadResource performs the full URI parse, records readBy lineage,
    // and emits the resource:read event. Do not reproduce that logic here.
    const { internalReadResource } = await import('@/backend/services/mcp/internalResources');
    return json(await internalReadResource(uri), 200);
  } catch (error) {
    log.error('Failed to read internal run resource', {
      uri,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ error: 'Failed to read run resource.' }, 500);
  }
}
