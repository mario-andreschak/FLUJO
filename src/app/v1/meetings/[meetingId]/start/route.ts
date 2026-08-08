import { NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { meetingEngine } from '@/backend/execution/meeting';
import { assertUnlocked } from '@/utils/encryption/lockGate';

export const dynamic = 'force-dynamic';

async function POST_handler(
  _request: Request,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  const { meetingId } = await params;
  try {
    const meeting = await meetingEngine.start(meetingId);
    return NextResponse.json({ meeting });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start meeting.';
    const status = message.includes('not found') ? 404 : message.includes('already') ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export const POST = withWorkspaceRoute(POST_handler);

