import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { listRunResources } from '@/backend/services/runResources';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { assertLocalRequest } from '@/utils/http/localRequest';

const log = createLogger('app/v1/chat/conversations/[conversationId]/resources/route');

/**
 * List the run-scoped resources captured for a conversation (Tier 3 data
 * flow): auto-captured tool results, `captureResource` node outputs, and
 * tracked resource links — each with producedBy/readBy lineage. Consumed by
 * the debugger's run-data panel; the artifacts themselves are read through
 * the internal "flujo" MCP server (resources/read).
 */
async function GET_handler(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;

  const { conversationId } = await params;
  if (!conversationId) {
    return NextResponse.json({ error: 'Missing conversationId parameter' }, { status: 400 });
  }

  const state = await loadConversationState(conversationId);
  if (!state || state.personaAttribution) {
    const notLocal = assertLocalRequest(request, { strictLoopback: true });
    if (notLocal) return notLocal;
  }

  try {
    const resources = await listRunResources(conversationId);
    return NextResponse.json({ resources });
  } catch (error) {
    // An unsafe id is a client error, not a server one.
    if (error instanceof Error && error.message.startsWith('Unsafe run-resource')) {
      return NextResponse.json({ error: 'Invalid conversationId' }, { status: 400 });
    }
    log.error('Error listing run resources', { conversationId, error });
    return NextResponse.json({ error: 'Internal server error listing run resources' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
