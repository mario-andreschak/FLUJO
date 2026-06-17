import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { SharedState } from '@/backend/execution/flow/types';
import { loadItem as loadItemBackend, saveItem as saveItemBackend } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';

const log = createLogger('app/v1/chat/conversations/[conversationId]/breakpoints/route');

async function loadState(conversationId: string): Promise<SharedState | undefined> {
  if (FlowExecutor.conversationStates.has(conversationId)) {
    return FlowExecutor.conversationStates.get(conversationId);
  }
  const storageKey = `conversations/${conversationId}` as StorageKey;
  const state = await loadItemBackend<SharedState>(storageKey, undefined as any);
  if (state) {
    FlowExecutor.conversationStates.set(conversationId, state);
  }
  return state ?? undefined;
}

/**
 * Replace the set of breakpoint node IDs for a conversation (used by the
 * visual debugger). Body: { breakpoints: string[] }.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: { conversationId: string } }
) {
  const { conversationId } = params;
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
    const sharedState = await loadState(conversationId);
    if (!sharedState) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    sharedState.breakpoints = breakpoints;
    FlowExecutor.conversationStates.set(conversationId, sharedState);
    await saveItemBackend(`conversations/${conversationId}` as StorageKey, sharedState);

    log.info('Updated breakpoints', { conversationId, count: breakpoints.length });
    return NextResponse.json({ success: true, breakpoints });
  } catch (error) {
    log.error('Error updating breakpoints', { conversationId, error });
    return NextResponse.json({ error: 'Internal server error updating breakpoints' }, { status: 500 });
  }
}
