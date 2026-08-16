/**
 * Memory candidate lifecycle: expiry stamping, sweep expiry, review protection,
 * and the auto-promotion feature gate.
 * Issue 452, PR A (candidate lifecycle).
 */

import {
  activateMemory,
  getPersonaMemory,
  storeMemoryCandidate,
} from '@/backend/services/enduringAgents/memoryKernel';
import {
  promoteMemoryCandidate,
  sweepMemoryCandidates,
} from '@/backend/services/enduringAgents/memoryLifecycle';
import {
  getMemorySettings,
  setMemorySettings,
} from '@/backend/services/enduringAgents/memorySettings';
import { FEATURES } from '@/config/features';
import type { CreateMemoryItemInput } from '@/shared/types/enduringAgent';
import { runWithWorkspace } from '@/utils/workspace';

import { createPersonaFromRole } from './fixtures/personaFactory';

const DAY_MS = 24 * 60 * 60 * 1000;

let workspaceSequence = 0;

/**
 * Each test gets its own workspace AND its own Persona created inside it.
 * The Persona must be created within the same workspace the test runs in:
 * Persona records are workspace-scoped, so a Persona seeded in a different
 * workspace is simply absent here.
 */
function inFreshWorkspace<T>(
  task: (personaId: string) => Promise<T>,
): Promise<T> {
  workspaceSequence += 1;
  return runWithWorkspace(
    `memory-lifecycle-${process.pid}-${workspaceSequence}`,
    async () => {
      const { persona } = await createPersonaFromRole({
        name: 'Mnemo',
        idempotencyKey: 'memory-lifecycle',
      });
      return task(persona.id);
    },
  );
}

/** A user-attested candidate: activatable without a model-review exception. */
function userCandidate(
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
    sourceRefs: [{ kind: 'user_statement', id: 'user-1', observedAt: Date.now() }],
    trust: 'explicit_user',
    ...overrides,
  } as CreateMemoryItemInput;
}

describe('memory candidate lifecycle', () => {
  describe('candidate expiry stamping', () => {
    it('stamps an expiry derived from the workspace candidate-expiry setting', async () => {
      await inFreshWorkspace(async (personaId) => {
        const before = Date.now();
        const candidate = await storeMemoryCandidate(userCandidate(personaId));
        const after = Date.now();
        const settings = await getMemorySettings();

        expect(candidate.status).toBe('candidate');
        expect(candidate.expiresAt).toBeDefined();
        // The stamp is taken from the clock inside the write, so bound it by the
        // window the write actually ran in rather than a single sampled `now`.
        expect(candidate.expiresAt!).toBeGreaterThanOrEqual(
          before + settings.candidateExpiryDays * DAY_MS,
        );
        expect(candidate.expiresAt!).toBeLessThanOrEqual(
          after + settings.candidateExpiryDays * DAY_MS,
        );
      });
    });

    it('stamps no expiry when candidateExpiryDays is 0', async () => {
      await inFreshWorkspace(async (personaId) => {
        await setMemorySettings({ candidateExpiryDays: 0 });

        const candidate = await storeMemoryCandidate(userCandidate(personaId));

        expect(candidate.status).toBe('candidate');
        expect(candidate.expiresAt).toBeUndefined();
      });
    });
  });

  describe('sweep', () => {
    it('expires an untouched candidate once its stamp has passed', async () => {
      await inFreshWorkspace(async (personaId) => {
        const candidate = await storeMemoryCandidate(userCandidate(personaId));
        expect(candidate.expiresAt).toBeDefined();

        const stats = await sweepMemoryCandidates(
          personaId,
          candidate.expiresAt! + 60 * 60 * 1000,
        );

        expect(stats.expired).toBe(1);
        const swept = await getPersonaMemory(personaId, candidate.id);
        expect(swept.status).toBe('forgotten');
        expect(swept.lifecycleReason).toBe('expired');
      });
    });

    it('leaves a candidate alone while its stamp is still in the future', async () => {
      await inFreshWorkspace(async (personaId) => {
        const candidate = await storeMemoryCandidate(userCandidate(personaId));

        const stats = await sweepMemoryCandidates(
          personaId,
          candidate.expiresAt! - 60 * 60 * 1000,
        );

        expect(stats.expired).toBe(0);
        const untouched = await getPersonaMemory(personaId, candidate.id);
        expect(untouched.status).toBe('candidate');
      });
    });

    it('never expires a candidate a human already reviewed', async () => {
      await inFreshWorkspace(async (personaId) => {
        const candidate = await storeMemoryCandidate(userCandidate(personaId));
        const expiresAt = candidate.expiresAt!;
        await activateMemory(personaId, candidate.id);

        const stats = await sweepMemoryCandidates(personaId, expiresAt + 365 * DAY_MS);

        expect(stats.expired).toBe(0);
        const reviewed = await getPersonaMemory(personaId, candidate.id);
        expect(reviewed.status).toBe('active');
      });
    });
  });

  describe('review tracking', () => {
    it('records reviewedAt when a human activates a candidate', async () => {
      await inFreshWorkspace(async (personaId) => {
        const before = Date.now();
        const candidate = await storeMemoryCandidate(userCandidate(personaId));
        expect(candidate.reviewedAt).toBeUndefined();

        const activated = await activateMemory(personaId, candidate.id);

        expect(activated.status).toBe('active');
        expect(activated.reviewedAt).toBeDefined();
        expect(activated.reviewedAt!).toBeGreaterThanOrEqual(before);
      });
    });
  });

  describe('auto-promotion gate', () => {
    it('is inert while the ENABLE_MEMORY_AUTO_PROMOTION feature is off', async () => {
      // Guards the shipped default: promotion must be unreachable until the
      // feature is deliberately enabled, whatever the per-workspace settings say.
      expect(FEATURES.ENABLE_MEMORY_AUTO_PROMOTION).toBe(false);

      await inFreshWorkspace(async (personaId) => {
        await setMemorySettings({
          autoPromoteEnabled: true,
          autoPromoteMinAgeHours: 0,
          autoPromoteMinCorroborations: 1,
        });
        const candidate = await storeMemoryCandidate(userCandidate(personaId));

        await expect(
          promoteMemoryCandidate(personaId, candidate.id),
        ).resolves.toBeNull();

        const stats = await sweepMemoryCandidates(personaId, Date.now());
        expect(stats.promoted).toBe(0);
        const stillCandidate = await getPersonaMemory(personaId, candidate.id);
        expect(stillCandidate.status).toBe('candidate');
      });
    });
  });
});
