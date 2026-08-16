/**
 * Per-Persona index sidecars to eliminate full-collection scans.
 * Issue #449: https://github.com/mario-andreschak/FLUJO/issues/449
 *
 * Instead of partitioning directories (which would require threading personaId
 * through ~50 call sites), we maintain a persisted index per collection:
 *
 *   db/persona-memories.index.json  → MemoryItemIndexEntry[]
 *   db/persona-mailbox.index.json   → PersonaMailboxItemIndexEntry[]
 *
 * Each entry stores (id, personaId, status, updatedAt) to filter which records
 * to load without scanning the entire collection.
 *
 * Index is lazy-rebuilt on first read if missing (backward-compatible).
 * Incremental updates happen within recordMutation() for saveMemoryItem(), etc.
 */

import { promises as fs } from 'fs';
import path from 'path';

import type { MemoryItem, PersonaMailboxItem } from '@/shared/types/enduringAgent';
import { createLogger } from '@/utils/logger';
import { getWorkspaceDataDir } from '@/utils/workspace';
import {
  listCollectionItems,
  runInWriteChain,
  writeFileAtomic,
} from '@/utils/storage/backend';

const log = createLogger('backend/services/enduringAgents/indexing');

/**
 * Index entry format: minimal metadata to filter records without loading them.
 * Keyed by (id) to enable O(1) update on save.
 */
export interface MemoryItemIndexEntry {
  id: string;
  personaId: string;
  /** Presence-tracking for quick active-item filtering. */
  status?: 'active' | 'archived' | 'deleted';
  updatedAt: number;
}

export interface PersonaMailboxItemIndexEntry {
  id: string;
  personaId: string;
  /** Presence-tracking for quick unprocessed-item filtering. */
  status?: 'pending' | 'completed' | 'abandoned';
  updatedAt: number;
}

export type IndexEntry = MemoryItemIndexEntry | PersonaMailboxItemIndexEntry;

/**
 * Index container; versioned so schema changes don't corrupt on-disk files.
 */
interface IndexFile<T extends IndexEntry> {
  version: 1;
  generatedAt: number;
  entries: T[];
}

/**
 * Paths to index files.
 */
function dbDir(): string {
  return path.join(getWorkspaceDataDir(), 'db');
}

function memoryIndexPath(): string {
  return path.join(dbDir(), 'persona-memories.index.json');
}

function mailboxIndexPath(): string {
  return path.join(dbDir(), 'persona-mailbox.index.json');
}

/**
 * Load index from disk, or empty array if not yet built.
 */
