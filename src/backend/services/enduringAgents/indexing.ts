import { promises as fs } from 'fs';
import path from 'path';

import type {
  MemoryItem,
  PersonaActivity,
  PersonaMailboxItem,
  PersonaWorkItem,
} from '@/shared/types/enduringAgent';
import { createLogger } from '@/utils/logger';
import { listCollectionItems, runInWriteChain, writeFileAtomic } from '@/utils/storage/backend';
import { getWorkspaceDataDir } from '@/utils/workspace';

import { ENDURING_AGENT_COLLECTIONS } from './collections';
import { invalidatePersonaRecordCache } from './personaRecordCache';

const log = createLogger('backend/services/enduringAgents/indexing');

export interface BasePersonaIndexEntry {
  id: string;
  personaId: string;
  updatedAt: number;
  status?: string;
  kind?: string;
}
export interface MemoryItemIndexEntry extends BasePersonaIndexEntry {
  scope?: string;
  trust?: string;
  validFrom?: number | null;
  validUntil?: number | null;
  importance?: number;
  confidence?: number;
}
export interface PersonaMailboxItemIndexEntry extends BasePersonaIndexEntry {
  priority?: string;
  notBefore?: number | null;
}
export type PersonaActivityIndexEntry = BasePersonaIndexEntry;
export interface PersonaWorkItemIndexEntry extends BasePersonaIndexEntry {
  priority?: string;
  deadline?: number | null;
}
export type IndexEntry = MemoryItemIndexEntry | PersonaMailboxItemIndexEntry
  | PersonaActivityIndexEntry | PersonaWorkItemIndexEntry;
export interface IndexFile<T extends IndexEntry> {
  version: 2;
  built: true;
  revision: number;
  generatedAt: number;
  entries: T[];
}

type IndexedRecord = MemoryItem | PersonaMailboxItem | PersonaActivity | PersonaWorkItem;
type IndexedCollection = typeof ENDURING_AGENT_COLLECTIONS.memoryItems
  | typeof ENDURING_AGENT_COLLECTIONS.mailboxItems
  | typeof ENDURING_AGENT_COLLECTIONS.activities
  | typeof ENDURING_AGENT_COLLECTIONS.workItems;

type Config<T extends IndexEntry = IndexEntry> = {
  collection: IndexedCollection;
  filename: string;
  chainKey: string;
  buildEntry: (value: unknown) => T | null;
};

function dbDir(): string { return path.join(getWorkspaceDataDir(), 'db'); }

function objectEntry(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function common(value: unknown): BasePersonaIndexEntry | null {
  const item = objectEntry(value);
  if (!item || typeof item.id !== 'string' || typeof item.personaId !== 'string') return null;
  return {
    id: item.id,
    personaId: item.personaId,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    ...(typeof item.status === 'string' ? { status: item.status } : {}),
    ...(typeof item.kind === 'string' ? { kind: item.kind } : {}),
  };
}
function memoryEntry(value: unknown): MemoryItemIndexEntry | null {
  const base = common(value); const item = objectEntry(value);
  if (!base || !item) return null;
  return {
    ...base,
    ...(typeof item.scope === 'string' ? { scope: item.scope } : {}),
    ...(typeof item.trust === 'string' ? { trust: item.trust } : {}),
    ...(typeof item.validFrom === 'number' || item.validFrom === null ? { validFrom: item.validFrom } : {}),
    ...(typeof item.validUntil === 'number' || item.validUntil === null ? { validUntil: item.validUntil } : {}),
    ...(typeof item.importance === 'number' ? { importance: item.importance } : {}),
    ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}),
  };
}
function mailboxEntry(value: unknown): PersonaMailboxItemIndexEntry | null {
  const base = common(value); const item = objectEntry(value);
  if (!base || !item) return null;
  return {
    ...base,
    ...(typeof item.priority === 'string' ? { priority: item.priority } : {}),
    ...(typeof item.notBefore === 'number' || item.notBefore === null ? { notBefore: item.notBefore } : {}),
  };
}
function activityEntry(value: unknown): PersonaActivityIndexEntry | null { return common(value); }
function workItemEntry(value: unknown): PersonaWorkItemIndexEntry | null {
  const base = common(value); const item = objectEntry(value);
  if (!base || !item) return null;
  return {
    ...base,
    ...(typeof item.priority === 'string' ? { priority: item.priority } : {}),
    ...(typeof item.deadline === 'number' || item.deadline === null ? { deadline: item.deadline } : {}),
  };
}

const CONFIGS: Record<IndexedCollection, Config> = {
  [ENDURING_AGENT_COLLECTIONS.memoryItems]: {
    collection: ENDURING_AGENT_COLLECTIONS.memoryItems,
    filename: 'persona-memories.index.json', chainKey: 'memory-index', buildEntry: memoryEntry,
  },
  [ENDURING_AGENT_COLLECTIONS.mailboxItems]: {
    collection: ENDURING_AGENT_COLLECTIONS.mailboxItems,
    filename: 'persona-mailbox.index.json', chainKey: 'mailbox-index', buildEntry: mailboxEntry,
  },
  [ENDURING_AGENT_COLLECTIONS.activities]: {
    collection: ENDURING_AGENT_COLLECTIONS.activities,
    filename: 'persona-activities.index.json', chainKey: 'activity-index', buildEntry: activityEntry,
  },
  [ENDURING_AGENT_COLLECTIONS.workItems]: {
    collection: ENDURING_AGENT_COLLECTIONS.workItems,
    filename: 'persona-work-items.index.json', chainKey: 'work-item-index', buildEntry: workItemEntry,
  },
};

