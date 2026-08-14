import type { ZodType } from 'zod';

import legacyRecords from '../fixtures/enduringAgents/legacy-composition-records-v1.json';

import {
  BehaviorBindingSchema,
  BehaviorRevisionSchema,
  PersonaCompositionSchema,
  PersonaSchema,
  RoleDefinitionSchema,
  RoleVersionSchema,
  UpdatePersonaCompositionInputSchema,
} from '@/shared/types/enduringAgent';
import {
  UnsupportedEnduringAgentSchemaError,
  enduringAgentRecordMigrations,
  enduringAgentRecordSchemaVersion,
  migrateAndParseRecord,
} from '@/backend/services/enduringAgents/recordMigrations';
import { personaCompositionToolDefinitions } from '@/backend/services/mcp/personaCompositionTools';

describe('Persona composition compatibility', () => {
  const cases: ReadonlyArray<readonly [string, unknown, ZodType<unknown>]> = [
    ['RoleDefinition', legacyRecords.roleDefinition, RoleDefinitionSchema],
    ['RoleVersion', legacyRecords.roleVersion, RoleVersionSchema],
    ['Persona', legacyRecords.persona, PersonaSchema],
    ['BehaviorBinding', legacyRecords.behaviorBinding, BehaviorBindingSchema],
    ['BehaviorRevision', legacyRecords.behaviorRevision, BehaviorRevisionSchema],
  ];

  it.each(cases)('migrates legacy %s records explicitly and idempotently', (
    recordKind,
    record,
    schema,
  ) => {
    const currentVersion = enduringAgentRecordSchemaVersion(recordKind);
    const first = migrateAndParseRecord({
      recordKind,
      value: record,
      currentVersion,
      schema,
      migrations: enduringAgentRecordMigrations(recordKind),
    });
    const second = migrateAndParseRecord({
      recordKind,
      value: first,
      currentVersion,
      schema,
      migrations: enduringAgentRecordMigrations(recordKind),
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({ schemaVersion: currentVersion });
  });

  it('keeps legacy Persona and Behavior data while leaving composition absent', () => {
    const persona = migrateAndParseRecord({
      recordKind: 'Persona',
      value: legacyRecords.persona,
      currentVersion: enduringAgentRecordSchemaVersion('Persona'),
      schema: PersonaSchema,
      migrations: enduringAgentRecordMigrations('Persona'),
    });
    const revision = migrateAndParseRecord({
      recordKind: 'BehaviorRevision',
      value: legacyRecords.behaviorRevision,
      currentVersion: enduringAgentRecordSchemaVersion('BehaviorRevision'),
      schema: BehaviorRevisionSchema,
      migrations: enduringAgentRecordMigrations('BehaviorRevision'),
    });

    expect(persona.composition).toBeUndefined();
    expect(revision.flowSnapshot).toEqual(legacyRecords.behaviorRevision.flowSnapshot);
    expect(revision.source).toEqual(legacyRecords.behaviorRevision.source);
  });

  it('rejects unsupported future record versions', () => {
    const currentVersion = enduringAgentRecordSchemaVersion('Persona');
    expect(() => migrateAndParseRecord({
      recordKind: 'Persona',
      value: { ...legacyRecords.persona, schemaVersion: currentVersion + 1 },
      currentVersion,
      schema: PersonaSchema,
      migrations: enduringAgentRecordMigrations('Persona'),
    })).toThrow(UnsupportedEnduringAgentSchemaError);
  });

  it('validates friendly projection and guarded update contracts', () => {
    const role = {
      ref: 'role_legacy',
      name: 'Developer',
      prompt: 'Build carefully.',
      suggestedAppRefs: ['github'],
    };
    expect(PersonaCompositionSchema.parse({
      personaRef: 'persona_legacy',
      name: 'Ada',
      description: 'A product-facing description.',
      role,
      coreFlowRef: 'core_flow',
      appRefs: ['github'],
      memories: [{ ref: 'memory_1', kind: 'semantic', content: 'Prefers concise output.' }],
      behaviors: [{
        ref: 'behavior_legacy',
        name: 'Primary',
        sourceFlowRef: 'source_flow',
        overrideFlowRef: 'override_flow',
      }],
      expectedUpdatedAt: 10,
    })).toBeDefined();

    expect(UpdatePersonaCompositionInputSchema.safeParse({
      expectedUpdatedAt: 10,
      behaviors: [{
        ref: 'behavior_legacy',
        name: 'Primary',
        sourceFlowRef: 'source_flow',
        overrideFlowRef: null,
      }],
    }).success).toBe(true);

    for (const hiddenMutation of [
      { appRefs: ['github'] },
      { role },
      { description: 'Cosmetic-only description.' },
    ]) {
      expect(UpdatePersonaCompositionInputSchema.safeParse({
        expectedUpdatedAt: 10,
        ...hiddenMutation,
      }).success).toBe(false);
    }

    const updateTool = personaCompositionToolDefinitions().find(
      (tool) => tool.name === 'update_persona_composition',
    );
    const toolProperties = updateTool?.inputSchema.properties as Record<string, unknown>;
    expect(toolProperties).not.toHaveProperty('app_refs');
    expect(toolProperties).not.toHaveProperty('role');
    expect(toolProperties).not.toHaveProperty('description');
  });
});
