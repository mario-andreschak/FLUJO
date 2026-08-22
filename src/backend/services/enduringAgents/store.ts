import type { ZodType } from 'zod';

import {
  BehaviorBindingSchema,
  BehaviorMaintenanceRunSchema,
  BehaviorOutcomeMetricSchema,
  BehaviorRevisionSchema,
  MemoryItemSchema,
  PersonaAppGrantSchema,
  PersonaActivitySchema,
  PersonaDeletionTombstoneSchema,
  PersonaLeaseSchema,
  PersonaMailboxItemSchema,
  PersonaSchema,
  PersonaWorkItemSchema,
  RoleDefinitionSchema,
  RoleVersionSchema,
  type BehaviorBinding,
  type BehaviorMaintenanceRun,
  type BehaviorOutcomeMetric,
  type BehaviorRevision,
  type MemoryItem,
  type Persona,
  type PersonaAppGrant,
  type PersonaActivity,
  type PersonaDeletionTombstone,
  type PersonaLease,
  type PersonaMailboxItem,
  type PersonaWorkItem,
  type RoleDefinition,
  type RoleVersion,
} from '@/shared/types/enduringAgent';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace } from '@/utils/workspace';
import {
  assertSafeCollectionId,
  deleteCollectionItem,
  listCollectionItemEntriesStrict,
  listCollectionItems,
  loadCollectionItem,
  loadShardedCollectionItem,
  runInWriteChain,
  saveCollectionItem,
  type PersonaShardedCollection,
} from '@/utils/storage/backend';

import {
  behaviorRevisionId,
  canonicalJson,
  hashBehaviorFlow,
  hashLegacyBehaviorFlow,
  roleTemplateMatchesBehaviorFlow,
  snapshotBehaviorFlow,
} from './behaviorRevisions';
import { ENDURING_AGENT_COLLECTIONS } from './collections';
import {
  type BasePersonaIndexEntry,
  deleteIndexedCollectionItem,
  getActivityIndex,
  getMailboxIndex,
  getMemoryIndex,
  getWorkItemIndex,
  saveIndexedCollectionItem,
} from './indexing';
import { loadPersonaRecords } from './personaRecordCache';
import { personaAppGrantId, personaDeletionTombstoneId } from './ids';
import {
  UnsupportedEnduringAgentSchemaError,
  enduringAgentRecordMigrations,
  enduringAgentRecordSchemaVersion,
  migrateAndParseRecord,
} from './recordMigrations';
import {
  type PersonaRuntimeLock,
  withIssuedPersonaRuntimeLockOperation,
  withPersonaRuntimeLock,
  withRoleDefinitionRuntimeLock,
} from './runtimeLock';

const log = createLogger('backend/services/enduringAgents/store');

type IdentifiedRecord = { id: string };

function parseRecord<T>(recordKind: string, schema: ZodType<T>, value: unknown): T {
  return migrateAndParseRecord({
    recordKind,
    value,
    currentVersion: enduringAgentRecordSchemaVersion(recordKind),
    schema,
    migrations: enduringAgentRecordMigrations(recordKind),
  });
}

function recordLabel(value: unknown, index: number): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string') return JSON.stringify(id);
  }
  return `item ${index + 1}`;
}

async function getRecord<T extends IdentifiedRecord>(options: {
  collection: string;
  id: string;
  recordKind: string;
  schema: ZodType<T>;
  personaId?: string;
  validate?: (record: T, raw: unknown) => void;
}): Promise<T | null> {
  assertSafeCollectionId(options.id);
  if (options.personaId) assertSafeCollectionId(options.personaId);
  const value = options.personaId
    ? await loadShardedCollectionItem<unknown | null>(
        options.collection as PersonaShardedCollection,
        options.personaId,
        options.id,
        null,
      )
    : await loadCollectionItem<unknown | null>(
        options.collection,
        options.id,
        null,
      );
  if (value === null) return null;

  const record = parseRecord(options.recordKind, options.schema, value);
  if (record.id !== options.id) {
    throw new Error(
      `${options.recordKind} storage id ${JSON.stringify(options.id)} does not match `
      + `record id ${JSON.stringify(record.id)}.`,
    );
  }
  if (
    options.personaId
    && (record as T & { personaId?: string }).personaId !== options.personaId
  ) {
    throw new Error(
      `${options.recordKind} ${JSON.stringify(options.id)} belongs to another Persona.`,
    );
  }
  options.validate?.(record, value);
  return record;
}

async function listRecords<T extends IdentifiedRecord>(options: {
  collection: string;
  recordKind: string;
  schema: ZodType<T>;
  /** Runtime authority scans fail closed instead of hiding malformed records. */
  strict?: boolean;
  validate?: (record: T, raw: unknown) => void;
}): Promise<T[]> {
  if (options.strict) {
    const entries = await listCollectionItemEntriesStrict<unknown>(options.collection);
    return entries.map(({ id, item }) => {
      const record = parseRecord(options.recordKind, options.schema, item);
      if (record.id !== id) {
        throw new Error(
          `${options.recordKind} storage id ${JSON.stringify(id)} does not match `
          + `record id ${JSON.stringify(record.id)}.`,
        );
      }
      options.validate?.(record, item);
      return record;
    }).sort((left, right) => left.id.localeCompare(right.id));
  }

  const values = await listCollectionItems<unknown>(options.collection);
  const records: T[] = [];
  values.forEach((value, index) => {
    try {
      const record = parseRecord(options.recordKind, options.schema, value);
      options.validate?.(record, value);
      records.push(record);
    } catch (error) {
      // A record from a newer schema is not ordinary bad data. Silently
      // omitting it would make an older build present an incomplete workspace
      // and could invite conflicting writes. Fail the whole read explicitly.
      if (error instanceof UnsupportedEnduringAgentSchemaError || options.strict) throw error;
      // listCollectionItems already isolates invalid JSON files. This second
      // boundary isolates records that are valid JSON but fail the versioned
      // domain schema, without logging their potentially private contents.
      log.warn(
        `Skipping invalid ${options.recordKind} ${recordLabel(value, index)} while listing.`,
        error,
      );
    }
  });

  return records.sort((left, right) => {
    const leftId = (left as { id?: unknown }).id;
    const rightId = (right as { id?: unknown }).id;
    return typeof leftId === 'string' && typeof rightId === 'string'
      ? leftId.localeCompare(rightId)
      : 0;
  });
}

function recordMutation<T>(
  collection: string,
  id: string,
  task: () => Promise<T>,
): Promise<T> {
  assertSafeCollectionId(id);
  // This is deliberately a logical key, not a captured filesystem path.
  // runInWriteChain qualifies it with the active workspace on every call.
  return runInWriteChain(`enduring-agent:${collection}/${id}`, task);
}

export interface PersonaRecordQueryOptions {
  ids?: string[];
  statuses?: string[];
  kinds?: string[];
  scopes?: string[];
  trust?: string[];
  priorities?: string[];
  validAt?: number;
  updatedSince?: number;
  dueBefore?: number;
  limit?: number;
  offset?: number;
  order?: 'updated_at' | 'memory_relevance';
  coreIds?: string[];
}

type QueryableIndexEntry = BasePersonaIndexEntry & {
  importance?: number;
  confidence?: number;
  scope?: string;
  trust?: string;
  priority?: string;
  validFrom?: number | null;
  validUntil?: number | null;
  deadline?: number | null;
};

