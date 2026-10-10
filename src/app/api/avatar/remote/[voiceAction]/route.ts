import { withRemoteAvatarRoute } from '@/backend/services/avatar/remoteVoice';
import { handleAuthenticatedAvatarVoice, type TrustedAvatarVoiceContext } from '@/backend/services/avatar/voice';
import { assertUnlocked } from '@/utils/encryption/lockGate';

export const runtime = 'nodejs';
async function POST_handler(request: Request, trusted: TrustedAvatarVoiceContext,
  { params }: { params: Promise<{ voiceAction: string }> }) {
  const locked = await assertUnlocked(); if (locked) return locked;
  await trusted.recheck();
  const { voiceAction } = await params;
  await trusted.recheck();
  return handleAuthenticatedAvatarVoice(request, voiceAction, trusted);
}
export const POST = withRemoteAvatarRoute(POST_handler);
