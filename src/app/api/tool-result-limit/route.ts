import { NextResponse } from 'next/server';
import { getRunResourceSettings, updateToolResultLimitSettings } from '@/backend/services/runResources';
import { toolResultLimitSettings, validateToolResultLimitPatch } from '@/shared/toolResultLimit';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { withWorkspaceRoute } from '@/app/api/_workspace';

export const runtime = 'nodejs';

const log = createLogger('app/api/tool-result-limit/route');

/** The tool result size limit shown in Settings (issue #1226). */
async function GET_handler(request: Request) {
  const locked = await assertUnlocked();
  if (locked) return locked;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  return NextResponse.json({ settings: toolResultLimitSettings(await getRunResourceSettings()) });
}

/** Change some of: on/off, 'auto'/'custom', custom bytes, line limit. */
async function PATCH_handler(request: Request) {
  const locked = await assertUnlocked();
  if (locked) return locked;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid-body' }, { status: 400 });
  }
  const validation = validateToolResultLimitPatch(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error, field: validation.field }, { status: 400 });
  }
  try {
    const saved = await updateToolResultLimitSettings(validation.patch);
    return NextResponse.json({ settings: toolResultLimitSettings(saved) });
  } catch (error) {
    log.error('Could not save the tool result size limit', error);
    return NextResponse.json({ error: 'save-failed' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const PATCH = withWorkspaceRoute(PATCH_handler);