function selectPersonaIndexEntries<T extends QueryableIndexEntry>(
  entries: T[],
  personaId: string,
  options: PersonaRecordQueryOptions,
): T[] {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(offset) || offset < 0
    || (!(limit === Number.POSITIVE_INFINITY) && (!Number.isSafeInteger(limit) || limit < 0))) {
    throw new Error('Persona record offset and limit must be non-negative integers.');
  }
  const selected = entries.filter((entry) => entry.personaId === personaId
    && (!options.ids || options.ids.includes(entry.id))
    && (!options.statuses || (entry.status !== undefined && options.statuses.includes(entry.status)))
    && (!options.kinds || (entry.kind !== undefined && options.kinds.includes(entry.kind)))
    && (!options.scopes || (entry.scope !== undefined && options.scopes.includes(entry.scope)))
    && (!options.trust || (entry.trust !== undefined && options.trust.includes(entry.trust)))
    && (!options.priorities || (entry.priority !== undefined
      && options.priorities.includes(entry.priority)))
    && (options.updatedSince === undefined || entry.updatedAt >= options.updatedSince)
    && (options.dueBefore === undefined || (entry.deadline !== undefined
      && entry.deadline !== null && entry.deadline <= options.dueBefore))
    && (options.validAt === undefined
      || ((entry.validFrom === undefined || entry.validFrom === null || entry.validFrom <= options.validAt)
        && (entry.validUntil === undefined || entry.validUntil === null
          || entry.validUntil >= options.validAt))));
  const coreIds = new Set(options.coreIds ?? []);
  selected.sort(options.order === 'memory_relevance'
    ? (left, right) => (
      (right.importance ?? 0) - (left.importance ?? 0)
      || (right.confidence ?? 0) - (left.confidence ?? 0)
      || Number(coreIds.has(right.id)) - Number(coreIds.has(left.id))
      || right.updatedAt - left.updatedAt
      || left.id.localeCompare(right.id)
    )
    : (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  return selected.slice(offset, offset + limit);
}

async function listIndexedPersonaRecords<T extends IdentifiedRecord>(options: {
  personaId: string;
  query?: PersonaRecordQueryOptions;
  collection: string;
  recordKind: string;
  schema: ZodType<T>;
  index: { revision: number; entries: QueryableIndexEntry[] };
  tolerant?: boolean;
}): Promise<T[]> {
  const entries = selectPersonaIndexEntries(
    options.index.entries,
    options.personaId,
    options.query ?? {},
  );
  const records = await loadPersonaRecords<T>({
    collection: options.collection,
    personaId: options.personaId,
    revision: options.index.revision,
    entries,
    load: async (id) => {
      try {
        const record = await getRecord({
          collection: options.collection,
          id,
          recordKind: options.recordKind,
          schema: options.schema,
          personaId: options.personaId,
        });
        if (record && (record as T & { personaId?: string }).personaId !== options.personaId) {
          throw new Error(`${options.recordKind} ${id} belongs to another Persona.`);
        }
        return record;
      } catch (error) {
        if (!options.tolerant || error instanceof UnsupportedEnduringAgentSchemaError) throw error;
        log.warn(`Skipping invalid ${options.recordKind} ${id} while listing.`, error);
        return null;
      }
    },
  });
  return records.filter((record): record is T => record !== null);
}

/**
 * Acquire every logical uniqueness key in a stable order. A record id alone is
 * not sufficient for domains whose uniqueness also includes an ordinal (for
 * example RoleVersion `(roleDefinitionId, version)` and BehaviorRevision
 * `(behaviorId, revision)`). Stable ordering keeps nested acquisitions free of
 * lock-order inversions when two candidates overlap on only one key.
 */
function compositeMutation<T>(
  keys: string[],
  task: () => Promise<T>,
): Promise<T> {
  const orderedKeys = Array.from(new Set(keys)).sort();
  const acquire = (index: number): Promise<T> => (
    index === orderedKeys.length
      ? task()
      : runInWriteChain(orderedKeys[index], () => acquire(index + 1))
  );
  return acquire(0);
}

async function saveValidatedRecord<T extends IdentifiedRecord>(options: {
  collection: string;
  recordKind: string;
  schema: ZodType<T>;
  value: T;
}): Promise<T> {
  const record = parseRecord(options.recordKind, options.schema, options.value);
  assertSafeCollectionId(record.id);
  return recordMutation(options.collection, record.id, async () => {
    await saveCollectionItem(options.collection, record.id, record);
    return record;
  });
}

async function createOrReturnIdenticalRecord<T extends IdentifiedRecord>(options: {
  collection: string;
  recordKind: string;
  schema: ZodType<T>;
  value: T;
  immutable: boolean;
  validateReferences: (record: T) => Promise<void>;
  personaId?: string;
  persist?: (record: T) => Promise<void>;
}): Promise<T> {
  const record = parseRecord(options.recordKind, options.schema, options.value);
  assertSafeCollectionId(record.id);

  return recordMutation(options.collection, record.id, async () => {
    const existing = await getRecord({
      collection: options.collection,
      id: record.id,
      recordKind: options.recordKind,
      schema: options.schema,
      personaId: options.personaId,
    });
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(record)) return existing;
      throw new Error(
        `${options.recordKind} ${JSON.stringify(record.id)} already exists with different content`
        + `${options.immutable ? ' and is immutable' : ''}.`,
      );
    }

    await options.validateReferences(record);
    if (options.persist) {
      await options.persist(record);
    } else {
      await saveCollectionItem(options.collection, record.id, record);
    }
    return record;
  });
}

export function getRoleDefinition(id: string): Promise<RoleDefinition | null> {
  return getRecord({
    collection: ENDURING_AGENT_COLLECTIONS.roleDefinitions,
    id,
    recordKind: 'RoleDefinition',
    schema: RoleDefinitionSchema,
  });
}

export function listRoleDefinitions(): Promise<RoleDefinition[]> {
  return listRecords({
    collection: ENDURING_AGENT_COLLECTIONS.roleDefinitions,
    recordKind: 'RoleDefinition',
    schema: RoleDefinitionSchema,
  });
}

export function listRoleDefinitionsStrict(): Promise<RoleDefinition[]> {
  return listRecords({
    collection: ENDURING_AGENT_COLLECTIONS.roleDefinitions,
    recordKind: 'RoleDefinition',
    schema: RoleDefinitionSchema,
    strict: true,
  });
}

export function saveRoleDefinition(record: RoleDefinition): Promise<RoleDefinition> {
  return saveValidatedRecord({
    collection: ENDURING_AGENT_COLLECTIONS.roleDefinitions,
    recordKind: 'RoleDefinition',
    schema: RoleDefinitionSchema,
    value: record,
  });
}

export function getRoleVersion(id: string): Promise<RoleVersion | null> {
  return getRecord({
    collection: ENDURING_AGENT_COLLECTIONS.roleVersions,
    id,
    recordKind: 'RoleVersion',
    schema: RoleVersionSchema,
  });
}

export async function listRoleVersions(roleDefinitionId?: string): Promise<RoleVersion[]> {
  if (roleDefinitionId !== undefined) assertSafeCollectionId(roleDefinitionId);
  const records = await listRecords({
    collection: ENDURING_AGENT_COLLECTIONS.roleVersions,
    recordKind: 'RoleVersion',
    schema: RoleVersionSchema,
  });
  return roleDefinitionId === undefined
    ? records
    : records.filter((record) => record.roleDefinitionId === roleDefinitionId);
}

export async function listRoleVersionsStrict(roleDefinitionId?: string): Promise<RoleVersion[]> {
  if (roleDefinitionId !== undefined) assertSafeCollectionId(roleDefinitionId);
  const records = await listRecords({
    collection: ENDURING_AGENT_COLLECTIONS.roleVersions,
    recordKind: 'RoleVersion',
    schema: RoleVersionSchema,
    strict: true,
  });
  return roleDefinitionId === undefined
    ? records
    : records.filter((record) => record.roleDefinitionId === roleDefinitionId);
}

export function createRoleVersion(value: RoleVersion): Promise<RoleVersion> {
  const record = parseRecord('RoleVersion', RoleVersionSchema, value);
  assertSafeCollectionId(record.id);

  return compositeMutation([
    `enduring-agent:${ENDURING_AGENT_COLLECTIONS.roleVersions}/id/${record.id}`,
    `enduring-agent:${ENDURING_AGENT_COLLECTIONS.roleVersions}/ordinal/`
      + `${record.roleDefinitionId}/${record.version}`,
  ], async () => {
    const existing = await getRoleVersion(record.id);
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(record)) return existing;
      throw new Error(
        `RoleVersion ${JSON.stringify(record.id)} already exists with different content `
        + 'and is immutable.',
      );
    }

    if (!await getRoleDefinition(record.roleDefinitionId)) {
      throw new Error(
        `RoleVersion ${JSON.stringify(record.id)} references missing RoleDefinition `
        + `${JSON.stringify(record.roleDefinitionId)} in this workspace.`,
      );
    }

    const ordinalOwner = (await listRoleVersions(record.roleDefinitionId)).find(
      (candidate) => candidate.version === record.version,
    );
    if (ordinalOwner) {
      throw new Error(
        `RoleDefinition ${JSON.stringify(record.roleDefinitionId)} already has RoleVersion `
        + `${record.version} at ${JSON.stringify(ordinalOwner.id)}.`,
      );
    }

    await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.roleVersions, record.id, record);
    return record;
  });
}

/** Delete one immutable RoleVersion only when no Persona remains pinned to it. */
export async function deleteRoleVersionRecord(id: string): Promise<void> {
  assertSafeCollectionId(id);
  const version = await getRoleVersion(id);
  if (!version) return;
  const referencingPersona = (await listPersonasStrict()).find(
    (persona) => persona.roleVersionId === version.id,
  );
  if (referencingPersona) {
    throw new Error(
      `RoleVersion ${JSON.stringify(id)} is pinned by Persona `
      + `${JSON.stringify(referencingPersona.id)}.`,
    );
  }
  await deleteCollectionItem(ENDURING_AGENT_COLLECTIONS.roleVersions, id);
}

/** Delete an empty Role family after all of its immutable versions are removed. */
export async function deleteRoleDefinitionRecord(id: string): Promise<void> {
  assertSafeCollectionId(id);
  if ((await listRoleVersionsStrict(id)).length > 0) {
    throw new Error(`RoleDefinition ${JSON.stringify(id)} still has RoleVersions.`);
  }
  await deleteCollectionItem(ENDURING_AGENT_COLLECTIONS.roleDefinitions, id);
}

export function getPersona(id: string): Promise<Persona | null> {
  return getRecord({
    collection: ENDURING_AGENT_COLLECTIONS.personas,
    id,
    recordKind: 'Persona',
    schema: PersonaSchema,
  });
}

