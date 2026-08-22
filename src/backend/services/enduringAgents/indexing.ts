import { promises as fs } from 'fs';
import path from 'path';

import type {
  MemoryItem,
  PersonaActivity,
  PersonaLease,
  PersonaMailboxItem,
  PersonaWorkItem,
} from '@/shared/types/enduringAgent';
import { createLogger } from '@/utils/logger';
import {
  deletePersonaCollectionShard,
  deleteShardedCollectionItem,
  listAllShardedCollectionItems,
  runInWriteChain,
  saveShardedCollectionItem,
  writeFileAtomic,
} from '@/utils/storage/backend';
import { getWorkspaceDataDir } from '@/utils/workspace';

import { ENDURING_AGENT_COLLECTIONS } from './collections';
import { invalidatePersonaRecordCache } from './personaRecordCache';
import { PERSONA_RECORD_INDEX_SCHEMA_VERSION } from './recordMigrations';

const log = createLogger('backend/services/enduringAgents/indexing');

const MEMORY_STATUSES = new Set(['candidate', 'active', 'superseded', 'forgotten']);
const MAILBOX_STATUSES = new Set(['queued', 'claimed', 'coalesced', 'completed', 'rejected']);

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
export type PersonaLeaseIndexEntry = BasePersonaIndexEntry;
export interface PersonaWorkItemIndexEntry extends BasePersonaIndexEntry {
  priority?: string;
  deadline?: number | null;
}
export type IndexEntry = MemoryItemIndexEntry | PersonaMailboxItemIndexEntry
  | PersonaActivityIndexEntry | PersonaLeaseIndexEntry | PersonaWorkItemIndexEntry;

export type IndexedCollection = typeof ENDURING_AGENT_COLLECTIONS.memoryItems
  | typeof ENDURING_AGENT_COLLECTIONS.mailboxItems
  | typeof ENDURING_AGENT_COLLECTIONS.activities
  | typeof ENDURING_AGENT_COLLECTIONS.workItems
  | typeof ENDURING_AGENT_COLLECTIONS.leaseHistory;

export interface PersonaRecordIndex<T extends IndexEntry = IndexEntry> {
  recordKind: 'PersonaRecordIndex';
  schemaVersion: typeof PERSONA_RECORD_INDEX_SCHEMA_VERSION;
  collection: IndexedCollection;
  revision: number;
  sourceRevision: number;
  sourceCount: number;
  generatedAt: number;
  entries: T[];
}

/** Compatibility name retained for Phase 4/5 callers. */
export type IndexFile<T extends IndexEntry> = PersonaRecordIndex<T>;

interface CollectionGeneration {
  schemaVersion: 1;
  collection: IndexedCollection;
  revision: number;
  sourceCount: number;
  dirty: boolean;
}

type IndexedRecord = MemoryItem | PersonaMailboxItem | PersonaActivity | PersonaWorkItem
  | PersonaLease;
type Config<T extends IndexEntry = IndexEntry> = {
  collection: IndexedCollection;
  filename: string;
  generationFilename: string;
  chainKey: string;
  buildEntry: (value: unknown) => T | null;
  validStatuses?: ReadonlySet<string>;
};

function dbDir(): string { return path.join(getWorkspaceDataDir(), 'db'); }

