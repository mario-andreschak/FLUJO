import { PersonaRecoveryError } from './personaRecoveryError';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import {
  getWorkspaceDir, getWorkspacesDir, withWorkspaceNamespaceMutation, WORKSPACE_SUBTREES,
} from '@/utils/workspace';
import { atomicWriteWithoutLinks } from '@/backend/services/workspace/backupRestoreFs';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { PersonaRecoveryFileReader } from './personaRecoveryFiles';
import { parsePersonaRecoveryJson } from './personaRecoveryArchive';
import { planPersonaRecoveryRestore, type PersonaRecoveryRestorePreview } from './personaRecoveryPlan';

export type PersonaRecoveryRestoreCheckpoint = 'validated' | 'file_written' | 'staged' | 'before_publish' | 'published';
export interface PersonaRecoveryRestoreResult {
  status: 'restored' | 'already_restored';
  workspace: string;
  preview: PersonaRecoveryRestorePreview;
}

async function requireDirectory(directory: string): Promise<Stats> {
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new PersonaRecoveryError('Persona recovery publication requires real directories.');
  return stats;
}

/** Publish a validated, frozen workspace once. Never merge with an existing tree. */
export async function restorePersonaRecovery(
  archive: Buffer,
  destinationWorkspace: string,
  previewToken: string,
  options: {
    signal?: AbortSignal;
    /** Internal fault-injection seam; routes never accept this from a caller. */
    onCheckpoint?: (checkpoint: PersonaRecoveryRestoreCheckpoint, fileIndex?: number) => Promise<void>;
  } = {},
): Promise<PersonaRecoveryRestoreResult> {
  if (isWorkerMode()) throw new PersonaRecoveryError('Persona recovery is unavailable on execution workers.');
  options.signal?.throwIfAborted();
  const plan = planPersonaRecoveryRestore(archive, destinationWorkspace);
  if (plan.preview.previewToken !== previewToken) throw new PersonaRecoveryError('Recovery preview changed; inspect the archive and destination again.');
  await options.onCheckpoint?.('validated');
  const root = path.resolve(getWorkspacesDir());
  await fs.mkdir(root, { recursive: true });
  const rootStats = await requireDirectory(root);
  const destination = getWorkspaceDir(destinationWorkspace);

  const existingResult = async (): Promise<PersonaRecoveryRestoreResult | undefined> => {
    const aliases = (await fs.readdir(root)).filter((name) => name.toLowerCase() === destinationWorkspace.toLowerCase());
    if (!aliases.length) return undefined;
    if (aliases.length !== 1 || aliases[0] !== destinationWorkspace) throw new PersonaRecoveryError('A case-equivalent recovery workspace already exists.');
    await requireDirectory(destination);
    const reader = new PersonaRecoveryFileReader(root, { signal: options.signal });
    const receipt = await reader.read(`${destinationWorkspace}/db/persona-recovery/restore.json`);
    if (!receipt) throw new PersonaRecoveryError('The recovery destination already exists; choose a new workspace name.');
    const value = parsePersonaRecoveryJson(receipt, 'restore receipt');
    if (value.version !== 1 || value.previewToken !== plan.preview.previewToken
      || value.archiveSha256 !== plan.preview.archiveSha256 || value.destinationWorkspace !== destinationWorkspace) {
      throw new PersonaRecoveryError('The destination contains a different recovery or existing workspace.');
    }
    await reader.verifyUnchanged();
    return { status: 'already_restored', workspace: destinationWorkspace, preview: plan.preview };
  };
  const prior = await withWorkspaceNamespaceMutation(existingResult);
  if (prior) return prior;
  // A leading dot fails the workspace-name grammar, so no route, worker or
  // workspace picker can select the staged files while they are incomplete.
  const staging = await fs.mkdtemp(path.join(root, '.persona-restore-'));
  const stagingStats = await requireDirectory(staging);
  let published = false;
  try {
    await fs.chmod(staging, 0o700);
    for (const subtree of WORKSPACE_SUBTREES) await fs.mkdir(path.join(staging, subtree));
    await atomicWriteWithoutLinks(staging, path.join(staging, '.workspace.json'), Buffer.from('{"roots":[]}'));
    for (let index = 0; index < plan.files.length; index++) {
      options.signal?.throwIfAborted();
      const file = plan.files[index];
      const target = path.resolve(staging, ...file.path.split('/'));
      if (!target.startsWith(`${staging}${path.sep}`)) throw new PersonaRecoveryError('Recovery plan escaped its private staging directory.');
      await atomicWriteWithoutLinks(staging, target, file.bytes);
      await options.onCheckpoint?.('file_written', index);
    }
    await options.onCheckpoint?.('staged');
    return await withWorkspaceNamespaceMutation(async () => {
      options.signal?.throwIfAborted();
      const currentRoot = await requireDirectory(root);
      const currentStage = await requireDirectory(staging);
      if (rootStats.dev !== currentRoot.dev || rootStats.ino !== currentRoot.ino
        || stagingStats.dev !== currentStage.dev || stagingStats.ino !== currentStage.ino) {
        throw new PersonaRecoveryError('Recovery publication directory changed.');
      }
      const existing = await existingResult();
      if (existing) return existing;
      await options.onCheckpoint?.('before_publish');
      options.signal?.throwIfAborted();
      // Managed create/rename/delete operations hold this same namespace lock.
      // An external filesystem mutation is outside the registered-writer contract.
      if (await existingResult()) throw new PersonaRecoveryError('Recovery destination appeared before publication.');
      await fs.rename(staging, destination);
      published = true;
      if (process.platform !== 'win32') {
        const parent = await fs.open(root, 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
      await options.onCheckpoint?.('published');
      return { status: 'restored', workspace: destinationWorkspace, preview: plan.preview };
    });
  } finally {
    if (!published) {
      const current = await fs.lstat(staging).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (current && current.isDirectory() && !current.isSymbolicLink()
        && current.dev === stagingStats.dev && current.ino === stagingStats.ino
        && path.dirname(staging) === root && path.basename(staging).startsWith('.persona-restore-')) {
        await fs.rm(staging, { recursive: true, force: true });
      }
    }
  }
}
