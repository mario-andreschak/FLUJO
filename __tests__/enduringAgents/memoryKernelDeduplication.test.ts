import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';
import {
  claimNextPersonaActivity,
  commitPersonaActivityMutation,
  commitWithPersonaActivityLease,
  completePersonaActivity,
  routePersonaMailboxItem,
  type PersonaActivityClaim,
  type PersonaLeaseFence,
} from '@/backend/services/enduringAgents';
import {
  getPersonaMemory,
  storeMemoryCandidate,
} from '@/backend/services/enduringAgents/memoryKernel';
import { MEMORY_DEDUP_SETTINGS } from '@/backend/services/enduringAgents/memoryRanking';
import {
  getMemoryItem,
  getPersona,
  listMemoryItems,
} from '@/backend/services/enduringAgents/store';
import type { CreateMemoryItemInput } from '@/shared/types/enduringAgent';
import { runWithWorkspace } from '@/utils/workspace';

import { createPersonaFromRole } from './fixtures/personaFactory';

let workspaceSequence = 0;

function inFreshWorkspace<T>(
  task: (personaId: string) => Promise<T>,
): Promise<T> {
  workspaceSequence += 1;
  return runWithWorkspace(
    `memory-dedup-${process.pid}-${workspaceSequence}`,
    async () => {
      const { persona } = await createPersonaFromRole({
        name: 'Mnemo',
        idempotencyKey: 'memory-dedup',
      });
      return task(persona.id);
    },
  );
}

function fenceForClaim(claim: PersonaActivityClaim): PersonaLeaseFence {
  return {
    workspaceId: claim.lease.workspaceId,
    personaId: claim.lease.personaId,
    activityId: claim.activity.id,
    leaseId: claim.lease.id,
    holderId: claim.lease.holderId,
    fencingToken: claim.lease.fencingToken,
  };
}

function authorityFor(fence: PersonaLeaseFence): FlowExecutionAuthority {
  return {
    signal: new AbortController().signal,
    assertCurrent: async () => {
      await commitWithPersonaActivityLease(fence, async () => undefined);
    },
    commitWhileCurrent: (task) => commitWithPersonaActivityLease(fence, task),
    commitPersonaMutation: (task) => commitPersonaActivityMutation(fence, task),
  };
}

async function claimAssignment(
  personaId: string,
  key: string,
): Promise<PersonaActivityClaim> {
  await routePersonaMailboxItem({
    personaId,
    idempotencyKey: key,
    kind: 'assignment',
    source: { kind: 'assignment', sourceId: key, idempotencyKey: key },
    summary: key,
  });
  const claim = await claimNextPersonaActivity({ personaId, ttlMs: 30_000 });
  if (!claim) throw new Error('Expected a Persona Activity claim.');
  return claim;
}

function memoryInput(
  personaId: string,
  overrides: Partial<CreateMemoryItemInput> = {},
): CreateMemoryItemInput {
  return {
    personaId,
    kind: 'semantic',
    scope: 'persona',
    content: 'The release branch is stable.',
    confidence: 0.8,
    importance: 0.7,
    sourceRefs: [
      { kind: 'user_statement', id: 'user-1', observedAt: 1 },
    ],
    trust: 'explicit_user',
    ...overrides,
  } as CreateMemoryItemInput;
}