function objectEntry(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function common(value: unknown): BasePersonaIndexEntry | null {
  const item = objectEntry(value);
  if (!item || typeof item.id !== 'string' || item.id.length === 0
    || typeof item.personaId !== 'string' || item.personaId.length === 0
    || typeof item.updatedAt !== 'number' || !Number.isSafeInteger(item.updatedAt)
    || item.updatedAt < 0) return null;
  return {
    id: item.id,
    personaId: item.personaId,
    updatedAt: item.updatedAt,
    ...(typeof item.status === 'string' ? { status: item.status } : {}),
    ...(typeof item.kind === 'string' ? { kind: item.kind } : {}),
  };
}
function memoryEntry(value: unknown): MemoryItemIndexEntry | null {
  const base = common(value); const item = objectEntry(value);
  if (!base || !item || !base.status || !MEMORY_STATUSES.has(base.status)) return null;
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
  if (!base || !item || !base.status || !MAILBOX_STATUSES.has(base.status)) return null;
  return {
    ...base,
    ...(typeof item.priority === 'string' ? { priority: item.priority } : {}),
    ...(typeof item.notBefore === 'number' || item.notBefore === null ? { notBefore: item.notBefore } : {}),
  };
}
function activityEntry(value: unknown): PersonaActivityIndexEntry | null { return common(value); }
function leaseEntry(value: unknown): PersonaLeaseIndexEntry | null {
  const item = objectEntry(value);
  if (!item || typeof item.id !== 'string' || item.id.length === 0
    || typeof item.personaId !== 'string' || item.personaId.length === 0
    || typeof item.renewedAt !== 'number' || !Number.isSafeInteger(item.renewedAt)
    || item.renewedAt < 0) return null;
  return {
    id: item.id,
    personaId: item.personaId,
    updatedAt: item.renewedAt,
    ...(typeof item.status === 'string' ? { status: item.status } : {}),
  };
}
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
    filename: 'persona-memories.index.json',
    generationFilename: 'persona-memories.generation.json',
    chainKey: 'memory-index',
    buildEntry: memoryEntry,
    validStatuses: MEMORY_STATUSES,
  },
  [ENDURING_AGENT_COLLECTIONS.mailboxItems]: {
    collection: ENDURING_AGENT_COLLECTIONS.mailboxItems,
    filename: 'persona-mailbox.index.json',
    generationFilename: 'persona-mailbox.generation.json',
    chainKey: 'mailbox-index',
    buildEntry: mailboxEntry,
    validStatuses: MAILBOX_STATUSES,
  },
  [ENDURING_AGENT_COLLECTIONS.activities]: {
    collection: ENDURING_AGENT_COLLECTIONS.activities,
    filename: 'persona-activities.index.json',
    generationFilename: 'persona-activities.generation.json',
    chainKey: 'activity-index',
    buildEntry: activityEntry,
  },
  [ENDURING_AGENT_COLLECTIONS.workItems]: {
    collection: ENDURING_AGENT_COLLECTIONS.workItems,
    filename: 'persona-work-items.index.json',
    generationFilename: 'persona-work-items.generation.json',
    chainKey: 'work-item-index',
    buildEntry: workItemEntry,
  },
  [ENDURING_AGENT_COLLECTIONS.leaseHistory]: {
    collection: ENDURING_AGENT_COLLECTIONS.leaseHistory,
    filename: 'persona-lease-history.index.json',
    generationFilename: 'persona-lease-history.generation.json',
    chainKey: 'lease-history-index',
    buildEntry: leaseEntry,
  },
};

function indexPath(config: Config): string { return path.join(dbDir(), config.filename); }
function generationPath(config: Config): string {
  return path.join(dbDir(), config.generationFilename);
}
function deterministicGeneratedAt(entries: readonly IndexEntry[]): number {
  return entries.reduce((latest, entry) => Math.max(latest, entry.updatedAt), 0);
}
function sortedEntries<T extends IndexEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => left.id.localeCompare(right.id));
}

async function loadGeneration(config: Config): Promise<CollectionGeneration | null> {
  try {
    const value = JSON.parse(await fs.readFile(generationPath(config), 'utf8')) as unknown;
    const data = objectEntry(value);
    if (!data || data.schemaVersion !== 1 || data.collection !== config.collection
      || !Number.isSafeInteger(data.revision) || (data.revision as number) < 0
      || !Number.isSafeInteger(data.sourceCount) || (data.sourceCount as number) < 0
      || typeof data.dirty !== 'boolean') return null;
    return data as unknown as CollectionGeneration;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      log.warn(`Could not load ${config.collection} index generation; rebuilding.`, error);
    }
    return null;
  }
}

