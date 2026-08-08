import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { meetingEngine } from '@/backend/execution/meeting';
import { assertUnlocked } from '@/utils/encryption/lockGate';

export const dynamic = 'force-dynamic';

async function POST_handler(
  request: NextRequest,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  const { meetingId } = await params;
  let reason: string | undefined;
  try {
    const body = await request.json() as { reason?: unknown };
    if (typeof body.reason === 'string' && body.reason.trim()) reason = body.reason.trim();
  } catch {
    // An empty request body is valid for cancellation.
  }
  try {
    const meeting = await meetingEngine.cancel(meetingId, reason);
    return NextResponse.json({ meeting });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to cancel meeting.';
    const status = message.includes('not found') ? 404 : /unsafe|invalid/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
