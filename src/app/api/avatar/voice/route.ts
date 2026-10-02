import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { avatarVoiceAvailable } from '@/backend/services/avatar/voice';
export const runtime = 'nodejs';
export const GET = withWorkspaceRoute(async () => {
  const locked = await assertUnlocked(); if (locked) return locked;
  return Response.json({ available: avatarVoiceAvailable(), transport: 'native-endpointed', provider: 'openrouter', sampleRateQualification: 'assumed' }, { headers: { 'Cache-Control': 'no-store' } });
});
