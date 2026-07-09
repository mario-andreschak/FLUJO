import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { StorageKey } from '@/shared/types/storage';

const log = createLogger('app/v1/chat/conversations/[conversationId]/breakpoints/route');

/**
 * Replace the set of breakpoint node IDs for a conversation (used by the
 * visual debugger). Body: { breakpoints: string[] }.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;

  const { conversationId } = await params;
  if (!conversationId) {
    return NextResponse.json({ error: 'Missing conversationId parameter' }, { status: 400 });
  }

  let body: { breakpoints?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const breakpoints = Array.isArray(body.breakpoints)
    ? body.breakpoints.filter((b): b is string => typeof b === 'string')
    : null;
  if (!breakpoints) {
    return NextResponse.json({ error: 'Body must include a breakpoints string array' }, { status: 400 });
  }

  try {
    const sharedState = await loadConversationState(conversationId);
    if (!sharedState) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    sharedState.breakpoints = breakpoints;
    FlowExecutor.conversationStates.set(conversationId, sharedState);
    await persistConversationState(`conversations/${conversationId}` as StorageKey, sharedState);

    log.info('Updated breakpoints', { conversationId, count: breakpoints.length });
    return NextResponse.json({ success: true, breakpoints });
  } catch (error) {
    log.error('Error updating breakpoints', { conversationId, error });
    return NextResponse.json({ error: 'Internal server error updating breakpoints' }, { status: 500 });
  }
}
