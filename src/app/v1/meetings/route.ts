import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { meetingEngine } from '@/backend/execution/meeting';
import { listMeetingSummaries } from '@/backend/services/meetings/store';
import type { CreateMeetingInput } from '@/shared/types/meeting';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/meetings/route');
export const dynamic = 'force-dynamic';

async function GET_handler() {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  try {
    return NextResponse.json(await listMeetingSummaries());
  } catch (error) {
    log.error('Failed to list meetings', error);
    return NextResponse.json({ error: 'Failed to list meetings.' }, { status: 500 });
  }
}

async function POST_handler(request: NextRequest) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  let input: CreateMeetingInput;
  try {
    input = await request.json() as CreateMeetingInput;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  try {
    const meeting = await meetingEngine.create(input);
    return NextResponse.json(meeting, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid meeting configuration.';
    const duplicate = /already exists/i.test(message);
    const invalid = error instanceof TypeError || /(?:requires|must|invalid|unsafe|unsupported|duplicate|not found|has no|cannot be)/i.test(message);
    if (!duplicate && !invalid) log.error('Failed to persist meeting', error);
    return NextResponse.json(
      { error: duplicate || invalid ? message : 'Failed to create meeting.' },
      { status: duplicate ? 409 : invalid ? 400 : 500 },
    );
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
