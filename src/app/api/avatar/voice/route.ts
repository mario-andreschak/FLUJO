import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { avatarVoiceAvailable } from '@/backend/services/avatar/voice';
export const runtime = 'nodejs';
async function GET_handler() {
  const locked = await assertUnlocked(); if (locked) return locked;
  return Response.json({ available: avatarVoiceAvailable(), transport: 'native-endpointed', provider: 'openrouter', sampleRateQualification: 'assumed' }, { headers: { 'Cache-Control': 'no-store' } });
}
export const GET = withWorkspaceRoute(GET_handler);
