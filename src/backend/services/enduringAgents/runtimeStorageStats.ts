import { z, type ZodType } from 'zod';

import { FEATURES } from '@/config/features';
import {
  EnduringAgentIdSchema,
  PersonaActivitySchema,
  PersonaLeaseSchema,
  PersonaMailboxItemSchema,
  type PersonaActivity,
  type PersonaLease,
  type PersonaMailboxItem,
} from '@/shared/types/enduringAgent';
import { listCollectionItemsWithStats } from '@/utils/storage/backend';
import { getCurrentWorkspace } from '@/utils/workspace';

import { ENDURING_AGENT_COLLECTIONS } from './collections';
import { PersonaFlowDispatchRecordSchema } from './personaFlowDispatchSchema';
import type { PersonaFlowDispatchRecord } from './personaDispatcher';
import { getPersonaRuntimeClock } from './runtimeClock';
import { getPersona } from './store';

const runtimeClock = getPersonaRuntimeClock();

export interface PersonaStorageKindStats {
  total: number;
  byStatus: Record<string, number>;
  compacted: number;
  uncompacted: number;
  oldestCreatedAt?: number;
  newestCreatedAt?: number;
  approxBytes: number;
}

export interface PersonaStorageStats {
  personaId: string;
  retentionEnabled: boolean;
  collectedAt: number;
  kinds: {
    mailboxItems: PersonaStorageKindStats;
    activities: PersonaStorageKindStats;
    flowDispatches: PersonaStorageKindStats;
    leaseHistory: PersonaStorageKindStats;
  };
  totals: {
    records: number;
    compacted: number;
    uncompacted: number;
    approxBytes: number;
  };
}

export type PersonaRuntimeStorageKind = keyof PersonaStorageStats['kinds'];

export interface PersonaRuntimeCompactionObservation {
  before?: PersonaStorageStats;
  compactors: Partial<Record<PersonaRuntimeStorageKind, {
    compacted: number;
    remaining: number;
  }>>;
  failures: PersonaRuntimeStorageKind[];
  after?: PersonaStorageStats;
}

export class PersonaStorageStatsNotFoundError extends Error {
  constructor() {
    super('Persona not found.');
    this.name = 'PersonaStorageStatsNotFoundError';
  }
}

export class PersonaStorageStatsUnavailableError extends Error {
  constructor() {
    super('Persona runtime storage statistics are unavailable.');
    this.name = 'PersonaStorageStatsUnavailableError';
  }
}

const RuntimeStoragePersonaIdentitySchema = z.object({
  personaId: EnduringAgentIdSchema,
});

type RuntimeStorageRecord = {
  id: string;
  personaId: string;
  compactedAt?: number;
};

type RuntimeStorageDescriptor<T extends RuntimeStorageRecord> = {
  collection: string;
  schema: ZodType<T>;
  statusOf: (record: T) => string;
  timestampOf: (record: T) => number;
  workspaceIdOf?: (record: T) => string;
};

async function collectKind<T extends RuntimeStorageRecord>(
  personaId: string,
  workspaceId: string,
  descriptor: RuntimeStorageDescriptor<T>,
): Promise<PersonaStorageKindStats> {
  const entries = await listCollectionItemsWithStats<unknown>(descriptor.collection);
  const result: PersonaStorageKindStats = {
    total: 0,
    byStatus: {},
    compacted: 0,
    uncompacted: 0,
    approxBytes: 0,
  };
  let oldestCreatedAt: number | undefined;
  let newestCreatedAt: number | undefined;

  for (const entry of entries) {
    const identity = RuntimeStoragePersonaIdentitySchema.safeParse(entry.item);
    if (!identity.success) {
      throw new PersonaStorageStatsUnavailableError();
    }
    if (identity.data.personaId !== personaId) continue;

    const parsed = descriptor.schema.safeParse(entry.item);
    if (!parsed.success) {
      throw new PersonaStorageStatsUnavailableError();
    }
    const record = parsed.data;
    if (
      record.id !== entry.id
      || (descriptor.workspaceIdOf && descriptor.workspaceIdOf(record) !== workspaceId)
    ) {
      throw new PersonaStorageStatsUnavailableError();
    }

    const status = descriptor.statusOf(record);
    const createdAt = descriptor.timestampOf(record);
    result.total += 1;
    result.byStatus[status] = (result.byStatus[status] ?? 0) + 1;
    if (record.compactedAt === undefined) {
      result.uncompacted += 1;
    } else {
      result.compacted += 1;
    }
    result.approxBytes += entry.sizeBytes;
    oldestCreatedAt = oldestCreatedAt === undefined
      ? createdAt
      : Math.min(oldestCreatedAt, createdAt);
    newestCreatedAt = newestCreatedAt === undefined
      ? createdAt
      : Math.max(newestCreatedAt, createdAt);
  }

  if (oldestCreatedAt !== undefined) result.oldestCreatedAt = oldestCreatedAt;
  if (newestCreatedAt !== undefined) result.newestCreatedAt = newestCreatedAt;
  return result;
}