export function listPersonas(): Promise<Persona[]> {
  return listRecords({
    collection: ENDURING_AGENT_COLLECTIONS.personas,
    recordKind: 'Persona',
    schema: PersonaSchema,
  });
}

export function listPersonasStrict(): Promise<Persona[]> {
  return listRecords({
    collection: ENDURING_AGENT_COLLECTIONS.personas,
    recordKind: 'Persona',
    schema: PersonaSchema,
    strict: true,
  });
}

export interface PersonaSummaryRecords {
  roleVersions: RoleVersion[];
  behaviorBindings: BehaviorBinding[];
  appGrants: PersonaAppGrant[];
  memoryItems: MemoryItem[];
  workItems: PersonaWorkItem[];
  activities: PersonaActivity[];
  mailboxItems: PersonaMailboxItem[];
}

/**
 * Read every collection needed by the Persona gallery once, then retain only
 * records owned by the requested bounded Persona page. This is intentionally a
 * read-only bulk projection boundary: it takes no runtime lock and performs no
 * reconciliation.
 */
export async function listPersonaSummaryRecords(
  personaIds: readonly string[],
): Promise<PersonaSummaryRecords> {
  const requested = new Set(personaIds);
  requested.forEach((personaId) => assertSafeCollectionId(personaId));
  if (requested.size === 0) {
    return {
      roleVersions: [],
      behaviorBindings: [],
      appGrants: [],
      memoryItems: [],
      workItems: [],
      activities: [],
      mailboxItems: [],
    };
  }

  const [
    roleVersions,
    behaviorBindings,
    appGrants,
    memoryItems,
    workItems,
    activities,
    mailboxItems,
  ] = await Promise.all([
    listRecords({
      collection: ENDURING_AGENT_COLLECTIONS.roleVersions,
      recordKind: 'RoleVersion',
      schema: RoleVersionSchema,
    }),
    listRecords({
      collection: ENDURING_AGENT_COLLECTIONS.behaviorBindings,
      recordKind: 'BehaviorBinding',
      schema: BehaviorBindingSchema,
      strict: true,
    }),
    listRecords({
      collection: ENDURING_AGENT_COLLECTIONS.appGrants,
      recordKind: 'PersonaAppGrant',
      schema: PersonaAppGrantSchema,
      strict: true,
    }),
    listRecords({
      collection: ENDURING_AGENT_COLLECTIONS.memoryItems,
      recordKind: 'MemoryItem',
      schema: MemoryItemSchema,
    }),
    listRecords({
      collection: ENDURING_AGENT_COLLECTIONS.workItems,
      recordKind: 'PersonaWorkItem',
      schema: PersonaWorkItemSchema,
    }),
    listRecords({
      collection: ENDURING_AGENT_COLLECTIONS.activities,
      recordKind: 'PersonaActivity',
      schema: PersonaActivitySchema,
    }),
    listRecords({
      collection: ENDURING_AGENT_COLLECTIONS.mailboxItems,
      recordKind: 'PersonaMailboxItem',
      schema: PersonaMailboxItemSchema,
      strict: true,
    }),
  ]);

  return {
    roleVersions,
    behaviorBindings: behaviorBindings.filter((record) => requested.has(record.personaId)),
    appGrants: appGrants.filter((record) => requested.has(record.personaId)),
    memoryItems: memoryItems.filter((record) => requested.has(record.personaId)),
    workItems: workItems.filter((record) => requested.has(record.personaId)),
    activities: activities.filter((record) => requested.has(record.personaId)),
    mailboxItems: mailboxItems.filter((record) => requested.has(record.personaId)),
  };
}

export async function createPersona(value: Persona): Promise<Persona> {
  const record = parseRecord('Persona', PersonaSchema, value);
  assertSafeCollectionId(record.id);
  const selectedRoleVersion = await getRoleVersion(record.roleVersionId);
  if (!selectedRoleVersion) {
    throw new Error(
      `Persona ${JSON.stringify(record.id)} references missing RoleVersion `
      + `${JSON.stringify(record.roleVersionId)} in this workspace.`,
    );
  }

  return withRoleDefinitionRuntimeLock(selectedRoleVersion.roleDefinitionId, () => (
    recordMutation(ENDURING_AGENT_COLLECTIONS.personas, record.id, async () => {
      if (await getPersonaDeletionTombstone(record.id)) {
        throw new Error(
          `Persona ${JSON.stringify(record.id)} was deleted and cannot be recreated in this workspace.`,
        );
      }
      if (await getPersona(record.id)) {
        throw new Error(`Persona ${JSON.stringify(record.id)} already exists.`);
      }
      if (!await getRoleVersion(record.roleVersionId)) {
        throw new Error(
          `Persona ${JSON.stringify(record.id)} references missing RoleVersion `
          + `${JSON.stringify(record.roleVersionId)} in this workspace.`,
        );
      }
      await assertValidCoreMemoryItems(record);
      await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.personas, record.id, record);
      return record;
    })
  ));
}

export function getPersonaDeletionTombstone(
  personaId: string,
): Promise<PersonaDeletionTombstone | null> {
  assertSafeCollectionId(personaId);
  const id = personaDeletionTombstoneId(getCurrentWorkspace(), personaId);
  return getRecord({
    collection: ENDURING_AGENT_COLLECTIONS.deletionTombstones,
    id,
    recordKind: 'PersonaDeletionTombstone',
    schema: PersonaDeletionTombstoneSchema,
  });
}

export function savePersonaDeletionTombstone(
  value: PersonaDeletionTombstone,
): Promise<PersonaDeletionTombstone> {
  const record = parseRecord(
    'PersonaDeletionTombstone',
    PersonaDeletionTombstoneSchema,
    value,
  );
  const expectedId = record.retainedPersonaId
    ? personaDeletionTombstoneId(record.workspaceId, record.retainedPersonaId)
    : record.id;
  if (record.workspaceId !== getCurrentWorkspace()) {
    throw new Error(
      `PersonaDeletionTombstone ${JSON.stringify(record.id)} belongs to another workspace.`,
    );
  }
  if (expectedId !== record.id) {
    throw new Error('PersonaDeletionTombstone id does not match its retained Persona identity.');
  }
  return recordMutation(ENDURING_AGENT_COLLECTIONS.deletionTombstones, record.id, async () => {
    const existing = await getRecord({
      collection: ENDURING_AGENT_COLLECTIONS.deletionTombstones,
      id: record.id,
      recordKind: 'PersonaDeletionTombstone',
      schema: PersonaDeletionTombstoneSchema,
    });
    if (existing) {
      const immutableExisting = {
        ...existing,
        status: undefined,
        updatedAt: undefined,
        completedAt: undefined,
      };
      const immutableCandidate = {
        ...record,
        status: undefined,
        updatedAt: undefined,
        completedAt: undefined,
      };
      if (canonicalJson(immutableExisting) !== canonicalJson(immutableCandidate)) {
        throw new Error(
          `PersonaDeletionTombstone ${JSON.stringify(record.id)} immutable audit fields changed.`,
        );
      }
      if (existing.status === 'completed' && record.status !== 'completed') {
        throw new Error(
          `PersonaDeletionTombstone ${JSON.stringify(record.id)} cannot return to deleting.`,
        );
      }
      if (record.updatedAt < existing.updatedAt) {
        throw new Error(
          `PersonaDeletionTombstone ${JSON.stringify(record.id)} updatedAt moved backwards.`,
        );
      }
    }
    await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.deletionTombstones, record.id, record);
    return record;
  });
}

async function requireWritablePersona(personaId: string, recordKind: string): Promise<Persona> {
  const persona = await getPersona(personaId);
  if (!persona) {
    throw new Error(
      `${recordKind} references missing Persona ${JSON.stringify(personaId)} in this workspace.`,
    );
  }
  if (await getPersonaDeletionTombstone(personaId)) {
    throw new Error(
      `${recordKind} cannot mutate Persona ${JSON.stringify(personaId)} while deletion is pending.`,
    );
  }
  return persona;
}

interface PersonaRoleVersionTransition {
  expectedCurrentRoleVersionId: string;
  nextRoleVersionId: string;
}

/**
 * Constrained Persona update used by runtime and administrative mutations.
 * Generic callers cannot move the immutable Role pin. The settings operation
 * must supply an exact, lock-scoped transition so an incidental whole-record
 * write can never change it.
 */
