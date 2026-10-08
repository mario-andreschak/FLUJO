/**
 * Memory lifecycle management: candidate expiry, auto-promotion, and sweep orchestration.
 *
 * Issue #452: Candidate lifecycle, auto-consolidation, and conflict surfacing.
 * PR A: Candidate lifecycle (expiry + auto-promotion)
 */

import { createLogger } from '@/utils/logger';
import {
  type MemoryItem,
} from '@/shared/types/enduringAgent';
import { FEATURES } from '@/config/features';
import type { MemorySettings } from '@/shared/types/memorySettings';
import { getMemorySettings } from './memorySettings';
import { getMemoryItem, listMemoryItems, saveMemoryItem, getPersona } from './store';
import { assertActivationPolicy } from './memoryKernel';
import {
  PersonaDomainBusyError,
  PersonaDomainConflictError,
  withPersonaDomainMutation,
  type PersonaDomainMutationOptions,
} from './domainMutation';

const log = createLogger('backend/services/enduringAgents/memoryLifecycle');

export interface SweepStatistics {
  promoted: number;
  expired: number;
  repaired: number;
}

/**
 * Auto-promote a candidate to active status based on corroboration evidence.
 * Security-critical: never bypasses assertActivationPolicy.
 * 
 * Promotion preconditions (must all hold, per design D3):
 * 1. ENABLE_MEMORY_AUTO_PROMOTION feature && settings.autoPromoteEnabled
 * 2. item.status === 'candidate'
 * 3. item.trust !== 'external_untrusted' (exhaustive switch for compile safety)
 * 4. (model_inference only) corroborationCount >= settings.autoPromoteMinCorroborations
 * 5. now - item.createdAt >= settings.autoPromoteMinAgeHours * 3600_000
 * 6. Corroborations from ≥ 2 distinct sourceRefs.id (activity restating self ≠ corroboration)
 * 7. Persona autonomyLevel !== 'locked'
 * 8. Item not in unresolved conflict (conflictsWith empty)
 */
export async function promoteMemoryCandidate(
  personaId: string,
  memoryId: string,
  options: PersonaDomainMutationOptions = {},
): Promise<MemoryItem | null> {
  if (!FEATURES.ENABLE_MEMORY_AUTO_PROMOTION) {
    return null;
  }

  return withPersonaDomainMutation(personaId, options, async ({ persona }) => {
    // Precondition 7: Persona not locked
    if (persona.autonomyLevel === 'locked') {
      log.debug('Skipping auto-promotion for locked Persona.', { personaId, memoryId });
      return null;
    }

    const item = await getMemoryItem(personaId, memoryId);
    if (!item || item.personaId !== personaId) {
      return null;
    }

    const now = Date.now();
    const settings = await getMemorySettings();

    // Precondition 1: Feature enabled && settings enabled
    if (!settings.autoPromoteEnabled) {
      return null;
    }

    // Precondition 2: Must be a candidate
    if (item.status !== 'candidate') {
      return null;
    }

    // Precondition 8: No unresolved conflicts
    if (item.conflictsWith && item.conflictsWith.length > 0) {
      log.debug('Skipping auto-promotion for item with unresolved conflicts.', { memoryId });
      return null;
    }

    // Precondition 5: Min age requirement
    const ageMs = now - item.createdAt;
    const minAgeMs = settings.autoPromoteMinAgeHours * 60 * 60 * 1000;
    if (ageMs < minAgeMs) {
      return null;
    }

    // Precondition 3 & 4: Trust level and corroboration requirements
    const canPromote = assessAutoPromotionEligibility(item, settings);
    if (!canPromote) {
      return null;
    }

    // Precondition 6: Check distinct source requirement
    const sourceIds = new Set(item.sourceRefs.map((ref) => ref.id));
    if (sourceIds.size < 2) {
      return null;
    }

    // All preconditions met; attempt promotion via assertActivationPolicy
    try {
      // System-approved promotion (not model-invoked, approved via corroboration)
      assertActivationPolicy(
        item.trust,
        'active',
        { ...options, reviewed: true },  // Mark as reviewed to signal system approval
        item.sourceRefs.map((ref) => ref.kind),
      );

      const promoted = await saveMemoryItem({
        ...item,
        status: 'active',
        lifecycleReason: 'auto_promoted',
        updatedAt: Math.max(now, item.updatedAt + 1),
      });

      log.info('Auto-promoted candidate to active.', {
        memoryId,
        personaId,
        corroborationCount: item.corroborationCount,
        ageHours: Math.floor(ageMs / (60 * 60 * 1000)),
      });

      return promoted;
    } catch (error) {
      if (error instanceof PersonaDomainConflictError) {
        log.debug('Promotion blocked by activation policy.', { memoryId, error: error.message });
        return null;
      }
      throw error;
    }
  }).catch((error) => {
    if (error instanceof PersonaDomainBusyError) {
      log.debug('Skipping promotion; Persona locked.', { personaId, memoryId });
      return null;
    }
    throw error;
  });
}

/**
 * Assess whether a candidate is eligible for auto-promotion based on trust and corroboration.
 * Enforces:
 * - external_untrusted never promotes (exhaustive switch)
 * - model_inference requires corroborationCount >= threshold
 * - explicit_user / verified_tool can always promote if other criteria met
 */
