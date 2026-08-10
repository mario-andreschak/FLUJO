import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';

const log = createLogger('app/v1/chat/conversations/[conversationId]/debug/state/route');

/**
 * Read the current debug state of a conversation.
 *
 * The debugger used to receive `debugState` ONLY as the resolution of the
 * pending chat-completions POST, which meant it could only ever attach to a run
 * this browser tab had started itself. With a single Debugger control that
 * opens instantly (and shows a spinner until there is something to attach to),
 * the panel needs a way to pull the state for a run it does not own — e.g. one
 * started in another tab, or re-attached after a reload, or paused by a
 * breakpoint that fired while the POST had already returned.
 *
 * Read-only: it never mutates or resumes anything.
 */
async function GET_handler(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;
  // Defense-in-depth localhost / DNS-rebinding guard (#143).
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
      const notLoopback = assertLocalRequest(request, { strictLoopback: true });
      if (notLoopback) return notLoopback;
    }
    return NextResponse.json({
      status: sharedState.status ?? 'completed',
      breakpoints: sharedState.breakpoints ?? [],
      debugState: sharedState,
    });
  } catch (error) {
    log.error('Error reading debug state', { conversationId, error });
    return NextResponse.json({ error: 'Internal server error reading debug state' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
