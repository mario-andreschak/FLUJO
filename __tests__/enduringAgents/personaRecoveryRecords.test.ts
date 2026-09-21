import {
  PERSONA_RECOVERY_RECORD_SPECS, validatePersonaRecoveryRecord,
} from '@/backend/services/enduringAgents/personaRecoveryRecords';
import { ENDURING_AGENT_COLLECTIONS as collections } from '@/backend/services/enduringAgents/collections';
import { behaviorRevisionId, hashBehaviorFlow, hashLegacyBehaviorFlow } from '@/backend/services/enduringAgents/behaviorRevisions';
import type { Flow } from '@/shared/types/flow';

const persona = {
  schemaVersion: 1, id: 'persona_recovery', name: 'Recovery fixture', roleVersionId: 'role_version',
  lifecycleState: 'idle', autonomyLevel: 'locked', interruptionPolicy: 'queue', createdAt: 1, updatedAt: 1,
};

function revision(legacy = false) {
  const flowSnapshot = { id: 'flow_recovery', name: 'Recovery Core', nodes: [], edges: [],
    ...(legacy ? { permissionRules: [] } : { behaviorRules: [] }) };
  const contentHash = legacy ? hashLegacyBehaviorFlow(flowSnapshot) : hashBehaviorFlow(flowSnapshot as Flow);
  return {
    schemaVersion: 1, personaId: persona.id, behaviorId: 'behavior_recovery', slotKey: 'primary', revision: 1,
    id: behaviorRevisionId({ personaId: persona.id, behaviorId: 'behavior_recovery', revision: 1, contentHash }),
    contentHash, flowSnapshot, source: { kind: 'persona_override' }, createdAt: 1,
  };
}

it('covers every fixed Persona collection and specialist call evidence', () => {
  expect(Object.keys(PERSONA_RECOVERY_RECORD_SPECS).sort()).toEqual([
    ...Object.values(collections), 'persona-behavior-call-pins',
  ].sort());
  for (const collection of [collections.appGrants, collections.mailboxItems, collections.flowDispatches,
    collections.leases, collections.leaseHistory, collections.runtimeRecoveryReceipts] as const) {
    expect(PERSONA_RECOVERY_RECORD_SPECS[collection].evidenceOnly).toBe(true);
  }
});

it('migrates a validation view while preserving the original record', () => {
  const before = JSON.stringify(persona);
  const result = validatePersonaRecoveryRecord(collections.personas, persona, 'source-workspace');
  expect(result.parsed.schemaVersion).toBe(2);
  expect(result.migrated).toBe(true);
  expect(JSON.stringify(result.original)).toBe(before);
  expect(JSON.stringify(persona)).toBe(before);
});

it('rejects unknown collections and unknown fields instead of silently dropping data', () => {
  expect(() => validatePersonaRecoveryRecord('../models', persona, 'source-workspace')).toThrow('Unsupported Persona recovery collection');
  expect(() => validatePersonaRecoveryRecord('__proto__', persona, 'source-workspace')).toThrow('Unsupported Persona recovery collection');
  expect(() => validatePersonaRecoveryRecord(collections.personas, { ...persona, surpriseAuthority: true }, 'source-workspace')).toThrow();
});

it('rejects future schemas before constructing any restore plan', () => {
  expect(() => validatePersonaRecoveryRecord(collections.personas, { ...persona, schemaVersion: 999 }, 'source-workspace'))
    .toThrow('Unsupported Persona schema version');
});

it.each([false, true])('verifies current and legacy immutable Behavior hashes (legacy=%s)', (legacy) => {
  const original = revision(legacy);
  const before = JSON.stringify(original);
  const result = validatePersonaRecoveryRecord(collections.behaviorRevisions, original, 'source-workspace');
  expect(result.parsed.contentHash).toBe(original.contentHash);
  expect(JSON.stringify(result.original)).toBe(before);
  expect(JSON.stringify(original)).toBe(before);
  if (legacy) expect(result.original.flowSnapshot).toHaveProperty('permissionRules');
});

it('rejects changed immutable content and forged content-addressed ids', () => {
  const original = revision();
  expect(() => validatePersonaRecoveryRecord(collections.behaviorRevisions,
    { ...original, flowSnapshot: { ...original.flowSnapshot, name: 'Tampered' } }, 'source-workspace')).toThrow('content hash is invalid');
  expect(() => validatePersonaRecoveryRecord(collections.behaviorRevisions,
    { ...original, id: 'br_forged' }, 'source-workspace')).toThrow('content-addressed id is invalid');
});

it('rejects a valid draft belonging to another workspace', () => {
  const draft = {
    schemaVersion: 1, id: 'draft_recovery', workspaceId: 'other-workspace', status: 'draft', revision: 1,
    payload: { step: 0, name: '', mission: '', avatarUrl: '', roleVersionId: '', coreFlowRef: '',
      behaviorFlowRefs: [], appRefs: [], appsEdited: false, memories: [], idempotencyKey: 'draft-key' },
    createdAt: 1, updatedAt: 1,
  };
  expect(() => validatePersonaRecoveryRecord(collections.personaCreationDrafts, draft, 'source-workspace'))
    .toThrow('belongs to another workspace');
  expect(validatePersonaRecoveryRecord(collections.personaCreationDrafts, draft, 'other-workspace').id).toBe(draft.id);
});
