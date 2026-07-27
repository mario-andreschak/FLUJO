import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { enqueueSteeringMessage } from '@/backend/execution/flow/steeringInbox';
import { FlujoChatMessage } from '@/shared/types/chat';

const log = createLogger('app/v1/chat/conversations/[conversationId]/inject/route');

/**
 * Mid-run steering: hand a user message to a run that is ALREADY in flight.
 *
 * The run loop folds it into the transcript at its next safe boundary (between
 * tool batches / before the next model call), so a correction reaches the model
 * that is going the wrong way instead of waiting for the whole run to finish
 * and then starting a separate turn.
 *
 * Only a live run can be steered. When the conversation is not running this
 * returns 409 `not_running` and the client sends the message the normal way —
 * the endpoint deliberately does NOT start a run of its own, so there is
 * exactly one code path that begins a turn.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;
  // Same localhost / DNS-rebinding guard as the sibling routes: this writes
  // attacker-chosen text straight into a running agent's context.
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const { conversationId } = await params;
  const requestId = `conv-inject-${Date.now()}`;

  if (!conversationId) {
    return NextResponse.json({ error: 'Missing conversationId parameter' }, { status: 400 });
  }

  let body: { content?: string; id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const content = typeof body.content === 'string' ? body.content : '';
  if (!content.trim()) {
    return NextResponse.json({ error: 'content is required' }, { status: 400 });
  }

  // Only the in-memory state matters: a run in flight is by definition a loop
  // executing in THIS process, and only such a loop can drain the inbox. A
  // storage-loaded state would be stale by construction.
  const sharedState = FlowExecutor.conversationStates.get(conversationId);
  if (!sharedState) {
    log.info('Inject rejected — no live state for conversation', { requestId, conversationId });
    return NextResponse.json(
      { error: 'Conversation is not running', reason: 'not_running', conversation_id: conversationId },
      { status: 409 }
    );
  }
  if (sharedState.status !== 'running') {
    log.info('Inject rejected — conversation is not running', { requestId, conversationId, status: sharedState.status });
    return NextResponse.json(
      {
        error: `Conversation is not running (status: ${sharedState.status})`,
        reason: 'not_running',
        status: sharedState.status,
        conversation_id: conversationId,
      },
      { status: 409 }
    );
  }

  // Keep the client-supplied id when present: the chat shows the message
  // optimistically and dedupes by id, so reusing it merges the canonical copy
  // into that bubble instead of rendering the message twice.
  const message: FlujoChatMessage = {
    id: body.id || crypto.randomUUID(),
    role: 'user',
    content,
    timestamp: Date.now(),
    injected: true,
  };

  enqueueSteeringMessage(conversationId, message);
  log.info('Queued steering message for live run', { requestId, conversationId, messageId: message.id });

  return NextResponse.json({
    status: 'queued',
    conversation_id: conversationId,
    message_id: message.id,
  });
}
