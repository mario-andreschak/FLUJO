import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { getAvatarWorldSnapshot } from '@/backend/services/avatar/worldSnapshot';

export const runtime = 'nodejs';
async function GET_handler(request: Request) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked(); if (locked) return locked;
  return Response.json(await getAvatarWorldSnapshot(), { headers: { 'Cache-Control': 'no-store' } });
}
export const GET = withWorkspaceRoute(GET_handler);