describe('memory-kernel near-duplicate persistence (issues #467 and #468)', () => {
  it('reinforces the active survivor and does not persist a sibling', async () => {
    await inFreshWorkspace(async (personaId) => {
      const survivor = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-survivor',
        status: 'active',
      }));
      const incoming = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-incoming',
        sourceRefs: [
          { kind: 'user_statement', id: 'user-2', observedAt: 2 },
        ],
      }));

      expect(incoming.id).toBe(survivor.id);
      expect(incoming.status).toBe('active');
      expect(incoming.confidence).toBeCloseTo(
        survivor.confidence + MEMORY_DEDUP_SETTINGS.confidenceReinforcementStep,
      );
      expect(incoming.importance).toBeCloseTo(
        survivor.importance + MEMORY_DEDUP_SETTINGS.importanceReinforcementStep,
      );
      expect(incoming.updatedAt).toBeGreaterThan(survivor.updatedAt);
      expect(incoming.sourceRefs.map((ref) => ref.id)).toEqual(
        expect.arrayContaining(['user-1', 'user-2']),
      );

      const persisted = await listMemoryItems(personaId);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].id).toBe(survivor.id);
      await expect(
        getPersonaMemory(personaId, 'memory-incoming'),
      ).rejects.toThrow();
    });
  });

  it('keeps deduplication and indexes stable across idle and active-Activity writes', async () => {
    await inFreshWorkspace(async (personaId) => {
      const initialPersona = await getPersona(personaId);
      expect(initialPersona).toMatchObject({
        lifecycleState: 'idle',
        provisioningState: 'ready',
      });
      const initialCoreMemoryItemIds = initialPersona?.coreMemoryItemIds ?? [];

      const survivor = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-authority-survivor',
        status: 'active',
      }));
      const idleIncoming = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-idle-incoming',
        sourceRefs: [
          { kind: 'user_statement', id: 'idle-write', observedAt: 2 },
        ],
      }));

      expect(idleIncoming.id).toBe(survivor.id);
      expect(await getMemoryItem(personaId, survivor.id)).toMatchObject({
        id: survivor.id,
        status: 'active',
      });
      expect(await getMemoryItem(personaId, 'memory-idle-incoming')).toBeNull();
      expect(await listMemoryItems(personaId)).toHaveLength(1);
      expect(await getPersona(personaId)).toMatchObject({
        lifecycleState: 'idle',
        coreMemoryItemIds: initialCoreMemoryItemIds,
      });

      const claim = await claimAssignment(personaId, 'memory-authority-activity');
      const fence = fenceForClaim(claim);
      try {
        const activeIncoming = await storeMemoryCandidate(memoryInput(personaId, {
          id: 'memory-active-incoming',
          sourceRefs: [
            { kind: 'user_statement', id: 'active-write', observedAt: 3 },
          ],
        }), { executionAuthority: authorityFor(fence) });

        expect(activeIncoming).toMatchObject({
          id: survivor.id,
          status: 'active',
        });
        expect(await getMemoryItem(personaId, 'memory-active-incoming')).toBeNull();
        expect(await getPersonaMemory(personaId, survivor.id)).toMatchObject({
          id: survivor.id,
          status: 'active',
        });
        const persisted = await listMemoryItems(personaId);
        expect(persisted).toHaveLength(1);
        expect(persisted[0].id).toBe(survivor.id);
        expect(await getPersona(personaId)).toMatchObject({
          lifecycleState: 'busy',
          coreMemoryItemIds: initialCoreMemoryItemIds,
        });
      } finally {
        await completePersonaActivity({ ...fence, status: 'completed' });
      }

      expect(await getPersona(personaId)).toMatchObject({
        lifecycleState: 'idle',
        coreMemoryItemIds: initialCoreMemoryItemIds,
      });
    });
  });

  it('caps reinforcement and stores at most 64 deduplicated source references', async () => {
    await inFreshWorkspace(async (personaId) => {
      const existingRefs = Array.from({ length: 63 }, (_, index) => ({
        kind: 'user_statement' as const,
        id: `source-${index.toString().padStart(2, '0')}`,
        observedAt: index + 1,
      }));
      const survivor = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-capped-survivor',
        status: 'active',
        confidence: 0.98,
        importance: 0.99,
        sourceRefs: existingRefs,
      }));

      const reinforced = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-capped-incoming',
        confidence: 0.2,
        importance: 0.2,
        sourceRefs: [
          { ...existingRefs[0], observedAt: 999 },
          { kind: 'user_statement', id: 'source-new-1', observedAt: 1000 },
          { kind: 'user_statement', id: 'source-new-2', observedAt: 1001 },
        ],
      }));

      expect(reinforced.id).toBe(survivor.id);
      expect(reinforced.confidence).toBe(1);
      expect(reinforced.importance).toBe(1);
      expect(reinforced.sourceRefs).toHaveLength(
        MEMORY_DEDUP_SETTINGS.maxSourceRefsPerItem,
      );
      expect(reinforced.sourceRefs.filter((ref) => ref.id === 'source-00')).toHaveLength(1);
      expect(reinforced.sourceRefs.map((ref) => ref.id)).toContain('source-new-1');
      expect(reinforced.sourceRefs.map((ref) => ref.id)).not.toContain('source-new-2');
    });
  });

  it('selects the highest-similarity qualifying survivor deterministically', async () => {
    await inFreshWorkspace(async (personaId) => {
      const exact = 'abcdefghijklmnopqrstuvwxyz0123456';
      const close = `${exact.slice(0, 15)}_${exact.slice(16)}`;

      const closeMatch = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-close-match',
        content: close,
        status: 'active',
      }), { skipNearDuplicateMerge: true });
      const exactMatch = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-exact-match',
        content: exact,
        status: 'active',
      }), { skipNearDuplicateMerge: true });

      const merged = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-best-match-incoming',
        content: exact,
        sourceRefs: [
          { kind: 'user_statement', id: 'best-match-source', observedAt: 2 },
        ],
      }));

      expect(merged.id).toBe(exactMatch.id);
      expect(merged.id).not.toBe(closeMatch.id);
    });
  });

  it.each([
    {
      name: 'below the similarity threshold',
      survivor: { content: 'The release branch is stable.' },
      incoming: { content: 'The customer prefers weekly summaries.' },
    },
    {
      name: 'another kind',
      survivor: { kind: 'episodic' as const },
      incoming: {},
    },
    {
      name: 'another scope',
      survivor: { scope: 'activity' as const },
      incoming: {},
    },
    {
      name: 'not active',
      survivor: { status: 'candidate' as const },
      incoming: {},
    },
  ])('persists a separate record when the existing record is $name', async ({
    survivor: survivorOverrides,
    incoming: incomingOverrides,
  }) => {
    await inFreshWorkspace(async (personaId) => {
      const survivor = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-boundary-survivor',
        status: 'active',
        ...survivorOverrides,
      }));
      const incoming = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-boundary-incoming',
        ...incomingOverrides,
      }));

      expect(incoming.id).not.toBe(survivor.id);
      expect(await listMemoryItems(personaId)).toHaveLength(2);
    });
  });

  it('preserves explicit relationship and internal bypass writes as siblings', async () => {
    await inFreshWorkspace(async (personaId) => {
      const survivor = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-bypass-survivor',
        status: 'active',
      }));

      const superseding = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-superseding',
        supersedes: [survivor.id],
      }));
      const conflicting = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-conflicting',
        conflictsWith: [survivor.id],
      }));
      const skipped = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-skipped',
      }), { skipNearDuplicateMerge: true });

      expect(superseding.id).toBe('memory-superseding');
      expect(conflicting.id).toBe('memory-conflicting');
      expect(skipped.id).toBe('memory-skipped');
      expect(await listMemoryItems(personaId)).toHaveLength(4);
    });
  });

  it('allows policy-valid trust upgrades and preserves activation restrictions', async () => {
    await inFreshWorkspace(async (personaId) => {
      const survivor = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-model-survivor',
        status: 'active',
        trust: 'model_inference',
      }), {
        reviewed: true,
        skipNearDuplicateMerge: true,
      });

      const upgraded = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-tool-incoming',
        trust: 'verified_tool',
        sourceRefs: [
          { kind: 'tool_result', id: 'tool-1', observedAt: 2 },
        ],
      }));

      expect(upgraded.id).toBe(survivor.id);
      expect(upgraded.trust).toBe('verified_tool');

      await expect(storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-invalid-active-tool',
        content: 'A distinct fact that should not merge.',
        status: 'active',
        trust: 'verified_tool',
      }), { skipNearDuplicateMerge: true })).rejects.toThrow(
        'Verified-tool memory requires tool-result provenance.',
      );
    });
  });

  it('compares only the newest 200 eligible active records', async () => {
    await inFreshWorkspace(async (personaId) => {
      const target = 'The oldest eligible memory is the only exact match.';
      const oldest = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-window-zzzz',
        content: target,
        status: 'active',
      }), { skipNearDuplicateMerge: true });

      for (let index = 0; index < MEMORY_DEDUP_SETTINGS.comparisonWindow; index += 1) {
        await storeMemoryCandidate(memoryInput(personaId, {
          id: `memory-window-${index.toString().padStart(3, '0')}`,
          content: `Unrelated filler record number ${index}: ${'x'.repeat(index + 1)}`,
          status: 'active',
        }), { skipNearDuplicateMerge: true });
      }

      const incoming = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-window-incoming',
        content: target,
      }));

      expect(incoming.id).toBe('memory-window-incoming');
      expect(incoming.id).not.toBe(oldest.id);
      expect(await listMemoryItems(personaId)).toHaveLength(
        MEMORY_DEDUP_SETTINGS.comparisonWindow + 2,
      );
    });
  }, 30_000);

  it('saves a sibling while the code-level dedup kill switch is disabled', async () => {
    await inFreshWorkspace(async (personaId) => {
      const mutableSettings = MEMORY_DEDUP_SETTINGS as unknown as { enabled: boolean };
      const originalEnabled = mutableSettings.enabled;

      const survivor = await storeMemoryCandidate(memoryInput(personaId, {
        id: 'memory-kill-switch-survivor',
        status: 'active',
      }));

      try {
        mutableSettings.enabled = false;
        const sibling = await storeMemoryCandidate(memoryInput(personaId, {
          id: 'memory-kill-switch-sibling',
        }));

        expect(sibling.id).toBe('memory-kill-switch-sibling');
        expect(sibling.id).not.toBe(survivor.id);
        expect(await listMemoryItems(personaId)).toHaveLength(2);
      } finally {
        mutableSettings.enabled = originalEnabled;
      }
    });
  });
});
