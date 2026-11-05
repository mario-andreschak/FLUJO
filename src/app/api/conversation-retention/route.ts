import { NextResponse } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import {
  getConversationRetentionStatus,
  runConversationRetention,
} from '@/backend/services/conversations/retention';
import {
  isValidRetentionDays,
  type ConversationRetentionSettings,
} from '@/shared/types/conversationRetention';

export const runtime = 'nodejs';

/** Current settings and the last results. Counts only. */
async function GET_handler(request: Request) {
  const locked = await assertUnlocked();
  if (locked) return locked;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  return NextResponse.json(await getConversationRetentionStatus(), { headers: { 'Cache-Control': 'no-store' } });
}

function parseTrySettings(value: unknown): ConversationRetentionSettings | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const { days, precedence } = value as Record<string, unknown>;
  if (days !== undefined && !isValidRetentionDays(days)) return 'invalid';
  if (precedence !== undefined && precedence !== 'shorter' && precedence !== 'flow') return 'invalid';
  return {
    enabled: true,
    ...(days === undefined ? {} : { days: days as number }),
    ...(precedence === undefined ? {} : { precedence: precedence as 'shorter' | 'flow' }),
  };
}

/**
 * `{ "action": "dry-run" }` reports how many conversations would go, and removes
 * nothing. Add `settings` to try a period out before turning retention on.
 */
async function POST_handler(request: Request) {
  const locked = await assertUnlocked();
  if (locked) return locked;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  if (body.action !== 'dry-run') {
    return NextResponse.json({ error: 'Unknown action. The only action is "dry-run".' }, { status: 400 });
  }
  const settings = parseTrySettings(body.settings);
  if (settings === 'invalid') {
    return NextResponse.json({ error: 'Invalid retention settings' }, { status: 400 });
  }
  const report = await runConversationRetention({ dryRun: true, ...(settings ? { settings } : {}) });
  if (!report) return NextResponse.json({ enabled: false }, { headers: { 'Cache-Control': 'no-store' } });
  return NextResponse.json(report, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
