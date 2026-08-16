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

export interface PersonaHomeInspection {
  exists: boolean;
  fileCount: number;
  totalBytes: number;
}

async function assertPersonaHomeBoundary(personaId: string): Promise<string> {
  const home = path.resolve(getPersonaHome(personaId));
  const parent = path.resolve(getWorkspaceDataDir(), 'userdata', 'personas');
  const relative = path.relative(parent, home);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Persona home escapes its workspace boundary: ${home}`);
  }
  return home;
}

export async function inspectPersonaHome(personaId: string): Promise<PersonaHomeInspection> {
  const home = await assertPersonaHomeBoundary(personaId);
  let root;
  try {
    root = await fs.lstat(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, fileCount: 0, totalBytes: 0 };
    }
    throw error;
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(`Persona home must be a real directory: ${home}`);
  }

  let fileCount = 0;
  let totalBytes = 0;
  const pending = [home];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await fs.readdir(directory)) {
      const child = path.join(directory, entry);
      const stats = await fs.lstat(child);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        pending.push(child);
      } else {
        fileCount += 1;
        totalBytes += stats.size;
      }
    }
  }
  return { exists: true, fileCount, totalBytes };
}

/** Erase only the validated Persona-owned home; shared workspace trees are untouched. */
export async function deletePersonaHome(personaId: string): Promise<void> {
  const home = await assertPersonaHomeBoundary(personaId);
  const inspected = await inspectPersonaHome(personaId);
  if (!inspected.exists) return;
  await fs.rm(home, { recursive: true, force: true });
}