function updatePersonaRecord(
  value: Persona,
  roleTransition?: PersonaRoleVersionTransition,
): Promise<Persona> {
  const record = parseRecord('Persona', PersonaSchema, value);
  assertSafeCollectionId(record.id);

  return recordMutation(ENDURING_AGENT_COLLECTIONS.personas, record.id, async () => {
    const existing = await getPersona(record.id);
    if (!existing) {
      throw new Error(`Persona ${JSON.stringify(record.id)} does not exist.`);
    }
    if (record.createdAt !== existing.createdAt) {
      throw new Error(`Persona ${JSON.stringify(record.id)} createdAt is immutable.`);
    }
    if (
      record.roleVersionId !== existing.roleVersionId
      && (
        !roleTransition
        || roleTransition.expectedCurrentRoleVersionId !== existing.roleVersionId
        || roleTransition.nextRoleVersionId !== record.roleVersionId
      )
    ) {
      throw new Error(
        `Persona ${JSON.stringify(record.id)} cannot change RoleVersion through updatePersona.`,
      );
    }
    if (!await getRoleVersion(record.roleVersionId)) {
      throw new Error(
        `Persona ${JSON.stringify(record.id)} references missing RoleVersion `
        + `${JSON.stringify(record.roleVersionId)} in this workspace.`,
      );
    }
    await assertValidCoreMemoryItems(record);

    await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.personas, record.id, record);
    return record;
  });
}

/** Runtime-only merge path; the caller already owns the cross-process lock. */
export async function updatePersonaWithinRuntimeLock(
  value: Persona,
  lock: PersonaRuntimeLock,
): Promise<Persona> {
  // Parse and clone before the first await so the caller cannot mutate `id`
  // after capability scope validation but before the durable write.
  const record = parseRecord('Persona', PersonaSchema, value);
  return withIssuedPersonaRuntimeLockOperation(
    lock,
    record.id,
    () => updatePersonaRecord(record),
  );
}

/** Explicit Role-pin transition; callers must already own this Persona's runtime lock. */
export async function updatePersonaRoleVersionWithinRuntimeLock(
  value: Persona,
  transition: PersonaRoleVersionTransition,
  lock: PersonaRuntimeLock,
): Promise<Persona> {
  const record = parseRecord('Persona', PersonaSchema, value);
  assertSafeCollectionId(transition.expectedCurrentRoleVersionId);
  assertSafeCollectionId(transition.nextRoleVersionId);
  return withIssuedPersonaRuntimeLockOperation(
    lock,
    record.id,
    () => updatePersonaRecord(record, transition),
  );
}

/**
 * Administrative/provisioning update. It shares the Persona runtime lock and
 * fails while live work owns the actor, preventing whole-record lost updates.
 */
export function updatePersona(value: Persona): Promise<Persona> {
  const record = parseRecord('Persona', PersonaSchema, value);
  assertSafeCollectionId(record.id);
  return withPersonaRuntimeLock(record.id, async (lock) => {
    await requireWritablePersona(record.id, 'Persona update');
    const [lease, leaseHistory] = await Promise.all([
      getPersonaLease(record.id),
      listPersonaLeaseRecords(record.id),
    ]);
    const liveAcquisition = [lease, ...leaseHistory].find(
      (candidate) => candidate?.status === 'active' && candidate.expiresAt > Date.now(),
    );
    if (liveAcquisition) {
      throw new Error(
        `Persona ${JSON.stringify(record.id)} cannot be administratively updated while `
        + `Activity ${JSON.stringify(liveAcquisition.activityId)} holds its lease.`,
      );
    }
    return updatePersonaWithinRuntimeLock(record, lock);
  });
}

async function assertValidCoreMemoryItems(persona: Persona): Promise<void> {
  for (const memoryItemId of persona.coreMemoryItemIds ?? []) {
    // This is intentionally a lock-free point read. createPersona/updatePersona
    // already hold the Persona mutation key; acquiring a Memory mutation key
    // here would invert createMemoryItem's Memory -> Persona reference check.
    const memory = await getMemoryItem(persona.id, memoryItemId);
    if (!memory) {
      throw new Error(
        `Persona ${JSON.stringify(persona.id)} core memory references missing MemoryItem `
        + `${JSON.stringify(memoryItemId)} in this workspace.`,
      );
    }
    if (memory.personaId !== persona.id) {
      throw new Error(
        `Persona ${JSON.stringify(persona.id)} cannot use MemoryItem `
        + `${JSON.stringify(memoryItemId)} owned by another Persona.`,
      );
    }
    if (memory.status !== 'active') {
      throw new Error(
        `Persona ${JSON.stringify(persona.id)} core MemoryItem `
        + `${JSON.stringify(memoryItemId)} must be active.`,
      );
    }
    if (memory.trust !== 'explicit_user' && memory.trust !== 'verified_tool') {
      throw new Error(
        `Persona ${JSON.stringify(persona.id)} core MemoryItem `
        + `${JSON.stringify(memoryItemId)} must have explicit_user or verified_tool trust.`,
      );
    }
  }
}

function assertBehaviorRevisionIntegrity(
  record: BehaviorRevision,
  rawRecord: unknown = record,
): void {
  const canonicalSnapshot = snapshotBehaviorFlow(record.flowSnapshot);
  if (canonicalJson(canonicalSnapshot) !== canonicalJson(record.flowSnapshot)) {
    throw new Error(
      `BehaviorRevision ${JSON.stringify(record.id)} Flow snapshot contains `
      + 'timestamps or derived attachment state.',
    );
  }

  const rawSnapshot = rawRecord
    && typeof rawRecord === 'object'
    && !Array.isArray(rawRecord)
    && Object.prototype.hasOwnProperty.call(rawRecord, 'flowSnapshot')
    ? (rawRecord as { flowSnapshot: unknown }).flowSnapshot
    : record.flowSnapshot;
  const usesLegacyHash = rawSnapshot
    && typeof rawSnapshot === 'object'
    && !Array.isArray(rawSnapshot)
    && Object.prototype.hasOwnProperty.call(rawSnapshot, 'permissionRules');
  const expectedContentHash = usesLegacyHash
    ? hashLegacyBehaviorFlow(rawSnapshot)
    : hashBehaviorFlow(record.flowSnapshot);
  if (record.contentHash !== expectedContentHash) {
    throw new Error(`BehaviorRevision ${JSON.stringify(record.id)} content hash is invalid.`);
  }
  const expectedId = behaviorRevisionId({
    personaId: record.personaId,
    behaviorId: record.behaviorId,
    revision: record.revision,
    contentHash: record.contentHash,
  });
  if (record.id !== expectedId) {
    throw new Error(`BehaviorRevision ${JSON.stringify(record.id)} content-addressed id is invalid.`);
  }
}

export async function getBehaviorRevision(id: string): Promise<BehaviorRevision | null> {
  const record = await getRecord({
    collection: ENDURING_AGENT_COLLECTIONS.behaviorRevisions,
    id,
    recordKind: 'BehaviorRevision',
    schema: BehaviorRevisionSchema,
    validate: assertBehaviorRevisionIntegrity,
  });
  return record;
}

export async function listBehaviorRevisions(personaId?: string): Promise<BehaviorRevision[]> {
  if (personaId !== undefined) assertSafeCollectionId(personaId);
  const records = await listRecords({
    collection: ENDURING_AGENT_COLLECTIONS.behaviorRevisions,
    recordKind: 'BehaviorRevision',
    schema: BehaviorRevisionSchema,
    strict: true,
    validate: assertBehaviorRevisionIntegrity,
  });
  // Revision integrity participates in ownership and ordinal uniqueness. A
  // corrupt record must therefore fail the read closed; skipping it could let
  // a later writer reuse an owner/ordinal that is already present on disk.
  return personaId === undefined
    ? records
    : records.filter((record) => record.personaId === personaId);
}

async function assertBehaviorRevisionReferences(
  record: BehaviorRevision,
  persona: Persona,
): Promise<void> {
  if (record.source.kind === 'role_template') {
    const source = record.source;
    if (source.slotKey !== record.slotKey) {
      throw new Error(
        `BehaviorRevision ${JSON.stringify(record.id)} role-template slot does not match `
        + `its owned slot ${JSON.stringify(record.slotKey)}.`,
      );
    }
    const roleVersion = await getRoleVersion(source.roleVersionId);
    if (!roleVersion) {
      throw new Error(
        `BehaviorRevision ${JSON.stringify(record.id)} references missing RoleVersion `
        + `${JSON.stringify(source.roleVersionId)} in this workspace.`,
      );
    }
    if (persona.roleVersionId !== roleVersion.id) {
      throw new Error(
        `BehaviorRevision ${JSON.stringify(record.id)} cannot use RoleVersion `
        + `${JSON.stringify(roleVersion.id)} because Persona ${JSON.stringify(persona.id)} `
        + `is pinned to ${JSON.stringify(persona.roleVersionId)}.`,
      );
    }
    const slot = roleVersion.behaviorSlots.find(
      (candidate) => candidate.key === source.slotKey,
    );
    if (!slot || slot.flowTemplate.id !== source.templateFlowId) {
      throw new Error(
        `BehaviorRevision ${JSON.stringify(record.id)} does not identify an existing `
        + `RoleVersion slot/template (${JSON.stringify(source.slotKey)}, `
        + `${JSON.stringify(source.templateFlowId)}).`,
      );
    }
    if (!roleTemplateMatchesBehaviorFlow(slot.flowTemplate, record.flowSnapshot)) {
      throw new Error(
        `BehaviorRevision ${JSON.stringify(record.id)} Flow does not match its claimed `
        + `RoleVersion template ${JSON.stringify(source.templateFlowId)}.`,
      );
    }
  }

  if (record.source.kind === 'persona_override' && record.source.parentRevisionId) {
    const parent = await getBehaviorRevision(record.source.parentRevisionId);
    if (!parent) {
      throw new Error(
        `BehaviorRevision ${JSON.stringify(record.id)} references missing parent BehaviorRevision `
        + `${JSON.stringify(record.source.parentRevisionId)} in this workspace.`,
      );
    }
    if (
      parent.personaId !== record.personaId
      || parent.behaviorId !== record.behaviorId
      || parent.slotKey !== record.slotKey
    ) {
      throw new Error(
        `BehaviorRevision ${JSON.stringify(record.id)} parent is owned by another Persona, `
        + 'Behavior, or slot.',
      );
    }
    if (parent.revision >= record.revision) {
      throw new Error(
        `BehaviorRevision ${JSON.stringify(record.id)} parent ordinal must precede `
        + `revision ${record.revision}.`,
      );
    }
  }
}

