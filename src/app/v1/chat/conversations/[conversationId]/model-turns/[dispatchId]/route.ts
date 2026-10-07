import { withWorkspaceRoute } from '@/app/api/_workspace';
import { loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { readModelTurnSnapshotResponse } from '@/backend/execution/flow/modelTurnArchive';
import { MODEL_TURN_ARCHIVE_READ_LIMITS, ModelTurnArchiveReadError } from '@/backend/execution/flow/modelTurnArchiveReadBudget';
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
  let body: Awaited<ReturnType<typeof readModelTurnSnapshotResponse>>;
  try {
    body = await readModelTurnSnapshotResponse(conversationId, dispatchId, request.signal);
  } catch (error) {
    if (!(error instanceof ModelTurnArchiveReadError)) throw error;
    return NextResponse.json({ error: error.message, code: error.code, limits: MODEL_TURN_ARCHIVE_READ_LIMITS }, {
      status: error.status,
      headers: { 'Cache-Control': 'no-store', ...(error.status === 429 ? { 'Retry-After': '1' } : {}) },
    });
  }
  if (!body) {
    return NextResponse.json({ error: 'Model turn not found' }, { status: 404 });
  }
  return new NextResponse(body, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } });
}

export const GET = withWorkspaceRoute(GET_handler);

