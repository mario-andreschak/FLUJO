import { withWorkspaceRoute } from '@/app/api/_workspace';
import { loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { flushConversationLog, readConversationLog } from '@/backend/execution/flow/conversationLog';
import type { ModelTurnIndexEntry, ModelTurnTimelineResponse } from '@/shared/types/modelTurn';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';

async function GET_handler(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse> {
  const lock = await assertUnlocked({ openai: true });
  if (lock) return lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const { conversationId } = await params;
  const state = await loadConversationStateReadOnly(conversationId);
  if (!state) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

  await flushConversationLog(conversationId);
  const events = await readConversationLog(conversationId) ?? [];
  const turns: ModelTurnIndexEntry[] = [];
  const indexById = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'model:dispatch') {
      indexById.set(event.turn.id, turns.length);
      turns.push({ ...event.turn, timestamp: event.timestamp || event.turn.timestamp });
    } else if (event.type === 'model:dispatch-result') {
      const index = indexById.get(event.dispatchId);
      if (index != null) turns[index] = { ...turns[index], outcome: event.outcome };
    }
  }

  return NextResponse.json({ conversationId, turns } satisfies ModelTurnTimelineResponse, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export const GET = withWorkspaceRoute(GET_handler);

