import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/utils/paths';
import { getCurrentWorkspace } from '@/utils/workspace';
import type { SubflowTaskRecord } from '@/shared/types/subflowTasks';
import { getRuntimeProcessIdentity, isRuntimeProcessIdentityAlive } from '../enduringAgents/runtimeLock';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const runtime = globalThis as typeof globalThis & {
  __flujoDetachedInstallationIds?: Map<string, Promise<string>>;
};
const installationIds = runtime.__flujoDetachedInstallationIds ??= new Map<string, Promise<string>>();

async function readInstallationId(directory: string): Promise<string> {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid detached task installation directory.');
  const marker = path.join(directory, 'identity.json');
  const stat = await fs.lstat(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 4096) {
    throw new Error('Invalid detached task installation identity.');
  }
  const identity = JSON.parse(await fs.readFile(marker, 'utf8')) as { version?: number; id?: string };
  if (identity.version !== 1 || !UUID.test(identity.id ?? '')) throw new Error('Invalid detached task installation identity.');
  return identity.id!;
}

async function prepareInstallationId(root: string): Promise<string> {
  // This installation-wide marker is outside WORKSPACE_SUBTREES: exporting or
  // restoring a workspace cannot make imported task records appear local.
  const directory = path.join(root, '.flujo-detached-identity');
  try { return await readInstallationId(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await fs.mkdir(root, { recursive: true });
  const staging = await fs.mkdtemp(path.join(root, '.flujo-detached-identity-'));
  try {
    await fs.writeFile(path.join(staging, 'identity.json'), JSON.stringify({ version: 1, id: randomUUID() }), { mode: 0o600 });
    // Publish a complete, nonempty directory atomically. A competing creator
    // wins safely; it cannot expose a partially written identity to readers.
    try { await fs.rename(staging, directory); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    return await readInstallationId(directory);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export function getDetachedInstallationId(): Promise<string> {
  const root = getDataDir();
  let pending = installationIds.get(root);
  if (!pending) {
    pending = prepareInstallationId(root);
    installationIds.set(root, pending);
    void pending.catch(() => { if (installationIds.get(root) === pending) installationIds.delete(root); });
  }
  return pending;
}

export async function getDetachedTaskLaunchOwner(): Promise<NonNullable<SubflowTaskRecord['launchOwner']>> {
  const [{ recoveryOwnerId }, installationId, processIdentity] = await Promise.all([
    import('@/backend/execution/flow/recoveryCheckpoint'),
    getDetachedInstallationId(),
    getRuntimeProcessIdentity(),
  ]);
  return { installationId, workspace: getCurrentWorkspace(), recoveryOwnerId: recoveryOwnerId(), ...processIdentity };
}

export async function isPriorLocalTaskOwner(owner: SubflowTaskRecord['launchOwner']): Promise<boolean> {
  if (!owner || owner.workspace !== getCurrentWorkspace()
    || !UUID.test(owner.installationId) || !UUID.test(owner.recoveryOwnerId)
    || !UUID.test(owner.processInstanceId) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || (owner.processBirthMarkerV2 !== undefined && typeof owner.processBirthMarkerV2 !== 'string')) return false;
  const { recoveryOwnerId } = await import('@/backend/execution/flow/recoveryCheckpoint');
  if (owner.recoveryOwnerId === recoveryOwnerId() || owner.installationId !== await getDetachedInstallationId()) return false;
  return !await isRuntimeProcessIdentityAlive(owner);
}
