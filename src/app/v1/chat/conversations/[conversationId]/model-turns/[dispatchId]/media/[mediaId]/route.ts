import { withWorkspaceRoute } from '@/app/api/_workspace';
import { loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { readModelTurnMedia } from '@/backend/execution/flow/modelTurnArchive';
import { MODEL_TURN_ARCHIVE_READ_LIMITS, ModelTurnArchiveReadError } from '@/backend/execution/flow/modelTurnArchiveReadBudget';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';

async function GET_handler(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string; dispatchId: string; mediaId: string }> },
): Promise<Response> {
  const lock = await assertUnlocked({ openai: true });
  if (lock) return lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const { conversationId, dispatchId, mediaId } = await params;
  if (!(await loadConversationStateReadOnly(conversationId))) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  let media: Awaited<ReturnType<typeof readModelTurnMedia>>;
  try {
    media = await readModelTurnMedia(conversationId, dispatchId, mediaId, request.signal);
  } catch (error) {
    if (!(error instanceof ModelTurnArchiveReadError)) throw error;
    return NextResponse.json({ error: error.message, code: error.code, limits: MODEL_TURN_ARCHIVE_READ_LIMITS }, {
      status: error.status,
      headers: { 'Cache-Control': 'no-store', ...(error.status === 429 ? { 'Retry-After': '1' } : {}) },
    });
  }
  if (!media) return NextResponse.json({ error: 'Archived media not found' }, { status: 404 });

  return new Response(new Uint8Array(media.bytes), {
    headers: {
      'Content-Type': media.descriptor.mimeType,
      'Content-Length': String(media.bytes.byteLength),
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      ...(media.descriptor.filename
        ? { 'Content-Disposition': `inline; filename="${media.descriptor.filename.replace(/["\r\n]/g, '_')}"` }
        : {}),
    },
  });
}

export const GET = withWorkspaceRoute(GET_handler);

