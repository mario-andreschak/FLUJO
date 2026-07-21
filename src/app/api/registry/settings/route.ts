/**
 * Registry base-URL settings (issue #197).
 *
 *   GET  -> { baseUrl, usingDefault, defaultUrl }
 *   POST -> { baseUrl }   (blank clears the override; validated as http(s) URL)
 *
 * No secrets here, but kept local-only + unlock-gated for parity with the rest
 * of the registry surface. NOT on the middleware public allow-list.
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { getSettings, saveSettings } from '@/backend/services/registry';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/registry/settings/route');

export async function GET() {
  const lock = await assertUnlocked();
  if (lock) return lock;
  try {
    return NextResponse.json(await getSettings());
  } catch (err) {
    log.error('Failed to read registry settings', err);
    return NextResponse.json({ error: 'Failed to read registry settings' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const baseUrl = typeof (body as Record<string, unknown>)?.baseUrl === 'string'
    ? ((body as Record<string, unknown>).baseUrl as string)
    : '';

  try {
    const result = await saveSettings(baseUrl);
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (err) {
    log.error('Failed to save registry settings', err);
    return NextResponse.json({ success: false, error: 'Failed to save registry settings' }, { status: 500 });
  }
}
