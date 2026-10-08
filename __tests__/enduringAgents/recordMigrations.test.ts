import { z } from 'zod';

import {
  PERSONA_ACTIVITY_RECORD_MIGRATIONS,
  PERSONA_RECORD_INDEX_RECORD_MIGRATIONS,
  PERSONA_RECORD_INDEX_SCHEMA_VERSION,
  enduringAgentRecordMigrations,
  enduringAgentRecordSchemaVersion,
  migrateAndParseRecord,
} from '@/backend/services/enduringAgents/recordMigrations';
import {
  PERSONA_ACTIVITY_SCHEMA_VERSION,
  PersonaActivitySchema,
  type PersonaActivity,
} from '@/shared/types/enduringAgent';

function legacyActivity(
  status: 'queued' | 'completed' | 'error' | 'cancelled',
): Record<string, unknown> {
  const terminal = status === 'completed' || status === 'error' || status === 'cancelled';
  return {
    schemaVersion: 1,
    id: 'activity_legacy_' + status,
    personaId: 'persona_legacy',
    kind: 'assignment',
    status,
    source: { kind: 'assignment', sourceId: 'work_legacy' },
    createdAt: 100,
    updatedAt: terminal ? 200 : 100,
    ...(terminal ? { startedAt: 150, completedAt: 200 } : {}),
    ...(status === 'error' ? { error: 'Legacy runtime error.' } : {}),
  };
}

function migrate(value: Record<string, unknown>): PersonaActivity {
  return migrateAndParseRecord({
    recordKind: 'PersonaActivity',
    value,
    currentVersion: enduringAgentRecordSchemaVersion('PersonaActivity'),
    migrations: enduringAgentRecordMigrations('PersonaActivity'),
    schema: PersonaActivitySchema,
  });
}

describe('PersonaActivity record migrations', () => {
  it('maps completed legacy Activities to unknown, never succeeded', () => {
    const migrated = migrate(legacyActivity('completed'));
    expect(migrated).toMatchObject({
      schemaVersion: PERSONA_ACTIVITY_SCHEMA_VERSION,
      status: 'completed',
      outcome: {
        schemaVersion: 1,
        resolution: 'unknown',
        decisionSource: 'legacy',
        decidedAt: 200,
      },
    });
    expect(migrated.outcome?.resolution).not.toBe('succeeded');
  });

  it('maps errored legacy Activities to failed', () => {
    expect(migrate(legacyActivity('error'))).toMatchObject({
      schemaVersion: PERSONA_ACTIVITY_SCHEMA_VERSION,
      status: 'error',
      outcome: {
        resolution: 'failed',
        blockerKind: 'unknown',
        decisionSource: 'legacy',
      },
    });
  });

  it('maps cancelled legacy Activities conservatively and leaves nonterminal records outcome-free', () => {
    expect(migrate(legacyActivity('cancelled'))).toMatchObject({
      outcome: { resolution: 'unknown', decisionSource: 'legacy' },
    });
    expect(migrate(legacyActivity('queued'))).not.toHaveProperty('outcome');
  });

  it('preserves an explicit semantic outcome and exposes one registered migration', () => {
    const explicit = {
      ...legacyActivity('completed'),
      outcome: {
        schemaVersion: 1,
        resolution: 'partial',
        blockerKind: 'information',
        summary: 'Some work completed.',
        decisionSource: 'engine',
        evidenceRefs: [],
        decidedAt: 200,
      },
    };
    expect(migrate(explicit)).toMatchObject({
      schemaVersion: PERSONA_ACTIVITY_SCHEMA_VERSION,
      outcome: { resolution: 'partial', decisionSource: 'engine' },
    });
    expect(PERSONA_ACTIVITY_RECORD_MIGRATIONS).toHaveLength(1);
  });
});

const PersonaRecordIndexTestSchema = z.object({
  recordKind: z.literal('PersonaRecordIndex'),
  schemaVersion: z.literal(PERSONA_RECORD_INDEX_SCHEMA_VERSION),
  collection: z.literal('persona-memories'),
  revision: z.number().int().nonnegative(),
  sourceRevision: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
  generatedAt: z.number().int().nonnegative(),
  entries: z.array(z.object({
    id: z.string(),
    personaId: z.string(),
    updatedAt: z.number().int().nonnegative(),
  }).passthrough()),
}).strict();

describe('PersonaRecordIndex migrations', () => {
  it('migrates v1 deterministically and registers exactly one transition', () => {
    const migrated = migrateAndParseRecord({
      recordKind: 'PersonaRecordIndex',
      value: {
        schemaVersion: 1,
        version: 1,
        built: true,
        collection: 'persona-memories',
        revision: 7,
        entries: [
          { id: 'memory_b', personaId: 'persona_a', updatedAt: 20 },
          { id: 'memory_a', personaId: 'persona_a', updatedAt: 10 },
        ],
      },
      currentVersion: enduringAgentRecordSchemaVersion('PersonaRecordIndex'),
      migrations: enduringAgentRecordMigrations('PersonaRecordIndex'),
      schema: PersonaRecordIndexTestSchema,
    });

    expect(migrated).toMatchObject({
      recordKind: 'PersonaRecordIndex',
      schemaVersion: PERSONA_RECORD_INDEX_SCHEMA_VERSION,
      revision: 7,
      sourceRevision: 7,
      sourceCount: 2,
      generatedAt: 20,
    });
    expect(migrated.entries.map(entry => entry.id)).toEqual(['memory_a', 'memory_b']);
    expect(PERSONA_RECORD_INDEX_RECORD_MIGRATIONS).toHaveLength(1);
  });

  it('rejects future index versions', () => {
    expect(() => migrateAndParseRecord({
      recordKind: 'PersonaRecordIndex',
      value: {
        schemaVersion: PERSONA_RECORD_INDEX_SCHEMA_VERSION + 1,
        collection: 'persona-memories',
        entries: [],
      },
      currentVersion: enduringAgentRecordSchemaVersion('PersonaRecordIndex'),
      migrations: enduringAgentRecordMigrations('PersonaRecordIndex'),
      schema: PersonaRecordIndexTestSchema,
    })).toThrow(/Unsupported PersonaRecordIndex schema version/);
  });
});
