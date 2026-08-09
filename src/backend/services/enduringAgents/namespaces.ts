import path from 'path';
import { promises as fs } from 'fs';

import { assertSafeCollectionId } from '@/utils/storage/backend';
import {
  ensureWorkspaceDirs,
  getCurrentWorkspace,
  getWorkspaceDataDir,
  getWorkspaceDbDir,
} from '@/utils/workspace';
import { ENDURING_AGENT_COLLECTIONS } from './collections';

async function ensureLinkFreeChild(boundary: string, segments: readonly string[]): Promise<string> {
  const resolvedBoundary = path.resolve(boundary);
  let current = resolvedBoundary;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Persona namespace must be a real directory: ${current}`);
    }
  }

  const [canonicalBoundary, canonicalChild] = await Promise.all([
    fs.realpath(resolvedBoundary),
    fs.realpath(current),
  ]);
  const relative = path.relative(canonicalBoundary, canonicalChild);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Persona namespace escapes its workspace boundary: ${current}`);
  }
  return current;
}

/**
 * Materialize the durable namespaces a Persona factory owns. Collection paths
 * are fixed constants; the only caller-controlled segment is validated by the
 * same rule used for every collection item before it becomes a directory name.
 */
export async function ensurePersonaNamespaces(personaId: string): Promise<void> {
  assertSafeCollectionId(personaId);
  await ensureWorkspaceDirs(getCurrentWorkspace());
  const db = getWorkspaceDbDir();
  const workspace = getWorkspaceDataDir();
  await Promise.all([
    ...Object.values(ENDURING_AGENT_COLLECTIONS)
      .map((collection) => ensureLinkFreeChild(db, [collection])),
    ensureLinkFreeChild(workspace, ['userdata', 'personas', personaId]),
  ]);
}

export function getPersonaHome(personaId: string): string {
  assertSafeCollectionId(personaId);
  return path.join(getWorkspaceDataDir(), 'userdata', 'personas', personaId);
}
