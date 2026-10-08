import { withWorkspaceRoute } from '@/app/api/_workspace';
import { loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { readModelTurnSnapshot } from '@/backend/execution/flow/modelTurnArchive';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';

async function GET_handler(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string; dispatchId: string }> },
): Promise<NextResponse> {
  const lock = await assertUnlocked({ openai: true });
  if (lock) return lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const { conversationId, dispatchId } = await params;
  if (!(await loadConversationStateReadOnly(conversationId))) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  const snapshot = await readModelTurnSnapshot(conversationId, dispatchId);
  if (!snapshot || snapshot.entry.conversationId !== conversationId) {
    return NextResponse.json({ error: 'Model turn not found' }, { status: 404 });
  }
  return NextResponse.json(snapshot, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withWorkspaceRoute(GET_handler);

