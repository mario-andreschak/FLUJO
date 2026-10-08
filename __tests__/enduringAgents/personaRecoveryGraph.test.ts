import {
  validatePersonaRecoveryGraph, type PersonaRecoveryRecordInput,
} from '@/backend/services/enduringAgents/personaRecoveryGraph';
import { ENDURING_AGENT_COLLECTIONS as c } from '@/backend/services/enduringAgents/collections';
import { BEHAVIOR_CALL_PINS_COLLECTION, compactBehaviorCallPin } from '@/backend/services/enduringAgents/behaviorCallPins';
import { behaviorRevisionId, hashBehaviorFlow } from '@/backend/services/enduringAgents/behaviorRevisions';
import { hashPersonaInstructionContext } from '@/backend/services/enduringAgents/personaActivitySnapshot';
import { buildTestRoleDefinition, buildTestRoleVersion } from './fixtures/personaFactory';
import type { BehaviorCallPin } from '@/backend/services/enduringAgents/behaviorCallPins';
import type { BehaviorRevision, PersonaInstructionContext } from '@/shared/types/enduringAgent';

const workspace = 'recovery-source';
const owner = 'persona_source';
const role = buildTestRoleDefinition();
const roleVersion = buildTestRoleVersion();
function revision(behaviorId = 'behavior_core'): BehaviorRevision {
  const flowSnapshot = roleVersion.coreFlowTemplate!;
  const contentHash = hashBehaviorFlow(flowSnapshot);
  return {
    schemaVersion: 1,
    id: behaviorRevisionId({ personaId: owner, behaviorId, revision: 1, contentHash }),
    personaId: owner, behaviorId, slotKey: behaviorId === 'behavior_core' ? 'primary' : 'specialist',
    revision: 1, contentHash, flowSnapshot, source: { kind: 'persona_override' }, createdAt: 1,
  };
}
const core = revision();
const specialist = revision('behavior_specialist');
const persona = {
  schemaVersion: 1, id: owner, name: 'Source', roleVersionId: roleVersion.id,
  lifecycleState: 'idle', autonomyLevel: 'locked', interruptionPolicy: 'queue', createdAt: 1, updatedAt: 1,
};
const activity = {
  schemaVersion: 1, id: 'activity_source', personaId: owner, kind: 'assignment', status: 'completed',
  source: { kind: 'assignment', sourceId: 'source' }, behaviorId: core.behaviorId,
  behaviorRevisionId: core.id, conversationId: 'conversation_source', createdAt: 1, startedAt: 1, updatedAt: 2, completedAt: 2,
};
function entry<T extends { id: string }>(collection: string, value: T, storageId = value.id): PersonaRecoveryRecordInput {
  return { collection, storageId, value: structuredClone(value) };
}
function records(): PersonaRecoveryRecordInput[] {
  return [
    entry(c.roleDefinitions, role), entry(c.roleVersions, roleVersion), entry(c.personas, persona),
    ...[core, specialist].flatMap((item) => [
      entry(c.behaviorRevisions, item),
      entry(c.behaviorBindings, {
        schemaVersion: 1, id: item.behaviorId, personaId: owner, slotKey: item.slotKey,
        activeRevisionId: item.id, createdAt: 1, updatedAt: 1,
      }),
    ]),
    entry(c.activities, activity),
  ];
}
function call(): BehaviorCallPin {
  return {
    schemaVersion: 1, id: 'call_source', workspaceId: workspace, personaId: owner,
    activityId: activity.id, parentBehaviorRevisionId: core.id, behaviorId: specialist.behaviorId,
    behaviorRevisionId: specialist.id, slotKey: specialist.slotKey, flowId: specialist.flowSnapshot.id,
    contentHash: specialist.contentHash, flowSnapshot: specialist.flowSnapshot,
    status: 'completed', outputText: 'Private output', createdAt: 1, updatedAt: 2, completedAt: 2,
  };
}
function work(id: string, dependencyIds: string[] = []) {
  return { schemaVersion: 1, id, personaId: owner, title: id, status: 'open', priority: 'normal', dependencyIds, createdAt: 1, updatedAt: 1 };
}