function validateIndex<T extends IndexEntry>(
  config: Config<T>,
  value: unknown,
  generation: CollectionGeneration,
): PersonaRecordIndex<T> | null {
  const data = objectEntry(value);
  if (!data || data.recordKind !== 'PersonaRecordIndex'
    || data.schemaVersion !== PERSONA_RECORD_INDEX_SCHEMA_VERSION
    || data.collection !== config.collection
    || !Number.isSafeInteger(data.revision) || (data.revision as number) < 0
    || data.sourceRevision !== data.revision
    || data.sourceRevision !== generation.revision
    || !Number.isSafeInteger(data.sourceCount) || (data.sourceCount as number) < 0
    || data.sourceCount !== generation.sourceCount
    || !Number.isSafeInteger(data.generatedAt) || (data.generatedAt as number) < 0
    || !Array.isArray(data.entries)) return null;

  const entries: T[] = [];
  const ids = new Set<string>();
  for (const valueEntry of data.entries) {
    const entry = config.buildEntry(valueEntry);
    if (!entry || ids.has(entry.id)
      || (config.validStatuses && (!entry.status || !config.validStatuses.has(entry.status)))) {
      return null;
    }
    ids.add(entry.id);
    entries.push(entry);
  }
  const sorted = sortedEntries(entries);
  if (sorted.some((entry, index) => entry.id !== entries[index]?.id)
    || data.sourceCount !== entries.length
    || data.generatedAt !== deterministicGeneratedAt(entries)) return null;
  return {
    recordKind: 'PersonaRecordIndex',
    schemaVersion: PERSONA_RECORD_INDEX_SCHEMA_VERSION,
    collection: config.collection,
    revision: data.revision as number,
    sourceRevision: data.sourceRevision as number,
    sourceCount: data.sourceCount as number,
    generatedAt: data.generatedAt as number,
    entries,
  };
}

async function loadIndex<T extends IndexEntry>(
  config: Config<T>,
  generation: CollectionGeneration | null,
): Promise<PersonaRecordIndex<T> | null> {
  if (!generation || generation.dirty) return null;
  try {
    const value = JSON.parse(await fs.readFile(indexPath(config), 'utf8')) as unknown;
    return validateIndex(config, value, generation);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      log.warn(`Could not load ${config.collection} index; rebuilding.`, error);
    }
    return null;
  }
}
async function writeGeneration(config: Config, generation: CollectionGeneration): Promise<void> {
  await writeFileAtomic(generationPath(config), JSON.stringify(generation, null, 2));
}
async function writeIndex<T extends IndexEntry>(
  config: Config<T>,
  index: PersonaRecordIndex<T>,
): Promise<void> {
  await writeFileAtomic(indexPath(config), JSON.stringify(index, null, 2));
}
async function buildIndex<T extends IndexEntry>(
  config: Config<T>,
  revision: number,
): Promise<PersonaRecordIndex<T>> {
  const values = await listAllShardedCollectionItems<unknown>(config.collection);
  const entries = sortedEntries(values
    .map(config.buildEntry)
    .filter((entry): entry is T => entry !== null));
  return {
    recordKind: 'PersonaRecordIndex',
    schemaVersion: PERSONA_RECORD_INDEX_SCHEMA_VERSION,
    collection: config.collection,
    revision,
    sourceRevision: revision,
    sourceCount: entries.length,
    generatedAt: deterministicGeneratedAt(entries),
    entries,
  };
}
async function getIndex<T extends IndexEntry>(config: Config<T>): Promise<PersonaRecordIndex<T>> {
  const generation = await loadGeneration(config);
  const loaded = await loadIndex(config, generation);
  if (loaded) return loaded;
  return runInWriteChain(config.chainKey, async () => {
    const currentGeneration = await loadGeneration(config);
    const current = await loadIndex(config, currentGeneration);
    if (current) return current;
    const revision = Math.max(1, currentGeneration?.revision ?? 0);
    const rebuilt = await buildIndex(config, revision);
    await writeIndex(config, rebuilt);
    await writeGeneration(config, {
      schemaVersion: 1,
      collection: config.collection,
      revision,
      sourceCount: rebuilt.sourceCount,
      dirty: false,
    });
    return rebuilt;
  });
}

