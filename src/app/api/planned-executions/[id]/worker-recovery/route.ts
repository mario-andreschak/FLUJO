import type { NextRequest } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertSnapshotBearer } from '@/backend/services/workspace/snapshotControlAuth';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { getSchedulerService } from '@/backend/services/scheduler';

type Context = { params: Promise<{ id: string }> };

const wrapped = withWorkspaceRoute(async (request: NextRequest, { params }: Context) => {
  const locked = await assertUnlocked();
  if (locked) return locked;
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Invalid recovery enrollment' }, { status: 400 });
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !['enabled', 'expectedGenerationId', 'expectedDefinitionSha256'].includes(key))
      || typeof input.enabled !== 'boolean' || typeof input.expectedGenerationId !== 'string'
      || typeof input.expectedDefinitionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedDefinitionSha256)) {
    return Response.json({ error: 'enabled, expectedGenerationId and expectedDefinitionSha256 are required' }, { status: 400 });
  }
  const { id } = await params;
  const scheduler = getSchedulerService();
  try {
    await scheduler.setWorkerLocalRecovery(id, {
      enabled: input.enabled, expectedGenerationId: input.expectedGenerationId,
      expectedDefinitionSha256: input.expectedDefinitionSha256,
    });
    const entry = (await scheduler.list()).find(candidate => candidate.execution.id === id);
    return Response.json({ recovery: entry?.status.workerRecovery }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // Provenance/config conflicts are actionable without exposing private paths,
    // token material, filesystem exception text or imported commands.
    return Response.json({ error: 'Recovery enrollment was refused. Inspect the plan recovery status and retained run history.' }, { status: 409 });
  }
});

/** Dedicated worker bearer before workspace resolution, including direct handler imports. */
export function POST(request: NextRequest, context: Context) {
  if (!isWorkerMode()) return Response.json({ error: 'Worker mode is required' }, { status: 409 });
  const unauthorized = assertSnapshotBearer(request);
  if (unauthorized) return unauthorized;
  return wrapped(request, context);
}
