import type { ZodType } from 'zod';

export interface RecordMigration {
  from: number;
  to: number;
  migrate: (record: Record<string, unknown>) => Record<string, unknown>;
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
 * Version 1 has no predecessors, but future versions must register each
 * explicit N -> N+1 transform here rather than teaching ordinary reads to
 * guess at old shapes or silently overwrite newer records.
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
