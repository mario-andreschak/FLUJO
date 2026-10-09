import { withWorkspaceRoute } from '@/app/api/_workspace';
import { canonicalVoiceResult } from '@/backend/services/avatar/voice';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
async function GET_handler(request: NextRequest) {
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const conversationId = request.nextUrl.searchParams.get('conversationId') ?? '';
  const messageId = request.nextUrl.searchParams.get('messageId') ?? '';
  try {
    await canonicalVoiceResult(conversationId, messageId);
    return Response.json({ conversationId, messageId }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 409;
    return Response.json({ error: 'The foreground reply is not available.' }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
export const GET = withWorkspaceRoute(GET_handler);