function indexPath(config: Config): string { return path.join(dbDir(), config.filename); }
async function loadIndex<T extends IndexEntry>(config: Config<T>): Promise<IndexFile<T> | null> {
  try {
    const data = JSON.parse(await fs.readFile(indexPath(config), 'utf-8')) as Partial<IndexFile<T>>;
    if (data.version !== 2 || data.built !== true || !Number.isSafeInteger(data.revision)
      || !Array.isArray(data.entries)) return null;
    return data as IndexFile<T>;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      log.warn(`Could not load ${config.collection} index; rebuilding.`, error);
    }
    return null;
  }
}
async function writeIndex<T extends IndexEntry>(config: Config<T>, index: IndexFile<T>): Promise<void> {
  await writeFileAtomic(indexPath(config), JSON.stringify(index, null, 2));
}
async function buildIndex<T extends IndexEntry>(config: Config<T>, revision: number): Promise<IndexFile<T>> {
  const values = await listCollectionItems<unknown>(config.collection);
  const entries = values.map(config.buildEntry).filter((entry): entry is T => entry !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { version: 2, built: true, revision, generatedAt: Date.now(), entries };
}
async function getIndex<T extends IndexEntry>(config: Config<T>): Promise<IndexFile<T>> {
  const loaded = await loadIndex(config);
  if (loaded) return loaded;
  return runInWriteChain(config.chainKey, async () => {
    const current = await loadIndex(config);
    if (current) return current;
    const rebuilt = await buildIndex(config, 1);
    await writeIndex(config, rebuilt);
    return rebuilt;
  });
}

export const getMemoryIndex = (): Promise<IndexFile<MemoryItemIndexEntry>> =>
  getIndex(CONFIGS[ENDURING_AGENT_COLLECTIONS.memoryItems] as Config<MemoryItemIndexEntry>);
export const getMailboxIndex = (): Promise<IndexFile<PersonaMailboxItemIndexEntry>> =>
  getIndex(CONFIGS[ENDURING_AGENT_COLLECTIONS.mailboxItems] as Config<PersonaMailboxItemIndexEntry>);
export const getActivityIndex = (): Promise<IndexFile<PersonaActivityIndexEntry>> =>
  getIndex(CONFIGS[ENDURING_AGENT_COLLECTIONS.activities] as Config<PersonaActivityIndexEntry>);
export const getWorkItemIndex = (): Promise<IndexFile<PersonaWorkItemIndexEntry>> =>
  getIndex(CONFIGS[ENDURING_AGENT_COLLECTIONS.workItems] as Config<PersonaWorkItemIndexEntry>);

export async function syncIndexEntry(collection: IndexedCollection, record: IndexedRecord): Promise<void> {
  const config = CONFIGS[collection];
  await runInWriteChain(config.chainKey, async () => {
    const current = await loadIndex(config) ?? await buildIndex(config, 0);
    const entry = config.buildEntry(record);
    if (!entry) throw new Error(`Cannot index ${collection} record.`);
    current.entries = current.entries.filter((candidate) => candidate.id !== entry.id);
    current.entries.push(entry);
    current.entries.sort((a, b) => a.id.localeCompare(b.id));
    current.revision += 1;
    current.generatedAt = Date.now();
    await writeIndex(config, current);
  });
  invalidatePersonaRecordCache(collection, record.personaId);
}

export async function removeIndexEntry(collection: IndexedCollection, id: string): Promise<void> {
  const config = CONFIGS[collection];
  let personaId: string | undefined;
  await runInWriteChain(config.chainKey, async () => {
    const current = await loadIndex(config) ?? await buildIndex(config, 0);
    personaId = current.entries.find((entry) => entry.id === id)?.personaId;
    const entries = current.entries.filter((entry) => entry.id !== id);
    if (entries.length === current.entries.length) return;
    current.entries = entries;
    current.revision += 1;
    current.generatedAt = Date.now();
    await writeIndex(config, current);
  });
  if (personaId) invalidatePersonaRecordCache(collection, personaId);
}

export async function removePersonaIndexEntries(personaId: string): Promise<void> {
  await Promise.all(Object.values(CONFIGS).map(async (config) => {
    await runInWriteChain(config.chainKey, async () => {
      const current = await loadIndex(config) ?? await buildIndex(config, 0);
      const entries = current.entries.filter((entry) => entry.personaId !== personaId);
      if (entries.length === current.entries.length) return;
      current.entries = entries;
      current.revision += 1;
      current.generatedAt = Date.now();
      await writeIndex(config, current);
    });
    invalidatePersonaRecordCache(config.collection, personaId);
  }));
}

// Compatibility exports for callers introduced in earlier phases.
export const updateMemoryIndex = (item: MemoryItem): Promise<void> =>
  syncIndexEntry(ENDURING_AGENT_COLLECTIONS.memoryItems, item);
export const updateMailboxIndex = (item: PersonaMailboxItem): Promise<void> =>
  syncIndexEntry(ENDURING_AGENT_COLLECTIONS.mailboxItems, item);
export const removeMemoryIndexEntry = (id: string): Promise<void> =>
  removeIndexEntry(ENDURING_AGENT_COLLECTIONS.memoryItems, id);
export const removeMailboxIndexEntry = (id: string): Promise<void> =>
  removeIndexEntry(ENDURING_AGENT_COLLECTIONS.mailboxItems, id);