export function createBehaviorRevision(value: BehaviorRevision): Promise<BehaviorRevision> {
  const record = parseRecord('BehaviorRevision', BehaviorRevisionSchema, value);
  assertSafeCollectionId(record.id);
  assertSafeCollectionId(record.behaviorId);
  assertBehaviorRevisionIntegrity(record);

  return compositeMutation([
    `enduring-agent:${ENDURING_AGENT_COLLECTIONS.behaviorRevisions}/id/${record.id}`,
    `enduring-agent:${ENDURING_AGENT_COLLECTIONS.behaviorRevisions}/behavior/`
      + `${record.behaviorId}`,
  ], async () => {
    const existing = await getBehaviorRevision(record.id);
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(record)) return existing;
      throw new Error(
        `BehaviorRevision ${JSON.stringify(record.id)} already exists with different content `
        + 'and is immutable.',
      );
    }

    const persona = await requireWritablePersona(
      record.personaId,
      `BehaviorRevision ${JSON.stringify(record.id)}`,
    );

    const revisions = await listBehaviorRevisions();
    const behaviorOwner = revisions.find(
      (candidate) => candidate.behaviorId === record.behaviorId,
    );
    if (
      behaviorOwner
      && (
        behaviorOwner.personaId !== record.personaId
        || behaviorOwner.slotKey !== record.slotKey
      )
    ) {
      throw new Error(
        `Behavior ${JSON.stringify(record.behaviorId)} is already owned by another Persona or slot.`,
      );
    }
    const ordinalOwner = revisions.find(
      (candidate) => candidate.behaviorId === record.behaviorId
        && candidate.revision === record.revision,
    );
    if (ordinalOwner) {
      throw new Error(
        `Behavior ${JSON.stringify(record.behaviorId)} already has revision `
        + `${record.revision} at ${JSON.stringify(ordinalOwner.id)}.`,
      );
    }

    const binding = await getBehaviorBinding(record.behaviorId);
    if (
      binding
      && (binding.personaId !== record.personaId || binding.slotKey !== record.slotKey)
    ) {
      throw new Error(
        `Behavior ${JSON.stringify(record.behaviorId)} is already bound to another Persona or slot.`,
      );
    }

    await assertBehaviorRevisionReferences(record, persona);
    await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.behaviorRevisions, record.id, record);
    return record;
  });
}

export function getBehaviorBinding(id: string): Promise<BehaviorBinding | null> {
  return getRecord({
    collection: ENDURING_AGENT_COLLECTIONS.behaviorBindings,
    id,
    recordKind: 'BehaviorBinding',
    schema: BehaviorBindingSchema,
  });
}

export async function listBehaviorBindings(personaId: string): Promise<BehaviorBinding[]> {
  assertSafeCollectionId(personaId);
  const records = await listRecords({
    collection: ENDURING_AGENT_COLLECTIONS.behaviorBindings,
    recordKind: 'BehaviorBinding',
    schema: BehaviorBindingSchema,
    strict: true,
  });
  return records.filter((record) => record.personaId === personaId);
}

function assertBindingOwnsRevision(
  binding: BehaviorBinding,
  revision: BehaviorRevision,
): void {
  if (
    revision.personaId !== binding.personaId
    || revision.behaviorId !== binding.id
    || revision.slotKey !== binding.slotKey
  ) {
    throw new Error(
      `BehaviorBinding ${JSON.stringify(binding.id)} cannot activate BehaviorRevision `
      + `${JSON.stringify(revision.id)} because its Persona, behavior, or slot ownership differs.`,
    );
  }
}

export function saveBehaviorBinding(value: BehaviorBinding): Promise<BehaviorBinding> {
  const record = parseRecord('BehaviorBinding', BehaviorBindingSchema, value);
  assertSafeCollectionId(record.id);

  return compositeMutation([
    `enduring-agent:${ENDURING_AGENT_COLLECTIONS.behaviorBindings}/id/${record.id}`,
    `enduring-agent:${ENDURING_AGENT_COLLECTIONS.behaviorBindings}/slot/`
      + `${record.personaId}/${record.slotKey}`,
  ], async () => {
    await requireWritablePersona(
      record.personaId,
      `BehaviorBinding ${JSON.stringify(record.id)}`,
    );

    const revision = await getBehaviorRevision(record.activeRevisionId);
    if (!revision) {
      throw new Error(
        `BehaviorBinding ${JSON.stringify(record.id)} references missing BehaviorRevision `
        + `${JSON.stringify(record.activeRevisionId)} in this workspace.`,
      );
    }
    assertBindingOwnsRevision(record, revision);

    const existing = await getBehaviorBinding(record.id);
    if (
      existing
      && (existing.personaId !== record.personaId || existing.slotKey !== record.slotKey)
    ) {
      throw new Error(
        `BehaviorBinding ${JSON.stringify(record.id)} is already owned by another Persona or slot.`,
      );
    }
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(record)) return existing;
      throw new Error(
        `BehaviorBinding ${JSON.stringify(record.id)} already exists; activation updates require `
        + 'an explicit compare-and-swap operation.',
      );
    }

    const slotOwner = (await listBehaviorBindings(record.personaId)).find(
      (candidate) => candidate.slotKey === record.slotKey,
    );
    if (slotOwner) {
      throw new Error(
        `Persona ${JSON.stringify(record.personaId)} already binds slot `
        + `${JSON.stringify(record.slotKey)} at ${JSON.stringify(slotOwner.id)}.`,
      );
    }

    await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.behaviorBindings, record.id, record);
    return record;
  });
}

/**
 * Atomically install a Role-default BehaviorBinding. If a binding for the same
 * Persona-owned slot already exists, return it without changing its active
 * revision. This makes factory crash recovery unable to roll back a reviewed
 * override that won the race with initialization.
 */
export function createBehaviorBindingIfAbsent(
  value: BehaviorBinding,
): Promise<BehaviorBinding> {
  const record = parseRecord('BehaviorBinding', BehaviorBindingSchema, value);
  assertSafeCollectionId(record.id);

  return compositeMutation([
    `enduring-agent:${ENDURING_AGENT_COLLECTIONS.behaviorBindings}/id/${record.id}`,
    `enduring-agent:${ENDURING_AGENT_COLLECTIONS.behaviorBindings}/slot/`
      + `${record.personaId}/${record.slotKey}`,
  ], async () => {
    await requireWritablePersona(
      record.personaId,
      `BehaviorBinding ${JSON.stringify(record.id)}`,
    );

    const revision = await getBehaviorRevision(record.activeRevisionId);
    if (!revision) {
      throw new Error(
        `BehaviorBinding ${JSON.stringify(record.id)} references missing BehaviorRevision `
        + `${JSON.stringify(record.activeRevisionId)} in this workspace.`,
      );
    }
    assertBindingOwnsRevision(record, revision);

    const existing = await getBehaviorBinding(record.id);
    if (existing) {
      if (existing.personaId !== record.personaId || existing.slotKey !== record.slotKey) {
        throw new Error(
          `BehaviorBinding ${JSON.stringify(record.id)} is already owned by another Persona or slot.`,
        );
      }
      const activeRevision = await getBehaviorRevision(existing.activeRevisionId);
      if (!activeRevision) {
        throw new Error(
          `Existing BehaviorBinding ${JSON.stringify(existing.id)} references missing `
          + `BehaviorRevision ${JSON.stringify(existing.activeRevisionId)}.`,
        );
      }
      assertBindingOwnsRevision(existing, activeRevision);
      return existing;
    }

    const slotOwner = (await listBehaviorBindings(record.personaId)).find(
      (candidate) => candidate.slotKey === record.slotKey,
    );
    if (slotOwner) {
      throw new Error(
        `Persona ${JSON.stringify(record.personaId)} already binds slot `
        + `${JSON.stringify(record.slotKey)} at ${JSON.stringify(slotOwner.id)}.`,
      );
    }

    await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.behaviorBindings, record.id, record);
    return record;
  });
}

