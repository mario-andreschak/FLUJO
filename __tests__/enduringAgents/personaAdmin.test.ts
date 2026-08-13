import {
  PersonaDomainBusyError,
  PersonaDomainConflictError,
  activatePersonaBehaviorRevision,
  behaviorRevisionId,
  claimNextPersonaActivity,
  hashBehaviorFlow,
  routePersonaMailboxItem,
  updatePersonaSettings,
} from '@/backend/services/enduringAgents';
import { createPersonaFromRole } from './fixtures/personaFactory';
import {
  createBehaviorRevision,
  listPersonaBundle,
} from '@/backend/services/enduringAgents/store';
import {
  BehaviorRevisionSchema,
  ENDURING_AGENT_SCHEMA_VERSION,
  type BehaviorRevision,
} from '@/shared/types/enduringAgent';
import { runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => T): T {
  workspaceSequence += 1;
  return runWithWorkspace(`enduring-phase5-${process.pid}-${workspaceSequence}`, task);
}

function overrideRevision(base: BehaviorRevision, revision: number): BehaviorRevision {
  const flowSnapshot = JSON.parse(JSON.stringify(base.flowSnapshot)) as BehaviorRevision['flowSnapshot'];
  flowSnapshot.name = `${flowSnapshot.name} override r${revision}`;
  const contentHash = hashBehaviorFlow(flowSnapshot);
  return BehaviorRevisionSchema.parse({
    schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
    id: behaviorRevisionId({
      personaId: base.personaId,
      behaviorId: base.behaviorId,
      revision,
      contentHash,
    }),
    behaviorId: base.behaviorId,
    personaId: base.personaId,
    slotKey: base.slotKey,
    revision,
    contentHash,
    flowSnapshot,
    source: {
      kind: 'persona_override',
      parentRevisionId: base.id,
      evidenceRefs: ['review:phase-5'],
    },
    createdAt: base.createdAt + revision,
  });
}

describe('issue #415 phase 5 Persona administration', () => {
  it('updates only editable settings with optimistic concurrency and keeps the Role pin immutable', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'phase5-settings',
      });
      const updated = await updatePersonaSettings(persona.id, {
        name: 'Jim Rivera',
        mission: 'Own the release carefully.',
        presentation: { avatarUrl: 'https://example.test/jim.png', voice: 'alloy' },
        autonomyLevel: 'learn_hints',
        interruptionPolicy: 'related_only',
        lifecycleState: 'sleeping',
        expectedUpdatedAt: persona.updatedAt,
      });

      expect(updated).toMatchObject({
        name: 'Jim Rivera',
        mission: 'Own the release carefully.',
        lifecycleState: 'sleeping',
        autonomyLevel: 'learn_hints',
        interruptionPolicy: 'related_only',
        roleVersionId: persona.roleVersionId,
      });
      expect(updated.presentation).toEqual({
        avatarUrl: 'https://example.test/jim.png',
        voice: 'alloy',
      });
      await expect(updatePersonaSettings(persona.id, {
        name: 'Stale Jim',
        expectedUpdatedAt: persona.updatedAt,
      })).rejects.toBeInstanceOf(PersonaDomainConflictError);
      await expect(updatePersonaSettings(persona.id, {
        roleVersionId: 'rolever_spoofed',
      })).rejects.toThrow();
    });
  });

  it('blocks desk mutations while a live Activity owns the Persona lease', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createPersonaFromRole({ name: 'Jim', idempotencyKey: 'phase5-busy' });
      await routePersonaMailboxItem({
        personaId: persona.id,
        idempotencyKey: 'phase5-busy-assignment',
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: 'phase5-busy-assignment' },
        summary: 'Hold the Persona lease.',
      });
      const claim = await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 60_000 });
      expect(claim).not.toBeNull();

      await expect(updatePersonaSettings(persona.id, {
        mission: 'This must wait.',
      })).rejects.toBeInstanceOf(PersonaDomainBusyError);
    });
  });

  it('shows complete immutable history and supports CAS-protected activation and rollback', async () => {
    await inFreshWorkspace(async () => {
      const created = await createPersonaFromRole({ name: 'Jim', idempotencyKey: 'phase5-behavior' });
      const binding = created.behaviorBindings.find((candidate) => candidate.slotKey === 'primary')!;
      const original = created.behaviorRevisions.find((candidate) => candidate.id === binding.activeRevisionId)!;
      const override = overrideRevision(original, 2);
      await createBehaviorRevision(override);

      const activated = await activatePersonaBehaviorRevision(created.persona.id, binding.id, {
        revisionId: override.id,
        expectedActiveRevisionId: original.id,
      });
      expect(activated.binding.activeRevisionId).toBe(override.id);

      const inspected = await listPersonaBundle(created.persona.id);
      expect(inspected?.roleVersion.id).toBe(created.persona.roleVersionId);
      expect(inspected?.behaviorRevisions.map((revision) => revision.id)).toEqual(
        expect.arrayContaining([original.id, override.id]),
      );

      const rolledBack = await activatePersonaBehaviorRevision(created.persona.id, binding.id, {
        revisionId: original.id,
        expectedActiveRevisionId: override.id,
      });
      expect(rolledBack.binding.activeRevisionId).toBe(original.id);
      await expect(activatePersonaBehaviorRevision(created.persona.id, binding.id, {
        revisionId: override.id,
        expectedActiveRevisionId: override.id,
      })).rejects.toBeInstanceOf(PersonaDomainConflictError);

      const sarah = await createPersonaFromRole({ name: 'Sarah', idempotencyKey: 'phase5-sarah' });
      await expect(activatePersonaBehaviorRevision(created.persona.id, binding.id, {
        revisionId: sarah.behaviorRevisions[0].id,
        expectedActiveRevisionId: original.id,
      })).rejects.toBeInstanceOf(PersonaDomainConflictError);
    });
  });
});
