import { withWorkspaceRoute } from '@/app/api/_workspace';
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import {
  buildRunResourceUri,
  readRunResource,
  readRunResourceRange,
} from '@/backend/services/runResources';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { assertLocalRequest } from '@/utils/http/localRequest';

/**
 * Browser-facing payload endpoint for persisted model/tool media.
 *
 * The run-resource index remains the source of truth; this route simply turns
 * its MCP read shape back into HTTP bytes so <img>, <audio>, and <video> can
 * consume it without putting base64 in conversation JSON.
 */
async function GET_handler(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ conversationId: string; resourceId: string }>;
  },
) {
  const lock = await assertUnlocked({ openai: true });
  if (lock) return lock;

  const { conversationId, resourceId } = await params;
  if (!conversationId || !resourceId) {
    return NextResponse.json({ error: 'Missing resource identifier' }, { status: 400 });
  }

  const state = await loadConversationState(conversationId);
  if (!state || isPersonaOwnedConversationState(state)) {
    const notLocal = assertLocalRequest(request);
    if (notLocal) return notLocal;
  }

  try {
    const uri = buildRunResourceUri(conversationId, resourceId);
    const access = {
      at: Date.now(),
      source: 'res-ref' as const,
    };
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
      if (!match) {
        return new NextResponse(null, { status: 416 });
      }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : Number.MAX_SAFE_INTEGER;
      const ranged = await readRunResourceRange(uri, start, end, access);
      if (!ranged) {
        return NextResponse.json({ error: 'Resource not found' }, { status: 404 });
      }
      if (ranged.start >= ranged.total) {
        return new NextResponse(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${ranged.total}` },
        });
      }
      const safeFilename = (ranged.entry.name ?? ranged.entry.id).replace(/["\r\n]/g, '_');
      return new NextResponse(Uint8Array.from(ranged.data), {
        status: 206,
        headers: {
          'Content-Type': ranged.entry.mimeType ?? 'application/octet-stream',
          'Content-Length': String(ranged.data.byteLength),
          'Content-Range': `bytes ${ranged.start}-${ranged.end}/${ranged.total}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=31536000, immutable',
          'Content-Disposition': `inline; filename="${safeFilename}"`,
        },
      });
    }

    const read = await readRunResource(uri, {
      at: Date.now(),
      source: 'res-ref',
    });
    if (!read) {
      return NextResponse.json({ error: 'Resource not found' }, { status: 404 });
    }
    const content = read.contents.contents[0];
    if (!content || ('text' in content && read.entry.kind === 'link')) {
      return NextResponse.json({ error: 'Resource has no local payload' }, { status: 404 });
    }

    const body = 'blob' in content && content.blob
      ? Buffer.from(content.blob, 'base64')
      : Buffer.from(('text' in content && content.text) || '', 'utf8');
    const safeFilename = (read.entry.name ?? read.entry.id).replace(/["\r\n]/g, '_');
    return new NextResponse(body, {
      headers: {
        'Content-Type': content.mimeType ?? read.entry.mimeType ?? 'application/octet-stream',
        'Content-Length': String(body.byteLength),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Disposition': `inline; filename="${safeFilename}"`,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unsafe run-resource')) {
      return NextResponse.json({ error: 'Invalid resource identifier' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to read resource' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