export function getBehaviorMaintenanceRun(id: string): Promise<BehaviorMaintenanceRun | null> {
  return getRecord({
    collection: ENDURING_AGENT_COLLECTIONS.behaviorMaintenanceRuns,
    id,
    recordKind: 'BehaviorMaintenanceRun',
    schema: BehaviorMaintenanceRunSchema,
  });
}

export async function listBehaviorMaintenanceRuns(personaId?: string): Promise<BehaviorMaintenanceRun[]> {
  if (personaId !== undefined) assertSafeCollectionId(personaId);
  const records = await listRecords({
    collection: ENDURING_AGENT_COLLECTIONS.behaviorMaintenanceRuns,
    recordKind: 'BehaviorMaintenanceRun',
    schema: BehaviorMaintenanceRunSchema,
    strict: true,
  });
  return personaId === undefined
    ? records
    : records.filter((record) => record.personaId === personaId);
}

export async function saveBehaviorMaintenanceRun(
  value: BehaviorMaintenanceRun,
): Promise<BehaviorMaintenanceRun> {
  const record = parseRecord(
    'BehaviorMaintenanceRun',
    BehaviorMaintenanceRunSchema,
    value,
  );
  await requireWritablePersona(record.personaId, `BehaviorMaintenanceRun ${JSON.stringify(record.id)}`);
  return saveValidatedRecord({
    collection: ENDURING_AGENT_COLLECTIONS.behaviorMaintenanceRuns,
    recordKind: 'BehaviorMaintenanceRun',
    schema: BehaviorMaintenanceRunSchema,
    value: record,
  });
}

export function getBehaviorOutcomeMetric(id: string): Promise<BehaviorOutcomeMetric | null> {
  return getRecord({
    collection: ENDURING_AGENT_COLLECTIONS.behaviorOutcomeMetrics,
    id,
    recordKind: 'BehaviorOutcomeMetric',
    schema: BehaviorOutcomeMetricSchema,
  });
}

export async function listBehaviorOutcomeMetrics(
  personaId?: string,
): Promise<BehaviorOutcomeMetric[]> {
  if (personaId !== undefined) assertSafeCollectionId(personaId);
  const records = await listRecords({
    collection: ENDURING_AGENT_COLLECTIONS.behaviorOutcomeMetrics,
    recordKind: 'BehaviorOutcomeMetric',
    schema: BehaviorOutcomeMetricSchema,
  });
  return personaId === undefined
    ? records
    : records.filter((record) => record.personaId === personaId);
}

/** Create or replace one outcome metric. Ownership and identity are immutable. */
export function saveBehaviorOutcomeMetric(
  value: BehaviorOutcomeMetric,
): Promise<BehaviorOutcomeMetric> {
  const record = parseRecord('BehaviorOutcomeMetric', BehaviorOutcomeMetricSchema, value);
  return recordMutation(
    ENDURING_AGENT_COLLECTIONS.behaviorOutcomeMetrics,
    record.id,
    async () => {
      const existing = await getBehaviorOutcomeMetric(record.id);
      if (existing) {
        if (
          existing.personaId !== record.personaId
          || existing.proposalId !== record.proposalId
          || existing.createdAt !== record.createdAt
        ) {
          throw new Error(
            `BehaviorOutcomeMetric ${JSON.stringify(record.id)} changed immutable ownership.`,
          );
        }
        if (record.updatedAt < existing.updatedAt) {
          throw new Error(
            `BehaviorOutcomeMetric ${JSON.stringify(record.id)} updatedAt moved backwards.`,
          );
        }
      }
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.behaviorOutcomeMetrics,
        record.id,
        record,
      );
      return record;
    },
  );
}

/**
 * Serialize read-modify-write on one outcome metric so concurrent terminal
 * Activities cannot lose counter increments. Returning null from `mutate`
 * means "no change" and leaves the stored record untouched.
 */
export function mutateBehaviorOutcomeMetric(
  id: string,
  mutate: (
    current: BehaviorOutcomeMetric,
  ) => BehaviorOutcomeMetric | null | Promise<BehaviorOutcomeMetric | null>,
): Promise<BehaviorOutcomeMetric | null> {
  assertSafeCollectionId(id);
  return recordMutation(ENDURING_AGENT_COLLECTIONS.behaviorOutcomeMetrics, id, async () => {
    const current = await getBehaviorOutcomeMetric(id);
    if (!current) return null;
    const mutated = await mutate(current);
    if (!mutated) return current;
    const record = parseRecord('BehaviorOutcomeMetric', BehaviorOutcomeMetricSchema, mutated);
    if (
      record.id !== current.id
      || record.personaId !== current.personaId
      || record.proposalId !== current.proposalId
      || record.createdAt !== current.createdAt
    ) {
      throw new Error('A BehaviorOutcomeMetric update cannot change its identity or owner.');
    }
    await saveCollectionItem(
      ENDURING_AGENT_COLLECTIONS.behaviorOutcomeMetrics,
      record.id,
      record,
    );
    return record;
  });
}

export function getPersonaActivity(
  personaId: string,
  id: string,
): Promise<PersonaActivity | null> {
  return getRecord({
    collection: ENDURING_AGENT_COLLECTIONS.activities,
    personaId,
    id,
    recordKind: 'PersonaActivity',
    schema: PersonaActivitySchema,
  });
}

export async function listPersonaActivities(
  personaId: string,
  options?: PersonaRecordQueryOptions,
): Promise<PersonaActivity[]> {
  assertSafeCollectionId(personaId);
  return listIndexedPersonaRecords({
    personaId, query: options,
    collection: ENDURING_AGENT_COLLECTIONS.activities,
    recordKind: 'PersonaActivity', schema: PersonaActivitySchema,
    index: await getActivityIndex(),
  });
}

export function savePersonaActivity(value: PersonaActivity): Promise<PersonaActivity> {
  const record = parseRecord('PersonaActivity', PersonaActivitySchema, value);
  return recordMutation(ENDURING_AGENT_COLLECTIONS.activities, record.id, async () => {
    const existing = await getPersonaActivity(record.personaId, record.id);
    if (existing) {
      if (existing.personaId !== record.personaId || existing.createdAt !== record.createdAt) {
        throw new Error('PersonaActivity changed immutable ownership.');
      }
      if (record.updatedAt < existing.updatedAt) {
        throw new Error('PersonaActivity updatedAt moved backwards.');
      }
    }
    await saveIndexedCollectionItem(ENDURING_AGENT_COLLECTIONS.activities, record);
    return record;
  });
}

export function getPersonaWorkItem(
  personaId: string,
  id: string,
): Promise<PersonaWorkItem | null> {
  return getRecord({
    collection: ENDURING_AGENT_COLLECTIONS.workItems,
    personaId,
    id,
    recordKind: 'PersonaWorkItem',
    schema: PersonaWorkItemSchema,
  });
}

export async function listPersonaWorkItems(
  personaId: string,
  options?: PersonaRecordQueryOptions,
): Promise<PersonaWorkItem[]> {
  assertSafeCollectionId(personaId);
  return listIndexedPersonaRecords({
    personaId, query: options,
    collection: ENDURING_AGENT_COLLECTIONS.workItems,
    recordKind: 'PersonaWorkItem', schema: PersonaWorkItemSchema,
    index: await getWorkItemIndex(),
  });
}

export function getPersonaAppGrant(id: string): Promise<PersonaAppGrant | null> {
  return getRecord({
    collection: ENDURING_AGENT_COLLECTIONS.appGrants,
    id,
    recordKind: 'PersonaAppGrant',
    schema: PersonaAppGrantSchema,
  });
}

export async function listPersonaAppGrants(personaId: string): Promise<PersonaAppGrant[]> {
  assertSafeCollectionId(personaId);
  const records = await listRecords({
    collection: ENDURING_AGENT_COLLECTIONS.appGrants,
    recordKind: 'PersonaAppGrant',
    schema: PersonaAppGrantSchema,
    strict: true,
  });
  return records.filter((record) => record.personaId === personaId);
}

/** Persist one exact named config without creating any Flow/tool binding. */
export function createPersonaAppGrant(value: PersonaAppGrant): Promise<PersonaAppGrant> {
  const record = parseRecord('PersonaAppGrant', PersonaAppGrantSchema, value);
  assertSafeCollectionId(record.id);
  const expectedId = personaAppGrantId(record.personaId, record.mcpServerName);
  if (record.id !== expectedId) {
    throw new Error('PersonaAppGrant id does not match its Persona and MCP config identity.');
  }

  return recordMutation(ENDURING_AGENT_COLLECTIONS.appGrants, record.id, async () => {
    await requireWritablePersona(record.personaId, `PersonaAppGrant ${JSON.stringify(record.id)}`);
    const existing = await getPersonaAppGrant(record.id);
    if (existing) {
      if (
        existing.personaId === record.personaId
        && existing.mcpServerName === record.mcpServerName
      ) return existing;
      throw new Error(`PersonaAppGrant ${JSON.stringify(record.id)} already exists.`);
    }
    await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.appGrants, record.id, record);
    return record;
  });
}

