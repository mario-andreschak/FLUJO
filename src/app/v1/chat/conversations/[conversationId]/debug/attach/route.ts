import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { StorageKey } from '@/shared/types/storage';

const log = createLogger('app/v1/chat/conversations/[conversationId]/debug/attach/route');

/**
 * Request a one-shot pause at the next debugger-safe runtime boundary.
 *
 * This is deliberately separate from the breakpoint collection. The previous
 * attach implementation replaced all authored breakpoints with `['*']` and the
 * executor only inspected that sentinel before nodes, so attaching during a
 * model/tool call could not land until a later handoff. A state flag can be
 * observed after the current model/tool finishes without destroying breakpoint
 * configuration.
 */
async function POST_handler(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const { conversationId } = await params;
  if (!conversationId) {
    return NextResponse.json({ error: 'Missing conversationId parameter' }, { status: 400 });
  }

  try {
    const sharedState = await loadConversationState(conversationId);
    if (!sharedState) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }
    if (isPersonaOwnedConversationState(sharedState)) {
      const personaNotLocal = assertLocalRequest(request);
      if (personaNotLocal) return personaNotLocal;
      return NextResponse.json(
        { error: 'Persona-owned conversation controls require the Persona dispatcher.' },
        { status: 409 },
      );
    }

    sharedState.debugPauseRequested = true;
    FlowExecutor.conversationStates.set(conversationId, sharedState);
    await persistConversationState(`conversations/${conversationId}` as StorageKey, sharedState);

    log.info('Debugger attach requested', { conversationId });
    return NextResponse.json({ success: true });
  } catch (error) {
    log.error('Error requesting debugger attach', { conversationId, error });
    return NextResponse.json({ error: 'Internal server error attaching debugger' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
