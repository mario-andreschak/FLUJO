import { createHash } from 'crypto';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import type { SharedState } from '@/backend/execution/flow/types';
import { enqueueSteeringMessage } from '@/backend/execution/flow/steeringInbox';
import { submitPersonaFlowDispatch } from '@/backend/services/enduringAgents/personaDispatcher';
import { FlujoChatMessage } from '@/shared/types/chat';
import type { StorageKey } from '@/shared/types/storage';
import { assertSafeCollectionId, loadItem as loadItemBackend } from '@/utils/storage/backend';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';

const log = createLogger('app/v1/chat/conversations/[conversationId]/inject/route');

type PersonaRelatedAction = 'steer' | 'coalesce';

async function loadPersistedState(conversationId: string): Promise<SharedState | undefined> {
  try {
    assertSafeCollectionId(conversationId);
    return await loadItemBackend<SharedState>(
      `conversations/${conversationId}` as StorageKey,
      undefined as never,
    );
  } catch {
    // Keep the route's existing not-running boundary for unsafe ids and storage
    // failures. In particular, do not adopt a persisted legacy state into the
    // live map: only an executing local loop may drain the legacy inbox.
    return undefined;
  }
}

function personaRelatedAction(state: SharedState): PersonaRelatedAction | undefined {
  if (state.status === 'running') return 'steer';
  if (state.status === 'awaiting_tool_approval' || state.status === 'paused_debug') {
    return 'coalesce';
  }
  return undefined;
}

function injectionIdempotencyKey(
  conversationId: string,
  messageId: string,
  content: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ conversationId, messageId, content }))
    .digest('hex');
  return `chat-inject:${digest}`;
}

/**
 * Mid-run steering: hand a user message to a run that is ALREADY in flight.
 *
 * The run loop folds it into the transcript at its next safe boundary (between
 * tool batches / before the next model call), so a correction reaches the model
 * that is going the wrong way instead of waiting for the whole run to finish
 * and then starting a separate turn.
 *
 * A legacy run must be live in this process. Persona-backed conversations use
 * their trusted durable attribution and mailbox, which also permits related
 * input to coalesce while the Activity is waiting. Terminal conversations still
 * return 409 `not_running`; this endpoint never bypasses the Persona dispatcher.
 */
async function POST_handler(
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

  // Persona Activities own a durable mailbox and may be executing in another
  // process, so their persisted attribution is sufficient for admission. The
  // Persona runtime validates that the related Activity is still live/waiting.
  // Persona-less steering deliberately retains the legacy local-only rule.
  const liveState = FlowExecutor.conversationStates.get(conversationId);
  const sharedState = liveState ?? await loadPersistedState(conversationId);
  if (!sharedState) {
    log.info('Inject rejected — no live state for conversation', { requestId, conversationId });
    return NextResponse.json(
      { error: 'Conversation is not running', reason: 'not_running', conversation_id: conversationId },
      { status: 409 }
    );
  }
  if (isPersonaOwnedConversationState(sharedState)) {
    const notLoopback = assertLocalRequest(request, { strictLoopback: true });
    if (notLoopback) return notLoopback;
  }
  if (sharedState.personaArchived) {
    return NextResponse.json(
      { error: 'An anonymized Persona archive is read-only.', reason: 'persona_archived' },
      { status: 409 },
    );
  }
  if (isPersonaOwnedConversationState(sharedState) && !sharedState.personaAttribution) {
    return NextResponse.json(
      { error: 'Persona conversation attribution is incomplete.', reason: 'persona_attribution_incomplete' },
      { status: 409 },
    );
  }
  const relatedAction = sharedState.personaAttribution
    ? personaRelatedAction(sharedState)
    : undefined;
  if ((!sharedState.personaAttribution && (!liveState || sharedState.status !== 'running'))
    || (sharedState.personaAttribution && !relatedAction)) {
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
  const messageId = body.id || crypto.randomUUID();

  if (sharedState.personaAttribution && relatedAction) {
    const submission = await submitPersonaFlowDispatch({
      personaId: sharedState.personaAttribution.personaId,
      idempotencyKey: injectionIdempotencyKey(conversationId, messageId, content),
      kind: 'assignment',
      source: { kind: 'chat', sourceId: conversationId },
      relationKey: conversationId,
      relatedAction,
      summary: relatedAction === 'steer'
        ? 'Mid-run conversation steering'
        : 'Conversation input while Activity is waiting',
      flowInput: {
        messages: [{
          id: messageId,
          role: 'user',
          content,
          // The dispatcher replaces this with its durable creation timestamp
          // before delivery. A constant keeps identical retries hash-identical.
          timestamp: 0,
          injected: true,
        } as FlujoChatMessage],
        mode: 'conversation',
        conversationId,
        userTurn: true,
        source: 'chat',
      },
    }, { waitForCompletion: false });

    log.info('Submitted durable Persona conversation input', {
      requestId,
      conversationId,
      messageId,
      dispatchId: submission.dispatch.id,
      routingDecision: submission.decision,
    });

    return NextResponse.json({
      status: submission.dispatch.state,
      accepted: true,
      conversation_id: conversationId,
      message_id: messageId,
      dispatch_id: submission.dispatch.id,
      routing_decision: submission.decision,
    }, { status: 202 });
  }

  const message: FlujoChatMessage = {
    id: messageId,
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

export const POST = withWorkspaceRoute(POST_handler);
