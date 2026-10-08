/**
 * Memory candidate lifecycle: expiry stamping, sweep expiry, review protection,
 * and the auto-promotion feature gate.
 * Issue 452, PR A (candidate lifecycle).
 */

import {
  activateMemory,
  getPersonaMemory,
  searchPersonaMemory,
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

  describe('review query', () => {
    it('returns only unreviewed, unexpired candidates in confidence-recency order', async () => {
      await inFreshWorkspace(async (personaId) => {
        const asOf = Date.UTC(2027, 1, 1);
        jest.useFakeTimers();
        try {
          await setMemorySettings({ candidateExpiryDays: 60 });
          jest.setSystemTime(asOf - 30 * DAY_MS);
          const olderHighConfidence = await storeMemoryCandidate(userCandidate(personaId, {
            content: 'older_high_confidence_review_candidate',
            confidence: 1,
          }));
          jest.setSystemTime(asOf);
          const fresh = await storeMemoryCandidate(userCandidate(personaId, {
            content: 'fresh_review_candidate',
            confidence: 0.6,
          }));
          const reviewed = await storeMemoryCandidate(userCandidate(personaId, {
            content: 'already_reviewed_candidate',
          }));
          await activateMemory(personaId, reviewed.id);
          await setMemorySettings({ candidateExpiryDays: 1 });
          jest.setSystemTime(asOf - 2 * DAY_MS);
          await storeMemoryCandidate(userCandidate(personaId, {
            content: 'expired_review_candidate',
          }));

          const results = await searchPersonaMemory(personaId, {
            order: 'review',
            statuses: ['active', 'candidate', 'forgotten'],
            asOf,
          });

          expect(results.map(result => result.item.id)).toEqual([
            fresh.id,
            olderHighConfidence.id,
          ]);
        } finally {
          jest.useRealTimers();
        }
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

  describe('28-day steady state', () => {
    it('keeps sustained unreviewed growth bounded while preserving reviewed memories', async () => {
      await inFreshWorkspace(async (personaId) => {
        const start = Date.UTC(2027, 0, 1);
        let unresolvedConflictId = '';
        jest.useFakeTimers();
        try {
          await setMemorySettings({ candidateExpiryDays: 7 });
          for (let day = 0; day < 28; day += 1) {
            const now = start + day * DAY_MS;
            jest.setSystemTime(now);
            const approved = await storeMemoryCandidate(userCandidate(personaId, {
              content: `human_${day.toString(36).repeat(20)}`,
              sourceRefs: [{ kind: 'user_statement', id: `approved-${day}`, observedAt: now }],
            }));
            await activateMemory(personaId, approved.id);
            const pending = await storeMemoryCandidate(userCandidate(personaId, {
              content: `pending_${(day + 100).toString(36).repeat(20)}`,
              sourceRefs: [{ kind: 'user_statement', id: `pending-${day}`, observedAt: now }],
              ...(day === 27 ? { conflictsWith: [approved.id] } : {}),
            }));
            if (day === 27) unresolvedConflictId = pending.id;
            await sweepMemoryCandidates(personaId, now);
          }

          const asOf = start + 27 * DAY_MS;
          const candidates = await searchPersonaMemory(personaId, {
            statuses: ['candidate'],
            asOf,
            limit: 200,
          });
          const active = await searchPersonaMemory(personaId, {
            statuses: ['active'],
            asOf,
            limit: 200,
          });
          expect(candidates.length).toBeLessThanOrEqual(7);
          expect(active).toHaveLength(28);
          const unresolved = await getPersonaMemory(personaId, unresolvedConflictId);
          expect(unresolved.status).toBe('candidate');
          expect(unresolved.conflictsWith).toHaveLength(1);
        } finally {
          jest.useRealTimers();
        }
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
