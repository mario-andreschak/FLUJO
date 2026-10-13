import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { handleAvatarVoice } from '@/backend/services/avatar/voice';
import { pocketAvailability, POCKET_VOICES } from '@/vendor/avatar/server/pocket-speech.mjs';

export const runtime = 'nodejs';
async function GET_handler(request: Request) {
  const locked = await assertUnlocked(); if (locked) return locked;
  const rejected = assertLocalRequest(request, { strictLoopback: true }); if (rejected) return rejected;
  return Response.json({ available: await pocketAvailability(process.env.FLUJO_AVATAR_POCKET_ORIGIN, fetch, request.signal),
    provider: 'pocket', outputOnly: true, voices: POCKET_VOICES }, { headers: { 'Cache-Control': 'no-store' } });
}
async function POST_handler(request: Request) {
  const locked = await assertUnlocked(); if (locked) return locked;
  const rejected = assertLocalRequest(request, { strictLoopback: true }); if (rejected) return rejected;
  return handleAvatarVoice(request, 'local-speech');
}
export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
