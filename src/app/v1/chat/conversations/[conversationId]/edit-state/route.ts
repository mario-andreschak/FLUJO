import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { SharedState } from '@/backend/execution/flow/types';
import { loadItem as loadItemBackend } from '@/utils/storage/backend';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { StorageKey } from '@/shared/types/storage';

const log = createLogger('app/v1/chat/conversations/[conversationId]/edit-state/route');

interface EditStateBody {
  /** Edit the textual content of a message identified by id. */
  messageId?: string;
  content?: string;
  /** Override the node the next step will run (e.g. redirect a handoff). */
  currentNodeId?: string;
}

/**
 * Apply on-the-fly edits to a paused (paused_debug) conversation: tweak a
 * message's content or change which node runs next, then continue/step. Only
 * permitted while the conversation is paused for debugging.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const { conversationId } = await params;
  if (!conversationId) {
    return NextResponse.json({ error: 'Missing conversationId parameter' }, { status: 400 });
  }

  let body: EditStateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    let sharedState: SharedState | undefined;
    if (FlowExecutor.conversationStates.has(conversationId)) {
      sharedState = FlowExecutor.conversationStates.get(conversationId);
    } else {
      sharedState = (await loadItemBackend<SharedState>(`conversations/${conversationId}` as StorageKey, undefined as any)) ?? undefined;
      if (sharedState) FlowExecutor.conversationStates.set(conversationId, sharedState);
    }

    if (!sharedState) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // Guard: edits are only safe while paused for debugging.
    if (sharedState.status !== 'paused_debug') {
      return NextResponse.json(
        { error: `State can only be edited while paused for debugging (current status: ${sharedState.status}).` },
        { status: 409 }
      );
    }

    let applied = false;

    if (typeof body.messageId === 'string' && typeof body.content === 'string') {
      const message = sharedState.messages.find((m) => m.id === body.messageId);
      if (!message) {
        return NextResponse.json({ error: `Message ${body.messageId} not found` }, { status: 404 });
      }
      message.content = body.content;
      applied = true;
      log.info('Edited message content', { conversationId, messageId: body.messageId });
    }

    if (typeof body.currentNodeId === 'string') {
      sharedState.currentNodeId = body.currentNodeId;
      applied = true;
      log.info('Overrode currentNodeId', { conversationId, currentNodeId: body.currentNodeId });
    }

    if (!applied) {
      return NextResponse.json({ error: 'No supported edit fields provided' }, { status: 400 });
    }

    sharedState.updatedAt = Date.now();
    FlowExecutor.conversationStates.set(conversationId, sharedState);
    await persistConversationState(`conversations/${conversationId}` as StorageKey, sharedState);

    return NextResponse.json({ success: true, debugState: sharedState });
  } catch (error) {
    log.error('Error editing conversation state', { conversationId, error });
    return NextResponse.json({ error: 'Internal server error editing state' }, { status: 500 });
  }
}
