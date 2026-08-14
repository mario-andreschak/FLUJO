import {
  PERSONA_ACTIVITY_RECORD_MIGRATIONS,
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
