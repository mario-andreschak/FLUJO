import { withWorkspaceRoute } from '@/app/api/_workspace';
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import {
  buildRunResourceUri,
  readRunResource,
} from '@/backend/services/runResources';

/**
 * Browser-facing payload endpoint for persisted model/tool media.
 *
 * The run-resource index remains the source of truth; this route simply turns
 * its MCP read shape back into HTTP bytes so <img>, <audio>, and <video> can
 * consume it without putting base64 in conversation JSON.
 */
async function GET_handler(
  _request: NextRequest,
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

  try {
    const uri = buildRunResourceUri(conversationId, resourceId);
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