describe('Persona recovery relationship preflight', () => {
  it('allows queued maintenance but refuses independent in-flight diagnosis and evaluation', () => {
    const maintenance = {
      schemaVersion: 1, id: 'maintenance_source', workspaceId: workspace, personaId: owner,
      sourceActivityIds: [], sourceWindowDigest: 'a'.repeat(64), behaviorSlotKey: core.slotKey,
      baseRevisionId: core.id, baseContentHash: core.contentHash, detectorVersion: '1', policyVersion: '1', evaluationSuiteVersion: '1',
      state: 'queued', evidenceTrust: { trustedCount: 0, untrustedCount: 0, missingCount: 0, externallyTainted: false },
      relatedProposalIds: [], attempts: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, createdAt: 1, updatedAt: 1,
    };
    expect(() => validatePersonaRecoveryGraph([...records(), entry(c.behaviorMaintenanceRuns, maintenance)], workspace)).not.toThrow();
    for (const state of ['collecting', 'diagnosing', 'drafting', 'evaluating']) {
      expect(() => validatePersonaRecoveryGraph([...records(), entry(c.behaviorMaintenanceRuns, { ...maintenance, state })], workspace))
        .toThrow('active maintenance');
    }
  });
  it('preserves originals and reports separate archive artifact obligations', () => {
    const input = records();
    const before = JSON.stringify(input);
    const result = validatePersonaRecoveryGraph(input, workspace);
    expect(result.records).toHaveLength(input.length);
    expect(result.conversationRefs).toEqual([activity.conversationId]);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.records.find((record) => record.id === owner)?.migrated).toBe(true);
  });

  it('rejects missing Role pins, mismatched storage names, and duplicate identities', () => {
    expect(() => validatePersonaRecoveryGraph(records().filter((item) => item.collection !== c.roleVersions), workspace))
      .toThrow('missing role-versions');
    expect(() => validatePersonaRecoveryGraph([...records(), entry(c.personas, persona)], workspace)).toThrow('duplicate');
    expect(() => validatePersonaRecoveryGraph([entry(c.personas, persona, 'wrong')], workspace)).toThrow('storage identity');
    expect(() => validatePersonaRecoveryGraph([], '../outside')).toThrow();
  });

  it('checks parent and child specialist revisions separately and verifies their snapshots', () => {
    for (const pin of [call(), compactBehaviorCallPin(call(), 3)]) {
      expect(validatePersonaRecoveryGraph([...records(), entry(BEHAVIOR_CALL_PINS_COLLECTION, pin)], workspace).records)
        .toHaveLength(records().length + 1);
    }
    const altered = call();
    altered.flowSnapshot = { ...altered.flowSnapshot!, name: 'Forged executable content' };
    expect(() => validatePersonaRecoveryGraph([...records(), entry(BEHAVIOR_CALL_PINS_COLLECTION, altered)], workspace))
      .toThrow('snapshot was changed');
  });

  it('rejects cross-Persona dependencies and dependency cycles', () => {
    const foreign = { ...persona, id: 'persona_other' };
    expect(() => validatePersonaRecoveryGraph([
      ...records(), entry(c.personas, foreign), entry(c.workItems, work('task_a', ['task_b'])),
      entry(c.workItems, { ...work('task_b'), personaId: foreign.id }),
    ], workspace)).toThrow('missing persona-work-items');
    expect(() => validatePersonaRecoveryGraph([
      ...records(), entry(c.workItems, work('task_a', ['task_b'])), entry(c.workItems, work('task_b', ['task_a'])),
    ], workspace)).toThrow('cyclic');
  });

  it('keeps equally named records in separate Persona shards distinct', () => {
    const foreign = { ...persona, id: 'persona_other' };
    const input = [
      ...records(), entry(c.personas, foreign), entry(c.workItems, work('same_task')),
      entry(c.workItems, { ...work('same_task'), personaId: foreign.id }),
    ];
    expect(validatePersonaRecoveryGraph(input, workspace).records).toHaveLength(input.length);
  });

  it('rejects an active lease and accepts the real persona-keyed released-lease storage layout', () => {
    const lease = {
      schemaVersion: 1, id: 'lease_source', personaId: owner, workspaceId: workspace, activityId: activity.id,
      holderId: 'holder_source', status: 'released', fencingToken: 1,
      acquiredAt: 1, renewedAt: 1, expiresAt: 10, releasedAt: 2,
    };
    expect(() => validatePersonaRecoveryGraph([...records(), entry(c.leases, lease, owner)], workspace)).not.toThrow();
    expect(() => validatePersonaRecoveryGraph([...records(), entry(c.leases, { ...lease, status: 'active', releasedAt: undefined }, owner)], workspace))
      .toThrow('active execution lease');
    expect(() => validatePersonaRecoveryGraph([...records(), entry(c.leases, lease)], workspace)).toThrow('storage identity');
  });

  it('checks frozen Activity attribution and instruction digests without rewriting prompts', () => {
    const context: PersonaInstructionContext = {
      schemaVersion: 1, personaId: owner, activityId: activity.id, behaviorRevisionId: core.id,
      behaviorContentHash: core.contentHash, behaviorSlotKey: core.slotKey, rootFlowId: core.flowSnapshot.id,
      roleVersionId: roleVersion.id, personaName: 'Source', roleName: roleVersion.name,
      roleMission: roleVersion.mission, instruction: 'Original frozen instruction.',
    };
    const pinned = {
      ...activity, instructionContext: context, instructionContextDigest: hashPersonaInstructionContext(context),
      coreFlowId: core.flowSnapshot.id, coreFlowRevisionId: core.id, coreAppRefs: [], instructionContextSchemaVersion: 1,
    };
    const input = [...records().filter((item) => item.collection !== c.activities), entry(c.activities, pinned)];
    expect(() => validatePersonaRecoveryGraph(input, workspace)).not.toThrow();
    const changed = structuredClone(input);
    const value = changed.at(-1)!.value as typeof pinned;
    value.instructionContext.instruction = 'Changed instruction';
    expect(() => validatePersonaRecoveryGraph(changed, workspace)).toThrow('instruction digest');
  });

  it('requires every important Memory item to exist, be active and belong to its Persona', () => {
    const memory = {
      schemaVersion: 1, id: 'memory_source', personaId: owner, kind: 'semantic', scope: 'persona', status: 'active',
      content: 'Private memory', confidence: 1, importance: 1, sourceRefs: [{ kind: 'user_statement', id: 'user_source' }],
      trust: 'explicit_user', createdAt: 1, updatedAt: 1,
    };
    const withMemory = [
      ...records().filter((item) => item.collection !== c.personas),
      entry(c.personas, { ...persona, coreMemoryItemIds: [memory.id] }), entry(c.memoryItems, memory),
    ];
    expect(() => validatePersonaRecoveryGraph(withMemory, workspace)).not.toThrow();
    expect(() => validatePersonaRecoveryGraph(withMemory.slice(0, -1), workspace)).toThrow('missing persona-memories');
    expect(() => validatePersonaRecoveryGraph([
      ...withMemory.slice(0, -1), entry(c.memoryItems, { ...memory, status: 'superseded' }),
    ], workspace)).toThrow('must be active');
  });
});
