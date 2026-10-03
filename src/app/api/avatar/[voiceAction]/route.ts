import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { handleAvatarVoice } from '@/backend/services/avatar/voice';
export const runtime = 'nodejs';
async function POST_handler(request: Request, { params }: { params: Promise<{ voiceAction: string }> }) {
  const locked = await assertUnlocked(); if (locked) return locked;
  const rejected = assertLocalRequest(request, { strictLoopback: true }); if (rejected) return rejected;
  const { voiceAction } = await params;
  return handleAvatarVoice(request, voiceAction);
}
export const POST = withWorkspaceRoute(POST_handler);
