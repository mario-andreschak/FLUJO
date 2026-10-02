import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { getAvatarWorldSnapshot } from '@/backend/services/avatar/worldSnapshot';

export const runtime = 'nodejs';
export const GET = withWorkspaceRoute(async (request: Request) => {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked(); if (locked) return locked;
  return Response.json(await getAvatarWorldSnapshot(), { headers: { 'Cache-Control': 'no-store' } });
});
