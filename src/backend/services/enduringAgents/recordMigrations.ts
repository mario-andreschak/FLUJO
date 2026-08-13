import type { ZodType } from 'zod';

import {
  BEHAVIOR_BINDING_SCHEMA_VERSION,
  BEHAVIOR_REVISION_SCHEMA_VERSION,
  ENDURING_AGENT_SCHEMA_VERSION,
  PERSONA_SCHEMA_VERSION,
  ROLE_DEFINITION_SCHEMA_VERSION,
  ROLE_VERSION_SCHEMA_VERSION,
} from '@/shared/types/enduringAgent';

export interface RecordMigration {
  from: number;
  to: number;
  migrate: (record: Record<string, unknown>) => Record<string, unknown>;
}

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
export const ROLE_VERSION_RECORD_MIGRATIONS =
  migrationTo(ROLE_VERSION_SCHEMA_VERSION);
export const PERSONA_RECORD_MIGRATIONS = migrationTo(PERSONA_SCHEMA_VERSION);
export const BEHAVIOR_REVISION_RECORD_MIGRATIONS =
  migrationTo(BEHAVIOR_REVISION_SCHEMA_VERSION);
export const BEHAVIOR_BINDING_RECORD_MIGRATIONS =
  migrationTo(BEHAVIOR_BINDING_SCHEMA_VERSION);

export function enduringAgentRecordSchemaVersion(recordKind: string): number {
  switch (recordKind) {
    case 'RoleDefinition':
      return ROLE_DEFINITION_SCHEMA_VERSION;
    case 'RoleVersion':
      return ROLE_VERSION_SCHEMA_VERSION;
    case 'Persona':
      return PERSONA_SCHEMA_VERSION;
    case 'BehaviorRevision':
      return BEHAVIOR_REVISION_SCHEMA_VERSION;
    case 'BehaviorBinding':
      return BEHAVIOR_BINDING_SCHEMA_VERSION;
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
    case 'BehaviorRevision':
      return BEHAVIOR_REVISION_RECORD_MIGRATIONS;
    case 'BehaviorBinding':
      return BEHAVIOR_BINDING_RECORD_MIGRATIONS;
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