async function loadIndex<T extends IndexEntry>(
  indexPath: string,
): Promise<IndexFile<T>> {
  try {
    const content = await fs.readFile(indexPath, 'utf-8');
    const data = JSON.parse(content);
    if (typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Invalid index file at ${indexPath}`);
    }
    if (!('version' in data) || data.version !== 1) {
      throw new Error(`Unsupported index version at ${indexPath}`);
    }
    return data as IndexFile<T>;
  } catch (error) {
    // File doesn't exist or is malformed - return empty index
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { version: 1, generatedAt: Date.now(), entries: [] };
    }
    log.warn(`Could not load index from ${indexPath}, rebuilding`, error);
    return { version: 1, generatedAt: Date.now(), entries: [] };
  }
}

/**
 * Build index from scratch by scanning entire collection.
 * Called once on startup or first read if index is missing.
 */
async function rebuildIndex<T extends IndexEntry>(
  collection: string,
  indexPath: string,
  buildEntry: (item: unknown) => T | null,
  chainKey: string,
): Promise<IndexFile<T>> {
  return runInWriteChain(chainKey, async () => {
    // Re-check within the write chain; another request may have built it.
    const existing = await loadIndex<T>(indexPath);
    if (existing.entries.length > 0) {
      return existing;
    }

    log.info(`Rebuilding index for collection ${collection}`);
    const items = await listCollectionItems<unknown>(collection);
    const entries: T[] = [];

    for (const item of items) {
      try {
        const entry = buildEntry(item);
        if (entry) {
          entries.push(entry);
        }
      } catch (error) {
        // Silently skip items that fail to parse during index rebuild.
        // The normal read path will isolate the bad item with better logging.
        log.debug(`Skipping item during index rebuild`, error);
      }
    }

    const index: IndexFile<T> = {
      version: 1,
      generatedAt: Date.now(),
      entries: entries.sort((a, b) => a.id.localeCompare(b.id)),
    };

    // Write directly: this already runs inside the chain for `chainKey`, and
    // runInWriteChain is NOT re-entrant — going through saveIndex here would
    // queue behind the very task making the call and deadlock it forever.
    await writeIndex(indexPath, index);
    return index;
  });
}

/** Persist index to disk atomically. Callers must hold the index write chain. */
async function writeIndex<T extends IndexEntry>(
  indexPath: string,
  index: IndexFile<T>,
): Promise<void> {
  await writeFileAtomic(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Persist index to disk atomically within a write chain.
 * Called after rebuild or incremental update.
 */
async function saveIndex<T extends IndexEntry>(
  indexPath: string,
  index: IndexFile<T>,
  chainKey: string,
): Promise<void> {
  return runInWriteChain(chainKey, () => writeIndex(indexPath, index));
}

/**
 * Get or rebuild memory index.
 */
export async function getMemoryIndex(): Promise<IndexFile<MemoryItemIndexEntry>> {
  const indexPath = memoryIndexPath();
  const existing = await loadIndex<MemoryItemIndexEntry>(indexPath);

  // If index is populated, return it.
  if (existing.entries.length > 0) {
    return existing;
  }

  // Rebuild on first read if empty.
  return rebuildIndex<MemoryItemIndexEntry>(
    'persona-memories',
    indexPath,
    (item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }
      const obj = item as Record<string, unknown>;
      const id = obj.id;
      const personaId = obj.personaId;
      const status = obj.status;
      const updatedAt = obj.updatedAt;

      if (typeof id !== 'string' || typeof personaId !== 'string') {
        return null;
      }

      return {
        id,
        personaId,
        ...(status ? { status: status as 'active' | 'archived' | 'deleted' } : {}),
        updatedAt: typeof updatedAt === 'number' ? updatedAt : Date.now(),
      };
    },
    'memory-index',
  );
}

/**
 * Get or rebuild mailbox index.
 */
export async function getMailboxIndex(): Promise<IndexFile<PersonaMailboxItemIndexEntry>> {
  const indexPath = mailboxIndexPath();
  const existing = await loadIndex<PersonaMailboxItemIndexEntry>(indexPath);

  // If index is populated, return it.
  if (existing.entries.length > 0) {
    return existing;
  }

  // Rebuild on first read if empty.
  return rebuildIndex<PersonaMailboxItemIndexEntry>(
    'persona-mailbox',
    indexPath,
    (item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }
      const obj = item as Record<string, unknown>;
      const id = obj.id;
      const personaId = obj.personaId;
      const status = obj.status;
      const updatedAt = obj.updatedAt;

      if (typeof id !== 'string' || typeof personaId !== 'string') {
        return null;
      }

      return {
        id,
        personaId,
        ...(status ? { status: status as 'pending' | 'completed' | 'abandoned' } : {}),
        updatedAt: typeof updatedAt === 'number' ? updatedAt : Date.now(),
      };
    },
    'mailbox-index',
  );
}

/**
 * Update an index entry after a record is saved.
 * Called incrementally within recordMutation() to keep index in sync.
 */
export async function updateMemoryIndex(
  item: MemoryItem,
): Promise<void> {
  const indexPath = memoryIndexPath();
  const index = await getMemoryIndex();

  // Find or create entry.
  let entry = index.entries.find((e) => e.id === item.id);
  if (!entry) {
    entry = {
      id: item.id,
      personaId: item.personaId,
      status: item.status as 'active' | 'archived' | 'deleted' | undefined,
      updatedAt: item.updatedAt,
    };
    index.entries.push(entry);
  } else {
    // Update existing entry.
    entry.personaId = item.personaId;
    entry.status = item.status as 'active' | 'archived' | 'deleted' | undefined;
    entry.updatedAt = item.updatedAt;
  }

  // Keep sorted by id.
  index.entries.sort((a, b) => a.id.localeCompare(b.id));
  index.generatedAt = Date.now();

  await saveIndex(indexPath, index, 'memory-index');
}

/**
 * Update an index entry after a mailbox item is saved.
 */
export async function updateMailboxIndex(
  item: PersonaMailboxItem,
): Promise<void> {
  const indexPath = mailboxIndexPath();
  const index = await getMailboxIndex();

  // Find or create entry.
  let entry = index.entries.find((e) => e.id === item.id);
  if (!entry) {
    entry = {
      id: item.id,
      personaId: item.personaId,
      status: item.status as 'pending' | 'completed' | 'abandoned' | undefined,
      updatedAt: item.updatedAt,
    };
    index.entries.push(entry);
  } else {
    // Update existing entry.
    entry.personaId = item.personaId;
    entry.status = item.status as 'pending' | 'completed' | 'abandoned' | undefined;
    entry.updatedAt = item.updatedAt;
  }

  // Keep sorted by id.
  index.entries.sort((a, b) => a.id.localeCompare(b.id));
  index.generatedAt = Date.now();

  await saveIndex(indexPath, index, 'mailbox-index');
}

/**
 * Remove an entry from an index (e.g., on deletion).
 */
export async function removeMemoryIndexEntry(id: string): Promise<void> {
  const indexPath = memoryIndexPath();
  const index = await getMemoryIndex();

  index.entries = index.entries.filter((e) => e.id !== id);
  index.generatedAt = Date.now();

  await saveIndex(indexPath, index, 'memory-index');
}

/**
 * Remove an entry from mailbox index.
 */
export async function removeMailboxIndexEntry(id: string): Promise<void> {
  const indexPath = mailboxIndexPath();
  const index = await getMailboxIndex();

  index.entries = index.entries.filter((e) => e.id !== id);
  index.generatedAt = Date.now();

  await saveIndex(indexPath, index, 'mailbox-index');
}
