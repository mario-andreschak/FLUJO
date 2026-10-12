import type { FactoryObservatorySnapshot } from '@/shared/types/factoryObservatory';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export async function readFactoryObservatorySnapshot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<FactoryObservatorySnapshot> {
  const { FACTORY_OBSERVATORY_URL: rawUrl, FACTORY_OBSERVATORY_TOKEN: token,
    FACTORY_OBSERVATORY_ID: factoryId } = env;
  if (!rawUrl || !token || !factoryId) throw new Error('FACTORY_NOT_CONFIGURED');
  if (!ID.test(factoryId) || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('FACTORY_CONFIG_INVALID');
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('FACTORY_CONFIG_INVALID'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.search || url.hash || !['/v1/snapshot', `/v1/factories/${factoryId}/snapshot`].includes(url.pathname)) {
    throw new Error('FACTORY_CONFIG_INVALID');
  }
  const response = await fetcher(url.href, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('FACTORY_SOURCE_UNAVAILABLE');
  if (!response.body) throw new Error('FACTORY_SOURCE_INVALID');
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > 2_000_000) throw new Error('FACTORY_SOURCE_INVALID');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let source: unknown;
  try { source = JSON.parse(raw); } catch { throw new Error('FACTORY_SOURCE_INVALID'); }
  if (!source || typeof source !== 'object') throw new Error('FACTORY_SOURCE_INVALID');
  const envelope = source as Record<string, unknown>;
  const capabilities = envelope.capabilities as Record<string, unknown> | undefined;
  const snapshot = envelope.snapshot as Record<string, unknown> | undefined;
  const control = snapshot?.control as Record<string, unknown> | undefined;
  if (envelope.schemaVersion !== 1 || envelope.factoryId !== factoryId || envelope.scope !== 'local-coordinator'
    || capabilities?.commands !== false || capabilities?.snapshot !== true
    || !Number.isSafeInteger(envelope.revision) || (envelope.revision as number) < 0
    || typeof envelope.observedAt !== 'string' || !Number.isFinite(Date.parse(envelope.observedAt))
    || !snapshot || !['active', 'paused'].includes(String(control?.status))
    || typeof control?.mission !== 'string' || !Array.isArray(snapshot.cells)
    || !Array.isArray(snapshot.tasks) || !Number.isSafeInteger(snapshot.unresolvedEffects)
    || (snapshot.unresolvedEffects as number) < 0) throw new Error('FACTORY_SOURCE_INVALID');
  const cells = snapshot.cells.map((cell: Record<string, unknown>) => {
    if (!cell || typeof cell.id !== 'string' || !ID.test(cell.id)
      || (cell.parentId !== null && (typeof cell.parentId !== 'string' || !ID.test(cell.parentId)))
      || !Number.isSafeInteger(cell.depth) || !['reserved', 'ready', 'retired'].includes(String(cell.status))
      || typeof cell.role !== 'string' || typeof cell.purpose !== 'string') throw new Error('FACTORY_SOURCE_INVALID');
    return { id: cell.id, parentId: cell.parentId as string | null, depth: cell.depth as number,
      role: cell.role, status: cell.status as string, purpose: cell.purpose };
  });
  const ids = new Map<string, FactoryObservatorySnapshot['cells'][number]>(
    cells.map((cell: FactoryObservatorySnapshot['cells'][number]) => [cell.id, cell]),
  );
  if (ids.size !== cells.length || !ids.has('root') || cells.some((cell: FactoryObservatorySnapshot['cells'][number]) =>
    cell.id === 'root' ? cell.parentId !== null || cell.depth !== 0
      : !cell.parentId || !ids.has(cell.parentId) || cell.depth !== ids.get(cell.parentId)!.depth + 1)) {
    throw new Error('FACTORY_SOURCE_INVALID');
  }
  const tasks = snapshot.tasks.map((task: Record<string, unknown>) => {
    if (!task || typeof task.id !== 'string' || !ID.test(task.id)
      || (task.owner !== null && (typeof task.owner !== 'string' || !ids.has(task.owner)))
      || typeof task.projectId !== 'string' || !ID.test(task.projectId)
      || typeof task.status !== 'string') throw new Error('FACTORY_SOURCE_INVALID');
    return { id: task.id, owner: task.owner as string | null, status: task.status, projectId: task.projectId };
  });
  return { factoryId, observedAt: envelope.observedAt as string, revision: envelope.revision as number,
    mission: control.mission as string, status: control.status as 'active' | 'paused',
    cells, tasks, unresolvedEffects: snapshot.unresolvedEffects as number };
}
