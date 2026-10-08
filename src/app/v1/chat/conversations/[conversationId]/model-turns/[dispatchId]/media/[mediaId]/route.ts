import { withWorkspaceRoute } from '@/app/api/_workspace';
import { loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { readModelTurnMedia } from '@/backend/execution/flow/modelTurnArchive';
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
  const media = await readModelTurnMedia(conversationId, dispatchId, mediaId);
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