export const getMemoryIndex = (): Promise<PersonaRecordIndex<MemoryItemIndexEntry>> =>
  getIndex(CONFIGS[ENDURING_AGENT_COLLECTIONS.memoryItems] as Config<MemoryItemIndexEntry>);
export const getMailboxIndex = (): Promise<PersonaRecordIndex<PersonaMailboxItemIndexEntry>> =>
  getIndex(CONFIGS[ENDURING_AGENT_COLLECTIONS.mailboxItems] as Config<PersonaMailboxItemIndexEntry>);
export const getActivityIndex = (): Promise<PersonaRecordIndex<PersonaActivityIndexEntry>> =>
  getIndex(CONFIGS[ENDURING_AGENT_COLLECTIONS.activities] as Config<PersonaActivityIndexEntry>);
export const getWorkItemIndex = (): Promise<PersonaRecordIndex<PersonaWorkItemIndexEntry>> =>
  getIndex(CONFIGS[ENDURING_AGENT_COLLECTIONS.workItems] as Config<PersonaWorkItemIndexEntry>);
export const getLeaseHistoryIndex = (): Promise<PersonaRecordIndex<PersonaLeaseIndexEntry>> =>
  getIndex(CONFIGS[ENDURING_AGENT_COLLECTIONS.leaseHistory] as Config<PersonaLeaseIndexEntry>);

async function mutateIndex<T extends IndexEntry>(
  config: Config<T>,
  mutateRecord: () => Promise<void>,
  mutateEntries: (entries: T[]) => T[],
): Promise<void> {
  await runInWriteChain(config.chainKey, async () => {
    const generation = await loadGeneration(config);
    const baselineRevision = generation?.revision ?? 0;
    const current = await loadIndex(config, generation)
      ?? await buildIndex(config, baselineRevision);
    const revision = Math.max(1, baselineRevision + 1);
    const dirty: CollectionGeneration = {
      schemaVersion: 1,
      collection: config.collection,
      revision,
      sourceCount: current.sourceCount,
      dirty: true,
    };
    // Validate and calculate the index transition before touching the record.
    // Ownership conflicts must fail closed without creating a second shard.
    const entries = sortedEntries(mutateEntries(current.entries));
    await writeGeneration(config, dirty);
    await mutateRecord();
    const next: PersonaRecordIndex<T> = {
      recordKind: 'PersonaRecordIndex',
      schemaVersion: PERSONA_RECORD_INDEX_SCHEMA_VERSION,
      collection: config.collection,
      revision,
      sourceRevision: revision,
      sourceCount: entries.length,
      generatedAt: deterministicGeneratedAt(entries),
      entries,
    };
    await writeIndex(config, next);
    await writeGeneration(config, {
      ...dirty,
      sourceCount: next.sourceCount,
      dirty: false,
    });
  });
}

export async function saveIndexedCollectionItem(
  collection: IndexedCollection,
  record: IndexedRecord,
): Promise<void> {
  const config = CONFIGS[collection];
  const entry = config.buildEntry(record);
  if (!entry) throw new Error(`Cannot index ${collection} record.`);
  try {
    await mutateIndex(
      config,
      () => saveShardedCollectionItem(collection, record.personaId, record.id, record),
      entries => {
        const indexedOwner = entries.find(candidate => candidate.id === entry.id)?.personaId;
        if (indexedOwner && indexedOwner !== record.personaId) {
          throw new Error(
            `Indexed ${collection} record ${JSON.stringify(record.id)} belongs to another Persona.`,
          );
        }
        return [...entries.filter(candidate => candidate.id !== entry.id), entry];
      },
    );
  } finally {
    // A record may have committed before a later index write failed. The dirty
    // generation guarantees rebuild; dropping cached records completes recovery.
    invalidatePersonaRecordCache(collection, record.personaId);
  }
}

