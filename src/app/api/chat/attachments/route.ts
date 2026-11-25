import { NextRequest, NextResponse } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { currentChatAttachmentLimits, machineAttachmentDefaults } from '@/backend/services/chatAttachments/limits';
import { prepareChatAttachment } from '@/backend/services/chatAttachments/prepare';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/chat/attachments/route');

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * GET /api/chat/attachments
 * The attachment limits in force, and the defaults this computer would use.
 */
async function GET_handler() {
  const limits = await currentChatAttachmentLimits();
  return NextResponse.json({ limits, defaults: machineAttachmentDefaults() }, { headers: NO_STORE });
}

async function readBody(request: NextRequest, maxBytes: number): Promise<Uint8Array | 'too-large'> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return 'too-large';
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return 'too-large';
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * POST /api/chat/attachments?name=<file name>&type=<MIME type>
 * Body: the file's bytes. Turns documents, archives, PDFs and unusual images
 * into something a model can read (#1224). Always answers with what the chat
 * should attach, including a note when the file cannot be read, so a file is
 * never dropped without a word.
 */
async function POST_handler(request: NextRequest) {
  const url = new URL(request.url);
  const name = url.searchParams.get('name')?.trim() || 'attachment';
  const mimeType = url.searchParams.get('type')?.trim() || undefined;
  const limits = await currentChatAttachmentLimits();
  const body = await readBody(request, limits.maxFileBytes);
  if (body === 'too-large') {
    return NextResponse.json(
      { kind: 'note', note: { code: 'too-large', values: { limit: limits.maxFileBytes } } },
      { status: 413, headers: NO_STORE },
    );
  }
  try {
    const prepared = await prepareChatAttachment({ bytes: body, name, mimeType, limits });
    return NextResponse.json(prepared, { headers: NO_STORE });
  } catch (error) {
    log.warn('Chat attachment preparation failed', error);
    return NextResponse.json({ kind: 'note', note: { code: 'failed', values: { reason: 'damaged' } } }, { headers: NO_STORE });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
