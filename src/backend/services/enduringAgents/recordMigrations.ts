import type { ZodType } from 'zod';

import {
  BEHAVIOR_BINDING_SCHEMA_VERSION,
  BEHAVIOR_MAINTENANCE_RUN_SCHEMA_VERSION,
  BEHAVIOR_OUTCOME_METRIC_SCHEMA_VERSION,
  BEHAVIOR_REVISION_SCHEMA_VERSION,
  ENDURING_AGENT_SCHEMA_VERSION,
  PERSONA_ACTIVITY_OUTCOME_SCHEMA_VERSION,
  PERSONA_ACTIVITY_SCHEMA_VERSION,
  PERSONA_SCHEMA_VERSION,
  ROLE_DEFINITION_SCHEMA_VERSION,
  ROLE_VERSION_SCHEMA_VERSION,
  type RoleBehaviorSlot,
} from '@/shared/types/enduringAgent';
import { withDefaultRoleBehaviorSlots } from './roleBehaviorDefaults';

export interface RecordMigration {
  from: number;
  to: number;
  migrate: (record: Record<string, unknown>) => Record<string, unknown>;
}

export const PERSONA_RECORD_INDEX_SCHEMA_VERSION = 2;

function migrationTo(to: number): readonly RecordMigration[] {
  return [{
    from: 1,
    to,
    migrate: (record) => ({ ...record, schemaVersion: to }),
  }];
}

/** Explicit per-record migrations keep compatibility changes reviewable. */
export const ROLE_DEFINITION_RECORD_MIGRATIONS =
  migrationTo(ROLE_DEFINITION_SCHEMA_VERSION);
export const ROLE_VERSION_RECORD_MIGRATIONS: readonly RecordMigration[] = [
  {
    from: 1,
    to: 2,
    migrate: (record) => ({ ...record, schemaVersion: 2 }),
  },
  {
    from: 2,
    to: ROLE_VERSION_SCHEMA_VERSION,
    migrate: (record) => ({
      ...record,
      schemaVersion: ROLE_VERSION_SCHEMA_VERSION,
      behaviorSlots: withDefaultRoleBehaviorSlots(
        String(record.roleDefinitionId ?? ''),
        String(record.name ?? 'Role'),
        Array.isArray(record.behaviorSlots)
          ? record.behaviorSlots as RoleBehaviorSlot[]
          : [],
      ),
    }),
  },
];
export const PERSONA_RECORD_MIGRATIONS = migrationTo(PERSONA_SCHEMA_VERSION);
export const PERSONA_RECORD_INDEX_RECORD_MIGRATIONS: readonly RecordMigration[] = [{
  from: 1,
  to: PERSONA_RECORD_INDEX_SCHEMA_VERSION,
  migrate: (record) => {
    const {
      version: _legacyVersion,
      built: _legacyBuilt,
      entries: rawEntries,
      ...rest
    } = record;
    const entries = Array.isArray(rawEntries)
      ? [...rawEntries].sort((left, right) => {
        const leftId = left && typeof left === 'object' && !Array.isArray(left)
          ? String((left as Record<string, unknown>).id ?? '')
          : '';
        const rightId = right && typeof right === 'object' && !Array.isArray(right)
          ? String((right as Record<string, unknown>).id ?? '')
          : '';
        return leftId.localeCompare(rightId);
      })
      : [];
    const generatedAt = entries.reduce((latest, entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return latest;
      const updatedAt = (entry as Record<string, unknown>).updatedAt;
      return typeof updatedAt === 'number' && Number.isSafeInteger(updatedAt)
        ? Math.max(latest, updatedAt)
        : latest;
    }, 0);
    const revision = Number.isSafeInteger(record.revision)
      ? record.revision as number
      : 0;
    return {
      ...rest,
      recordKind: 'PersonaRecordIndex',
      schemaVersion: PERSONA_RECORD_INDEX_SCHEMA_VERSION,
      revision,
      sourceRevision: revision,
      sourceCount: entries.length,
      generatedAt,
      entries,
    };
  },
}];
export const BEHAVIOR_REVISION_RECORD_MIGRATIONS =
  migrationTo(BEHAVIOR_REVISION_SCHEMA_VERSION);
export const BEHAVIOR_BINDING_RECORD_MIGRATIONS =
  migrationTo(BEHAVIOR_BINDING_SCHEMA_VERSION);

function legacyActivityOutcome(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (record.outcome !== undefined) return record.outcome as Record<string, unknown>;
  const status = record.status;
  if (status !== 'completed' && status !== 'error' && status !== 'cancelled') return undefined;
  const timestamps = [record.completedAt, record.updatedAt, record.createdAt];
  const decidedAt = timestamps.find((value) => (
    typeof value === 'number' && Number.isInteger(value) && value >= 0
  )) ?? 0;
  return {
    schemaVersion: PERSONA_ACTIVITY_OUTCOME_SCHEMA_VERSION,
    resolution: status === 'error' ? 'failed' : 'unknown',
    ...(status === 'error' ? { blockerKind: 'unknown' } : {}),
    summary: status === 'error'
      ? 'Legacy Activity failed before semantic outcomes were recorded.'
      : 'Legacy Activity has no verified semantic outcome.',
    nextAction: 'Review the original work before treating its goal as achieved.',
    decisionSource: 'legacy',
    evidenceRefs: [{ kind: 'activity', id: String(record.id ?? '') }],
    decidedAt,
  };
}