function assessAutoPromotionEligibility(item: MemoryItem, settings: Required<MemorySettings>): boolean {
  switch (item.trust) {
    case 'external_untrusted':
      // Exhaustive switch ensures compile error if a new trust level is added without consideration
      return false;
    case 'model_inference':
      // Model-inferred must meet corroboration threshold
      return (item.corroborationCount ?? 0) >= settings.autoPromoteMinCorroborations;
    case 'explicit_user':
    case 'verified_tool':
      // User and tool candidates can always promote if other criteria met
      return true;
    default:
      // Exhaustive check; this line should never execute
      const _: never = item.trust;
      return _;
  }
}

/**
 * Sweep memory candidates for expiry, promotion, and conflict link repair.
 * Returns counts for observability; errors are logged and swallowed (sweep is best-effort).
 * 
 * Triggers (per design D8):
 * - Hourly cron job (via init.ts armRetentionSweep)
 * - Opportunistic post-activity (via personaDispatcher.ensurePostActivityMaintenance)
 * 
 * @param personaId Optional: sweep only this persona. If undefined, sweeps all personas in workspace.
 * @param now Optional: override current timestamp (for testing with fake timers)
 * @returns Statistics on actions taken
 */
export async function sweepMemoryCandidates(personaId?: string, now = Date.now()): Promise<SweepStatistics> {
  const stats: SweepStatistics = { promoted: 0, expired: 0, repaired: 0 };

  try {
    const settings = await getMemorySettings();

    // Early exit if no cleanup is needed
    if (
      settings.candidateExpiryDays <= 0
      && !settings.autoPromoteEnabled
      && !FEATURES.ENABLE_MEMORY_CONFLICT_SURFACING
    ) {
      return stats;
    }

    if (personaId) {
      // Sweep single persona
      await sweepPersonaMemoryCandidates(personaId, now, settings, stats);
    } else {
      // Sweep all personas in workspace (TODO: list all personas, iterate)
      log.debug('Workspace-wide sweep not yet implemented; use per-persona calls.');
    }

    return stats;
  } catch (error) {
    log.error('Memory candidate sweep encountered an error.', { error });
    return stats;
  }
}

/**
 * Sweep candidates for a single persona.
 */
async function sweepPersonaMemoryCandidates(
  personaId: string,
  now: number,
  settings: Required<MemorySettings>,
  stats: SweepStatistics,
): Promise<void> {
  try {
    const candidates = await listMemoryItems(personaId);
    const toProcess = candidates.filter((item) => item.status === 'candidate');

    for (const candidate of toProcess) {
      try {
        // Try auto-promotion first
        const promoted = await promoteMemoryCandidate(personaId, candidate.id, {});
        if (promoted) {
          stats.promoted++;
          continue;
        }

        // Check expiry
        if (candidate.expiresAt !== undefined && candidate.expiresAt <= now) {
          // Skip if reviewed (human decided to keep it)
          if (candidate.reviewedAt !== undefined) {
            continue;
          }

          // Expire the candidate
          await saveMemoryItem({
            ...candidate,
            status: 'forgotten',
            lifecycleReason: 'expired',
            updatedAt: Math.max(now, candidate.updatedAt + 1),
          });

          stats.expired++;
        }
      } catch (error) {
        log.warn('Error processing candidate during sweep.', { candidateId: candidate.id, error });
      }
    }

    if (FEATURES.ENABLE_MEMORY_CONFLICT_SURFACING) {
      stats.repaired += await repairPersonaConflictLinks(personaId);
    }
  } catch (error) {
    log.error('Error sweeping persona candidates.', { personaId, error });
  }
}


/** Repair at most 200 stored conflict edges for one Persona per sweep. */
async function repairPersonaConflictLinks(personaId: string): Promise<number> {
  return withPersonaDomainMutation(personaId, {}, async () => {
    const items = await listMemoryItems(personaId, { order: 'updated_at' });
    const seenPairs = new Set<string>();
    let examined = 0;
    let repaired = 0;

    for (const snapshot of items) {
      for (const targetId of snapshot.conflictsWith ?? []) {
        if (examined >= 200) return repaired;
        const pairKey = [snapshot.id, targetId].sort().join('\u0000');
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        examined++;

        const source = await getMemoryItem(personaId, snapshot.id);
        if (!source?.conflictsWith?.includes(targetId)) continue;
        const target = await getMemoryItem(personaId, targetId);
        if (!target || target.personaId !== personaId) {
          const links = source.conflictsWith.filter(id => id !== targetId);
          const next = {
            ...source,
            ...(links.length > 0 ? { conflictsWith: links } : {}),
            updatedAt: Math.max(Date.now(), source.updatedAt + 1),
          } as MemoryItem;
          if (links.length === 0) delete next.conflictsWith;
          await saveMemoryItem(next);
          repaired++;
          log.warn('Removed invalid memory conflict link.', {
            personaId,
            memoryId: source.id,
            targetId,
          });
          continue;
        }
        if (!target.conflictsWith?.includes(source.id)) {
          await saveMemoryItem({
            ...target,
            conflictsWith: [...new Set([...(target.conflictsWith ?? []), source.id])].sort(),
            updatedAt: Math.max(Date.now(), target.updatedAt + 1),
          });
          repaired++;
        }
      }
    }
    return repaired;
  });
}