const MAILBOX_DESCRIPTOR: RuntimeStorageDescriptor<PersonaMailboxItem> = {
  collection: ENDURING_AGENT_COLLECTIONS.mailboxItems,
  schema: PersonaMailboxItemSchema as ZodType<PersonaMailboxItem>,
  statusOf: (record) => record.status,
  timestampOf: (record) => record.createdAt,
};

const ACTIVITY_DESCRIPTOR: RuntimeStorageDescriptor<PersonaActivity> = {
  collection: ENDURING_AGENT_COLLECTIONS.activities,
  schema: PersonaActivitySchema as ZodType<PersonaActivity>,
  statusOf: (record) => record.status,
  timestampOf: (record) => record.createdAt,
};

const FLOW_DISPATCH_DESCRIPTOR: RuntimeStorageDescriptor<PersonaFlowDispatchRecord> = {
  collection: ENDURING_AGENT_COLLECTIONS.flowDispatches,
  schema: PersonaFlowDispatchRecordSchema as ZodType<PersonaFlowDispatchRecord>,
  statusOf: (record) => record.state,
  timestampOf: (record) => record.createdAt,
  workspaceIdOf: (record) => record.workspaceId,
};

const LEASE_HISTORY_DESCRIPTOR: RuntimeStorageDescriptor<PersonaLease> = {
  collection: ENDURING_AGENT_COLLECTIONS.leaseHistory,
  schema: PersonaLeaseSchema as ZodType<PersonaLease>,
  statusOf: (record) => record.status,
  timestampOf: (record) => record.acquiredAt,
  workspaceIdOf: (record) => record.workspaceId,
};

/**
 * Return a read-only, workspace-scoped operational snapshot for one Persona.
 * Authoritative runtime records are schema- and storage-identity validated
 * before their metadata contributes to the result.
 */
export async function getPersonaStorageStats(personaId: string): Promise<PersonaStorageStats> {
  const validatedPersonaId = EnduringAgentIdSchema.parse(personaId);
  if (!await getPersona(validatedPersonaId)) {
    throw new PersonaStorageStatsNotFoundError();
  }
  const workspaceId = getCurrentWorkspace();
  const [mailboxItems, activities, flowDispatches, leaseHistory] = await Promise.all([
    collectKind(validatedPersonaId, workspaceId, MAILBOX_DESCRIPTOR),
    collectKind(validatedPersonaId, workspaceId, ACTIVITY_DESCRIPTOR),
    collectKind(validatedPersonaId, workspaceId, FLOW_DISPATCH_DESCRIPTOR),
    collectKind(validatedPersonaId, workspaceId, LEASE_HISTORY_DESCRIPTOR),
  ]);
  const kinds = { mailboxItems, activities, flowDispatches, leaseHistory };
  const values = Object.values(kinds);

  return {
    personaId: validatedPersonaId,
    retentionEnabled: FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION,
    collectedAt: runtimeClock.now(),
    kinds,
    totals: {
      records: values.reduce((total, kind) => total + kind.total, 0),
      compacted: values.reduce((total, kind) => total + kind.compacted, 0),
      uncompacted: values.reduce((total, kind) => total + kind.uncompacted, 0),
      approxBytes: values.reduce((total, kind) => total + kind.approxBytes, 0),
    },
  };
}