export async function deleteIndexedCollectionItem(
  collection: IndexedCollection,
  personaId: string,
  id: string,
): Promise<void> {
  const config = CONFIGS[collection];
  try {
    await mutateIndex(
      config,
      () => deleteShardedCollectionItem(collection, personaId, id),
      entries => {
        const indexedOwner = entries.find(entry => entry.id === id)?.personaId;
        if (indexedOwner && indexedOwner !== personaId) {
          throw new Error(
            `Indexed ${collection} record ${JSON.stringify(id)} belongs to another Persona.`,
          );
        }
        return entries.filter(entry => entry.id !== id);
      },
    );
  } finally {
    invalidatePersonaRecordCache(collection, personaId);
  }
}

/**
 * Remove a Persona shard and every matching sidecar entry in one recoverable
 * mutation. Persona deletion uses this after deleting known records so a
 * clean-but-incomplete index cannot leave unindexed shard files behind.
 */
export async function deleteIndexedPersonaCollectionShard(
  collection: IndexedCollection,
  personaId: string,
): Promise<void> {
  const config = CONFIGS[collection];
  try {
    await mutateIndex(
      config,
      () => deletePersonaCollectionShard(collection, personaId),
      entries => entries.filter(entry => entry.personaId !== personaId),
    );
  } finally {
    invalidatePersonaRecordCache(collection, personaId);
  }
}

/** Compatibility helper for callers that persisted the record before indexing. */
export async function syncIndexEntry(
  collection: IndexedCollection,
  record: IndexedRecord,
): Promise<void> {
  const config = CONFIGS[collection];
  const entry = config.buildEntry(record);
  if (!entry) throw new Error(`Cannot index ${collection} record.`);
  await mutateIndex(
    config,
    async () => undefined,
    entries => [...entries.filter(candidate => candidate.id !== entry.id), entry],
  );
  invalidatePersonaRecordCache(collection, record.personaId);
}

/** Compatibility helper for callers that deleted the record before indexing. */
export async function removeIndexEntry(collection: IndexedCollection, id: string): Promise<void> {
  const config = CONFIGS[collection];
  let personaId: string | undefined;
  await mutateIndex(
    config,
    async () => undefined,
    entries => {
      personaId = entries.find(entry => entry.id === id)?.personaId;
      return entries.filter(entry => entry.id !== id);
    },
  );
  if (personaId) invalidatePersonaRecordCache(collection, personaId);
}

export async function removePersonaIndexEntries(personaId: string): Promise<void> {
  await Promise.all(Object.values(CONFIGS).map(async (config) => {
    await mutateIndex(
      config,
      async () => undefined,
      entries => entries.filter(entry => entry.personaId !== personaId),
    );
    invalidatePersonaRecordCache(config.collection, personaId);
  }));
}

export const updateMemoryIndex = (item: MemoryItem): Promise<void> =>
  syncIndexEntry(ENDURING_AGENT_COLLECTIONS.memoryItems, item);
export const updateMailboxIndex = (item: PersonaMailboxItem): Promise<void> =>
  syncIndexEntry(ENDURING_AGENT_COLLECTIONS.mailboxItems, item);
export const removeMemoryIndexEntry = (id: string): Promise<void> =>
  removeIndexEntry(ENDURING_AGENT_COLLECTIONS.memoryItems, id);
export const removeMailboxIndexEntry = (id: string): Promise<void> =>
  removeIndexEntry(ENDURING_AGENT_COLLECTIONS.mailboxItems, id);
