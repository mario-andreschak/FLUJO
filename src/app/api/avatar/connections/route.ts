import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { modelService } from '@/backend/services/model';
import { discoverAvatarConnections } from '@/backend/services/avatar/connectionDiscovery';

export const runtime = 'nodejs';

async function GET_handler() {
  const locked = await assertUnlocked();
  if (locked) return locked;
  const models = await modelService.loadModels();
  return Response.json(await discoverAvatarConnections(models), { headers: { 'Cache-Control': 'no-store' } });
}
export const GET = withWorkspaceRoute(GET_handler);