/** Replace the policy on an existing exact Persona/config grant. */
export function updatePersonaAppGrant(value: PersonaAppGrant): Promise<PersonaAppGrant> {
  const record = parseRecord('PersonaAppGrant', PersonaAppGrantSchema, value);
  assertSafeCollectionId(record.id);
  const expectedId = personaAppGrantId(record.personaId, record.mcpServerName);
  if (record.id !== expectedId) {
    throw new Error('PersonaAppGrant id does not match its Persona and MCP config identity.');
  }

  return recordMutation(ENDURING_AGENT_COLLECTIONS.appGrants, record.id, async () => {
    await requireWritablePersona(record.personaId, `PersonaAppGrant ${JSON.stringify(record.id)}`);
    const existing = await getPersonaAppGrant(record.id);
    if (!existing || existing.personaId !== record.personaId) {
      throw new Error(`PersonaAppGrant ${JSON.stringify(record.id)} does not exist.`);
    }
    await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.appGrants, record.id, record);
    return record;
  });
}

export function deletePersonaAppGrantRecord(id: string): Promise<void> {
  assertSafeCollectionId(id);
  return recordMutation(ENDURING_AGENT_COLLECTIONS.appGrants, id, () => (
    deleteCollectionItem(ENDURING_AGENT_COLLECTIONS.appGrants, id)
  ));
}

async function assertValidWorkItemReferences(record: PersonaWorkItem): Promise<void> {
  await requireWritablePersona(record.personaId, `PersonaWorkItem ${JSON.stringify(record.id)}`);
  if (record.createdByActivityId) {
    const activity = await getPersonaActivity(record.personaId, record.createdByActivityId);
    if (!activity || activity.personaId !== record.personaId) {
      throw new Error(
        `PersonaWorkItem ${JSON.stringify(record.id)} references a missing or foreign Activity.`,
      );
    }
  }
  if (record.behaviorRevisionId) {
    const revision = await getBehaviorRevision(record.behaviorRevisionId);
    if (!revision || revision.personaId !== record.personaId) {
      throw new Error(
        `PersonaWorkItem ${JSON.stringify(record.id)} references a missing or foreign BehaviorRevision.`,
      );
    }
  }
  for (const dependencyId of record.dependencyIds) {
    const dependency = await getPersonaWorkItem(record.personaId, dependencyId);
    if (!dependency || dependency.personaId !== record.personaId) {
      throw new Error(
        `PersonaWorkItem ${JSON.stringify(record.id)} references a missing or foreign dependency `
        + `${JSON.stringify(dependencyId)}.`,
      );
    }
  }
}

/** Mutable WorkItem persistence. Runtime/API services provide the Persona lock. */
export function savePersonaWorkItem(value: PersonaWorkItem): Promise<PersonaWorkItem> {
  const record = parseRecord('PersonaWorkItem', PersonaWorkItemSchema, value);
  return recordMutation(ENDURING_AGENT_COLLECTIONS.workItems, record.id, async () => {
    const existing = await getPersonaWorkItem(record.personaId, record.id);
    if (existing) {
      if (existing.personaId !== record.personaId || existing.createdAt !== record.createdAt) {
        throw new Error(`PersonaWorkItem ${JSON.stringify(record.id)} changed immutable ownership.`);
      }
      if (record.updatedAt < existing.updatedAt) {
        throw new Error(`PersonaWorkItem ${JSON.stringify(record.id)} updatedAt moved backwards.`);
      }
    }
    await assertValidWorkItemReferences(record);
    await saveIndexedCollectionItem(ENDURING_AGENT_COLLECTIONS.workItems, record);
    return record;
  });
}

export class BehaviorBindingActivationNotFoundError extends Error {
  constructor(readonly recordKind: 'BehaviorBinding' | 'BehaviorRevision', readonly recordId: string) {
    super(`${recordKind} ${JSON.stringify(recordId)} was not found.`);
    this.name = 'BehaviorBindingActivationNotFoundError';
  }
}

export class BehaviorBindingActivationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BehaviorBindingActivationConflictError';
  }
}

/**
 * Atomically move one Persona-owned binding to an existing immutable revision.
 * This is intentionally compare-and-swap only; callers cannot edit revision
 * evidence or activate a revision owned by another Persona/slot.
 */
export function activateBehaviorBindingRevision(options: {
  personaId: string;
  behaviorId: string;
  revisionId: string;
  expectedActiveRevisionId: string;
}): Promise<BehaviorBinding> {
  assertSafeCollectionId(options.personaId);
  assertSafeCollectionId(options.behaviorId);
  assertSafeCollectionId(options.revisionId);
  assertSafeCollectionId(options.expectedActiveRevisionId);

  return compositeMutation([
    `enduring-agent:${ENDURING_AGENT_COLLECTIONS.behaviorBindings}/id/${options.behaviorId}`,
  ], async () => {
    await requireWritablePersona(
      options.personaId,
      `BehaviorBinding ${JSON.stringify(options.behaviorId)} activation`,
    );
    const binding = await getBehaviorBinding(options.behaviorId);
    if (!binding || binding.personaId !== options.personaId) {
      throw new BehaviorBindingActivationNotFoundError('BehaviorBinding', options.behaviorId);
    }
    if (binding.activeRevisionId !== options.expectedActiveRevisionId) {
      throw new BehaviorBindingActivationConflictError(
        `BehaviorBinding ${JSON.stringify(binding.id)} changed since it was inspected.`,
      );
    }

    const revision = await getBehaviorRevision(options.revisionId);
    if (!revision) {
      throw new BehaviorBindingActivationNotFoundError('BehaviorRevision', options.revisionId);
    }
    try {
      assertBindingOwnsRevision(binding, revision);
    } catch {
      throw new BehaviorBindingActivationConflictError(
        `BehaviorRevision ${JSON.stringify(revision.id)} does not belong to this Persona Behavior.`,
      );
    }
    if (binding.activeRevisionId === revision.id) return binding;

    const next = BehaviorBindingSchema.parse({
      ...binding,
      activeRevisionId: revision.id,
      updatedAt: Math.max(Date.now(), binding.updatedAt + 1),
    });
    await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.behaviorBindings, next.id, next);
    return next;
  });
}

export function deletePersonaWorkItemRecord(personaId: string, id: string): Promise<void> {
  assertSafeCollectionId(personaId);
  assertSafeCollectionId(id);
  return recordMutation(ENDURING_AGENT_COLLECTIONS.workItems, id, async () => {
    await deleteIndexedCollectionItem(ENDURING_AGENT_COLLECTIONS.workItems, personaId, id);
  });
}

export function getMemoryItem(personaId: string, id: string): Promise<MemoryItem | null> {
  return getRecord({
    collection: ENDURING_AGENT_COLLECTIONS.memoryItems,
    personaId,
    id,
    recordKind: 'MemoryItem',
    schema: MemoryItemSchema,
  });
}

export async function listMemoryItems(
  personaId: string,
  options?: PersonaRecordQueryOptions,
): Promise<MemoryItem[]> {
  assertSafeCollectionId(personaId);
  return listIndexedPersonaRecords({
    personaId, query: options,
    collection: ENDURING_AGENT_COLLECTIONS.memoryItems,
    recordKind: 'MemoryItem', schema: MemoryItemSchema,
    index: await getMemoryIndex(), tolerant: true,
  });
}

export async function createMemoryItem(record: MemoryItem): Promise<MemoryItem> {
  const created = await createOrReturnIdenticalRecord({
    collection: ENDURING_AGENT_COLLECTIONS.memoryItems,
    recordKind: 'MemoryItem',
    schema: MemoryItemSchema,
    value: record,
    immutable: false,
    personaId: record.personaId,
    validateReferences: async (candidate) => {
      await requireWritablePersona(
        candidate.personaId,
        `MemoryItem ${JSON.stringify(candidate.id)}`,
      );
    },
    persist: candidate => saveIndexedCollectionItem(
      ENDURING_AGENT_COLLECTIONS.memoryItems,
      candidate,
    ),
  });
  return created;
}

async function assertValidMemoryReferences(record: MemoryItem): Promise<void> {
  await requireWritablePersona(record.personaId, `MemoryItem ${JSON.stringify(record.id)}`);
  for (const relatedId of new Set([
    ...(record.supersedes ?? []),
    ...(record.conflictsWith ?? []),
    ...(record.backfillMerge?.memberIds ?? []),
    ...(record.backfillMergedInto ? [record.backfillMergedInto] : []),
  ])) {
    const related = await getMemoryItem(record.personaId, relatedId);
    if (!related || related.personaId !== record.personaId) {
      throw new Error(
        `MemoryItem ${JSON.stringify(record.id)} references missing or foreign MemoryItem `
        + `${JSON.stringify(relatedId)}.`,
      );
    }
  }
}