export const PERSONA_ACTIVITY_RECORD_MIGRATIONS: readonly RecordMigration[] = [{
  from: ENDURING_AGENT_SCHEMA_VERSION,
  to: PERSONA_ACTIVITY_SCHEMA_VERSION,
  migrate: (record) => {
    const outcome = legacyActivityOutcome(record);
    return {
      ...record,
      schemaVersion: PERSONA_ACTIVITY_SCHEMA_VERSION,
      ...(outcome ? { outcome } : {}),
    };
  },
}];

export function enduringAgentRecordSchemaVersion(recordKind: string): number {
  switch (recordKind) {
    case 'RoleDefinition':
      return ROLE_DEFINITION_SCHEMA_VERSION;
    case 'RoleVersion':
      return ROLE_VERSION_SCHEMA_VERSION;
    case 'Persona':
      return PERSONA_SCHEMA_VERSION;
    case 'PersonaRecordIndex':
      return PERSONA_RECORD_INDEX_SCHEMA_VERSION;
    case 'BehaviorRevision':
      return BEHAVIOR_REVISION_SCHEMA_VERSION;
    case 'BehaviorBinding':
      return BEHAVIOR_BINDING_SCHEMA_VERSION;
    case 'BehaviorMaintenanceRun':
      return BEHAVIOR_MAINTENANCE_RUN_SCHEMA_VERSION;
    case 'BehaviorOutcomeMetric':
      return BEHAVIOR_OUTCOME_METRIC_SCHEMA_VERSION;
    case 'PersonaActivity':
      return PERSONA_ACTIVITY_SCHEMA_VERSION;
    default:
      return ENDURING_AGENT_SCHEMA_VERSION;
  }
}

export function enduringAgentRecordMigrations(recordKind: string): readonly RecordMigration[] {
  switch (recordKind) {
    case 'RoleDefinition':
      return ROLE_DEFINITION_RECORD_MIGRATIONS;
    case 'RoleVersion':
      return ROLE_VERSION_RECORD_MIGRATIONS;
    case 'Persona':
      return PERSONA_RECORD_MIGRATIONS;
    case 'PersonaRecordIndex':
      return PERSONA_RECORD_INDEX_RECORD_MIGRATIONS;
    case 'BehaviorRevision':
      return BEHAVIOR_REVISION_RECORD_MIGRATIONS;
    case 'BehaviorBinding':
      return BEHAVIOR_BINDING_RECORD_MIGRATIONS;
    case 'PersonaActivity':
      return PERSONA_ACTIVITY_RECORD_MIGRATIONS;
    default:
      return [];
  }
}

export class UnsupportedEnduringAgentSchemaError extends Error {
  constructor(
    readonly recordKind: string,
    readonly foundVersion: unknown,
    readonly currentVersion: number,
  ) {
    super(
      `Unsupported ${recordKind} schema version ${JSON.stringify(foundVersion)}; `
      + `this build supports version ${currentVersion}.`,
    );
    this.name = 'UnsupportedEnduringAgentSchemaError';
  }
}

/**
 * Single additive migration choke point for every enduring-agent record.
 * Every schema transition registers an explicit N -> N+1 transform here
 * rather than teaching ordinary reads to guess at old shapes or silently
 * overwrite newer records.
 */
export function migrateAndParseRecord<T>(options: {
  recordKind: string;
  value: unknown;
  currentVersion: number;
  schema: ZodType<T>;
  migrations?: readonly RecordMigration[];
}): T {
  const { recordKind, currentVersion, schema } = options;
  if (!options.value || typeof options.value !== 'object' || Array.isArray(options.value)) {
    throw new Error(`${recordKind} must be an object`);
  }

  let record = { ...(options.value as Record<string, unknown>) };
  let version = record.schemaVersion;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new UnsupportedEnduringAgentSchemaError(recordKind, version, currentVersion);
  }
  if ((version as number) > currentVersion) {
    throw new UnsupportedEnduringAgentSchemaError(recordKind, version, currentVersion);
  }

  const migrations = new Map(
    (options.migrations ?? []).map((migration) => [migration.from, migration]),
  );
  while ((version as number) < currentVersion) {
    const migration = migrations.get(version as number);
    if (!migration || migration.to !== (version as number) + 1) {
      throw new UnsupportedEnduringAgentSchemaError(recordKind, version, currentVersion);
    }
    record = migration.migrate(record);
    version = record.schemaVersion;
    if (version !== migration.to) {
      throw new Error(
        `${recordKind} migration ${migration.from} -> ${migration.to} returned version `
        + `${JSON.stringify(version)}.`,
      );
    }
  }

  return schema.parse(record);
}
