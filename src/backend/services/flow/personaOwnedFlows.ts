import { createHash } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import type { Flow } from '@/shared/types/flow';
import { FlowSnapshotSchema } from '@/shared/types/enduringAgent';
import { assertSafeCollectionId } from '@/utils/storage/backend';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { withWorkspaceRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';

// Authoring is infrequent. One filesystem lock gives saves, migrations and
// privacy erasure a common boundary across Next bundles and local processes.
// It never acquires a Persona lock: factory/deletion already hold that lock.
export function withFlowMutationLock<T>(task: () => Promise<T>): Promise<T> {
  return withWorkspaceRuntimeLock('authoring-flows', task);
}

async function checkedPath(relative: string): Promise<{ target: string; stats: Stats } | undefined> {
  const root = path.resolve(getWorkspaceDataDir());
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\:\u0000-\u001f]/.test(part))) {
    throw new Error('Unsafe Flow artifact path.');
  }
  let target = root;
  for (const [index, part] of ['', ...parts].entries()) {
    if (part) target = path.join(target, part);
    let stats: Stats;
    try { stats = await fs.lstat(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (stats.isSymbolicLink() || (index < parts.length && !stats.isDirectory())) {
      throw new Error('Flow artifacts must use real workspace directories and files.');
    }
    if (index === parts.length) return { target, stats };
  }
}

async function children(relative: string): Promise<string[]> {
  const entry = await checkedPath(relative);
  if (!entry) return [];
  if (!entry.stats.isDirectory()) throw new Error('Flow artifact collection is not a directory.');
  return (await fs.readdir(entry.target)).sort();
}

async function readArtifact(relative: string): Promise<Buffer | undefined> {
  const entry = await checkedPath(relative);
  if (!entry) return undefined;
  if (!entry.stats.isFile() || entry.stats.nlink !== 1 || entry.stats.size > 64 * 1024 * 1024) {
    throw new Error('Flow artifact is linked, not a regular file, or exceeds the 64 MiB inspection limit.');
  }
  const handle = await fs.open(entry.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== entry.stats.ino || opened.dev !== entry.stats.dev || opened.nlink !== 1) {
      throw new Error('Flow artifact changed during inspection.');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== entry.stats.size || after.mtimeMs !== entry.stats.mtimeMs || after.ctimeMs !== entry.stats.ctimeMs) {
      throw new Error('Flow artifact changed during inspection.');
    }
    return bytes;
  } finally { await handle.close(); }
}

/** Authoritative read: empty/malformed content cannot strip an existing owner. */
export async function readStoredFlow(flowId: string): Promise<Flow | null> {
  assertSafeCollectionId(flowId);
  const bytes = await readArtifact(`db/flows/${flowId}.json`);
  if (!bytes) return null;
  const flow = FlowSnapshotSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (flow.id !== flowId) throw new Error('Flow filename does not match its identity.');
  return flow;
}

export interface PersonaOwnedFlowInspection {
  flowIds: string[];
  files: Array<{ path: string; sha256: string; bytes: number; ownerEvidence: boolean }>;
}

/** Caller holds the authoring lock for the complete inspection/erasure. */
export async function inspectPersonaOwnedFlowsWithinLock(personaId: string): Promise<PersonaOwnedFlowInspection> {
  assertSafeCollectionId(personaId);
  const candidates = new Map<string, Array<{ path: string; source: 'flow' | 'version' | 'backup' }>>();
  const add = (id: string, file: string, source: 'flow' | 'version' | 'backup') => {
    assertSafeCollectionId(id);
    const list = candidates.get(id) ?? []; list.push({ path: file, source }); candidates.set(id, list);
  };
  for (const collection of ['flows', 'flow-behavior-rules-backups'] as const) {
    for (const filename of await children(`db/${collection}`)) {
      // Include atomic-write residue and corruption backups for an owned Flow.
      const match = /^([A-Za-z0-9_-]+)\.json(?:$|\.)/.exec(filename);
      if (!match) throw new Error('Unrecognized Flow artifact; repair it before Persona deletion.');
      add(match[1], `db/${collection}/${filename}`, collection === 'flows' ? 'flow' : 'backup');
    }
  }
  for (const id of await children('db/flow-versions')) {
    assertSafeCollectionId(id);
    for (const filename of await children(`db/flow-versions/${id}`)) {
      add(id, `db/flow-versions/${id}/${filename}`, 'version');
    }
  }
  const result: PersonaOwnedFlowInspection = { flowIds: [], files: [] };
  for (const [flowId, files] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    const inspected: PersonaOwnedFlowInspection['files'] = [];
    const owners = new Set<string>();
    for (const file of files) {
      const bytes = await readArtifact(file.path);
      if (!bytes) throw new Error('Flow artifact disappeared during inspection.');
      let owner: string | undefined;
      try {
        const value = JSON.parse(bytes.toString('utf8'));
        const flow = FlowSnapshotSchema.parse(file.source === 'flow' ? value : value.flow);
        if (flow.id !== flowId) throw new Error('Flow artifact identity mismatch.');
        owner = flow.personaOwnership?.personaId;
        if (owner) owners.add(owner);
      } catch (error) {
        // Canonical records establish ownership; a damaged temporary/backup copy
        // can be erased only after another valid record establishes that owner.
        if (file.path.endsWith('.json')) throw error;
      }
      inspected.push({ path: file.path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, ownerEvidence: owner === personaId });
    }
    if (!owners.has(personaId)) continue;
    if (owners.size !== 1) throw new Error('Flow history has conflicting Persona ownership; repair it before deletion.');
    const current = await readStoredFlow(flowId);
    if (current && current.personaOwnership?.personaId !== personaId) {
      throw new Error('An owned Flow history conflicts with a shared current Flow.');
    }
    result.flowIds.push(flowId);
    // Retain ownership-bearing evidence until all unattributed residue is gone.
    // A crash then leaves enough evidence for the same deletion intent to retry.
    result.files.push(...inspected.sort((a, b) => Number(a.ownerEvidence) - Number(b.ownerEvidence) || a.path.localeCompare(b.path)));
  }
  return result;
}

export async function erasePersonaOwnedFlowFilesWithinLock(inspection: PersonaOwnedFlowInspection): Promise<void> {
  for (const file of inspection.files) {
    const current = await readArtifact(file.path);
    if (!current || createHash('sha256').update(current).digest('hex') !== file.sha256) {
      throw new Error('Flow artifact changed before Persona erasure; retry deletion.');
    }
    const entry = await checkedPath(file.path);
    if (!entry) throw new Error('Flow artifact disappeared before Persona erasure.');
    await fs.unlink(entry.target);
  }
}