/** Mutable lifecycle persistence; semantic corrections still create a successor item. */
export function saveMemoryItem(value: MemoryItem): Promise<MemoryItem> {
  // expiresAt is the candidate-review deadline, and the schema rejects it on any
  // other status. Every lifecycle transition spreads the prior record
  // (`{ ...item, status: 'active' }`), so the stamp would otherwise ride along
  // and make activating, promoting, forgetting, or superseding an expiring
  // candidate fail validation. Retire the deadline with the candidacy it belongs
  // to, here at the one choke point every transition passes through.
  const normalized = value.status !== 'candidate' && value.expiresAt !== undefined
    ? (() => { const { expiresAt: _retired, ...rest } = value; return rest as MemoryItem; })()
    : value;
  const record = parseRecord('MemoryItem', MemoryItemSchema, normalized);
  return recordMutation(ENDURING_AGENT_COLLECTIONS.memoryItems, record.id, async () => {
    const existing = await getMemoryItem(record.personaId, record.id);
    if (existing) {
      if (existing.personaId !== record.personaId || existing.createdAt !== record.createdAt) {
        throw new Error(`MemoryItem ${JSON.stringify(record.id)} changed immutable ownership.`);
      }
      if (record.updatedAt < existing.updatedAt) {
        throw new Error(`MemoryItem ${JSON.stringify(record.id)} updatedAt moved backwards.`);
      }
    }
    await assertValidMemoryReferences(record);
    await saveIndexedCollectionItem(ENDURING_AGENT_COLLECTIONS.memoryItems, record);
    return record;
  });
}

export function getPersonaMailboxItem(
  personaId: string,
  id: string,
): Promise<PersonaMailboxItem | null> {
  return getRecord({
    collection: ENDURING_AGENT_COLLECTIONS.mailboxItems,
    personaId,
    id,
    recordKind: 'PersonaMailboxItem',
    schema: PersonaMailboxItemSchema,
  });
}

export async function listPersonaMailboxItems(
  personaId: string,
  options?: PersonaRecordQueryOptions,
): Promise<PersonaMailboxItem[]> {
  assertSafeCollectionId(personaId);
  return listIndexedPersonaRecords({
    personaId, query: options,
    collection: ENDURING_AGENT_COLLECTIONS.mailboxItems,
    recordKind: 'PersonaMailboxItem', schema: PersonaMailboxItemSchema,
    index: await getMailboxIndex(),
  });
}

export function savePersonaMailboxItem(value: PersonaMailboxItem): Promise<PersonaMailboxItem> {
  const record = parseRecord('PersonaMailboxItem', PersonaMailboxItemSchema, value);
  return recordMutation(ENDURING_AGENT_COLLECTIONS.mailboxItems, record.id, async () => {
    const existing = await getPersonaMailboxItem(record.personaId, record.id);
    if (existing) {
      if (existing.personaId !== record.personaId || existing.createdAt !== record.createdAt) {
        throw new Error('PersonaMailboxItem changed immutable ownership.');
      }
      if (record.updatedAt < existing.updatedAt) {
        throw new Error('PersonaMailboxItem updatedAt moved backwards.');
      }
    }
    await saveIndexedCollectionItem(ENDURING_AGENT_COLLECTIONS.mailboxItems, record);
    return record;
  });
}

/**
 * A lease is looked up by Persona ownership rather than by a caller-provided
 * lease id. The at-most-one invariant is checked even though lease mutation is
 * intentionally deferred to the fenced runtime service.
 */
export async function getPersonaLease(personaId: string): Promise<PersonaLease | null> {
  assertSafeCollectionId(personaId);
  const value = await loadCollectionItem<unknown | null>(
    ENDURING_AGENT_COLLECTIONS.leases,
    personaId,
    null,
  );
  if (value === null) return null;

  const lease = parseRecord('PersonaLease', PersonaLeaseSchema, value);
  if (lease.personaId !== personaId) {
    throw new Error(
      `PersonaLease stored for Persona ${JSON.stringify(personaId)} is owned by `
      + `${JSON.stringify(lease.personaId)}.`,
    );
  }
  if (lease.workspaceId !== getCurrentWorkspace()) {
    throw new Error(
      `PersonaLease ${JSON.stringify(lease.id)} belongs to workspace `
      + `${JSON.stringify(lease.workspaceId)}, not ${JSON.stringify(getCurrentWorkspace())}.`,
    );
  }
  return lease;
}

/** Resolve the durable acquisition record referenced by PersonaActivity.leaseId. */
export async function getPersonaLeaseRecord(id: string): Promise<PersonaLease | null> {
  const record = await getRecord({
    collection: ENDURING_AGENT_COLLECTIONS.leaseHistory,
    id,
    recordKind: 'PersonaLease',
    schema: PersonaLeaseSchema,
  });
  if (record && record.workspaceId !== getCurrentWorkspace()) {
    throw new Error(
      `PersonaLease ${JSON.stringify(record.id)} belongs to workspace `
      + `${JSON.stringify(record.workspaceId)}, not ${JSON.stringify(getCurrentWorkspace())}.`,
    );
  }
  return record;
}

export async function listPersonaLeaseRecords(personaId: string): Promise<PersonaLease[]> {
  assertSafeCollectionId(personaId);
  const records = await listRecords({
    collection: ENDURING_AGENT_COLLECTIONS.leaseHistory,
    recordKind: 'PersonaLease',
    schema: PersonaLeaseSchema,
    strict: true,
  });
  for (const record of records) {
    if (record.workspaceId !== getCurrentWorkspace()) {
      throw new Error(
        `PersonaLease ${JSON.stringify(record.id)} belongs to workspace `
        + `${JSON.stringify(record.workspaceId)}, not ${JSON.stringify(getCurrentWorkspace())}.`,
      );
    }
  }
  return records.filter((record) => record.personaId === personaId);
}

export function savePersonaLease(value: PersonaLease): Promise<PersonaLease> {
  const record = parseRecord('PersonaLease', PersonaLeaseSchema, value);
  return recordMutation(ENDURING_AGENT_COLLECTIONS.leaseHistory, record.id, async () => {
    const existing = await getPersonaLeaseRecord(record.id);
    if (existing) {
      if (existing.personaId !== record.personaId || existing.acquiredAt !== record.acquiredAt) {
        throw new Error('PersonaLease changed immutable ownership.');
      }
      if (record.renewedAt < existing.renewedAt) {
        throw new Error('PersonaLease renewedAt moved backwards.');
      }
    }
    await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.leaseHistory, record.id, record);
    return record;
  });
}

export interface PersonaBundle {
  persona: Persona;
  roleVersion: RoleVersion;
  behaviorBindings: BehaviorBinding[];
  /** Complete immutable revision history for inspectability and rollback. */
  behaviorRevisions: BehaviorRevision[];
  /** Direct-device grants only; never merged into Behavior execution authority. */
  appGrants: PersonaAppGrant[];
  memoryItems: MemoryItem[];
  workItems: PersonaWorkItem[];
  activities: PersonaActivity[];
  mailboxItems: PersonaMailboxItem[];
  /** Inspection-only state; deliberately omits the opaque holder capability. */
  lease: PersonaLeaseInspection | null;
}

export type PersonaLeaseInspection = Omit<PersonaLease, 'id' | 'holderId'>;

function inspectPersonaLease(lease: PersonaLease | null): PersonaLeaseInspection | null {
  if (!lease) return null;
  const { id: _id, holderId: _holderId, ...inspection } = lease;
  return inspection;
}

export async function listPersonaBundle(personaId: string): Promise<PersonaBundle | null> {
  assertSafeCollectionId(personaId);
  const persona = await getPersona(personaId);
  if (!persona) return null;

  const [
    roleVersion,
    behaviorBindings,
    behaviorRevisions,
    appGrants,
    memoryItems,
    workItems,
    activities,
    mailboxItems,
    lease,
  ] = await Promise.all([
    getRoleVersion(persona.roleVersionId),
    listBehaviorBindings(personaId),
    listBehaviorRevisions(personaId),
    listPersonaAppGrants(personaId),
    listMemoryItems(personaId),
    listPersonaWorkItems(personaId),
    listPersonaActivities(personaId),
    listPersonaMailboxItems(personaId),
    getPersonaLease(personaId),
  ]);

  if (!roleVersion) {
    throw new Error(
      `Persona ${JSON.stringify(persona.id)} references missing RoleVersion `
      + `${JSON.stringify(persona.roleVersionId)} in this workspace.`,
    );
  }

  await Promise.all(behaviorBindings.map(async (binding) => {
    const revision = await getBehaviorRevision(binding.activeRevisionId);
    if (!revision) {
      throw new Error(
        `BehaviorBinding ${JSON.stringify(binding.id)} references missing BehaviorRevision `
        + `${JSON.stringify(binding.activeRevisionId)} in this workspace.`,
      );
    }
    assertBindingOwnsRevision(binding, revision);
  }));

  return {
    persona,
    roleVersion,
    behaviorBindings,
    behaviorRevisions: behaviorRevisions.sort((left, right) => (
      left.slotKey.localeCompare(right.slotKey)
      || right.revision - left.revision
      || left.id.localeCompare(right.id)
    )),
    appGrants: appGrants.sort((left, right) => (
      left.mcpServerName.localeCompare(right.mcpServerName) || left.id.localeCompare(right.id)
    )),
    memoryItems,
    workItems,
    activities,
    mailboxItems,
    lease: inspectPersonaLease(lease),
  };
}
