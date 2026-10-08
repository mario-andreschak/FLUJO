import { withRemoteAvatarRoute } from '@/backend/services/avatar/remoteVoice';
import { avatarVoiceAvailable, type TrustedAvatarVoiceContext } from '@/backend/services/avatar/voice';
import { assertUnlocked } from '@/utils/encryption/lockGate';

export const runtime = 'nodejs';
async function GET_handler(_request: Request, trusted: TrustedAvatarVoiceContext) {
  const locked = await assertUnlocked(); if (locked) return locked;
  await trusted.recheck();
  return Response.json({ available: avatarVoiceAvailable(), transport: 'native-endpointed',
    provider: 'openrouter', sampleRateQualification: 'assumed' }, { headers: { 'Cache-Control': 'no-store' } });
}
export const GET = withRemoteAvatarRoute(GET_handler);
