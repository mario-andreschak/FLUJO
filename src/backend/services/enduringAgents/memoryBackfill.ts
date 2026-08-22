import { createLogger } from '@/utils/logger';

import {
  PersonaDomainBusyError,
  withPersonaDomainMutation,
} from './domainMutation';
import {
  buildReinforcedMemoryItem,
  findMemoryDuplicateComponents,
  highestPermittedMemoryTrust,
  MEMORY_BACKFILL_VERSION,
  normalizeAndDeduplicateMemorySourceRefs,
  selectMemoryDuplicateSurvivor,
} from './memoryDeduplication';
import { assertActivationPolicy } from './memoryKernel';
import { MEMORY_DEDUP_SETTINGS } from './memoryRanking';
import {
  listMemoryItems,
  listPersonas,
  saveMemoryItem,
} from './store';

const log = createLogger('backend/services/enduringAgents/memoryBackfill');

export interface MemoryBackfillStatistics {
  personasScanned: number;
  memoriesScanned: number;
  duplicatePairsFound: number;
  clustersMerged: number;
  siblingsRemoved: number;
  skippedBusy: number;
  skippedProvenanceOverflow: number;
  errors: number;
}

export interface MemoryBackfillOptions {
  now?: number;
  personaId?: string;
}

function emptyStatistics(): MemoryBackfillStatistics {
  return {
    personasScanned: 0,
    memoriesScanned: 0,
    duplicatePairsFound: 0,
    clustersMerged: 0,
    siblingsRemoved: 0,
    skippedBusy: 0,
    skippedProvenanceOverflow: 0,
    errors: 0,
  };
}

/**
 * Exhaustively backfill near-duplicate memories in the current workspace.
 *
 * Personas are intentionally processed one at a time. Each Persona is scanned
 * and mutated under its existing runtime/domain lock, and active leases are
 * skipped so maintenance never interrupts live work.
 */
export async function backfillStoredMemoryDuplicates(
  options: MemoryBackfillOptions = {},
): Promise<MemoryBackfillStatistics> {
  const statistics = emptyStatistics();
  if (!MEMORY_DEDUP_SETTINGS.enabled) return statistics;

  const now = options.now ?? Date.now();
  const personas = (await listPersonas())
    .filter((persona) => !options.personaId || persona.id === options.personaId)
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const listedPersona of personas) {
    try {
      await withPersonaDomainMutation(
        listedPersona.id,
        {},
        async ({ persona, updatePersona }) => {
          statistics.personasScanned += 1;

          // This validated, index-backed read happens only after the Persona lock
          // is held and is the source of truth for every mutation below.
          const memories = await listMemoryItems(persona.id);
          statistics.memoriesScanned += memories.length;

          const duplicateResult = findMemoryDuplicateComponents(memories);
          statistics.duplicatePairsFound += duplicateResult.duplicatePairsFound;

          let currentPersona = persona;
          for (const component of duplicateResult.components) {
            const coreIds = new Set(currentPersona.coreMemoryItemIds ?? []);
            const survivor = selectMemoryDuplicateSurvivor(component, coreIds);
            const siblings = component.filter((item) => item.id !== survivor.id);
            const mergedSourceRefs = normalizeAndDeduplicateMemorySourceRefs(
              component.flatMap((item) => item.sourceRefs),
              now,
            );

            if (mergedSourceRefs.length > MEMORY_DEDUP_SETTINGS.maxSourceRefsPerItem) {
              statistics.skippedProvenanceOverflow += 1;
              log.warn('Skipped memory duplicate component because provenance exceeds the safe cap', {
                personaId: persona.id,
                survivorId: survivor.id,
                memberIds: component.map((item) => item.id),
                sourceRefCount: mergedSourceRefs.length,
              });
              continue;
            }

            const priorMemberIds = survivor.backfillMerge?.version === MEMORY_BACKFILL_VERSION
              ? survivor.backfillMerge.memberIds
              : [];
            const alreadyReinforced = component.every((item) => priorMemberIds.includes(item.id));

            if (!alreadyReinforced) {
              const canUseTrust = (trust: typeof survivor.trust): boolean => {
                try {
                  assertActivationPolicy(
                    trust,
                    survivor.status,
                    { reviewed: true },
                    mergedSourceRefs.map((ref) => ref.kind),
                  );
                  return true;
                } catch {
                  return false;
                }
              };
              const incomingTrust = highestPermittedMemoryTrust(
                component,
                survivor.trust,
                canUseTrust,
              );
              const reinforced = buildReinforcedMemoryItem(survivor, {
                now,
                incomingTrust,
                incomingSourceRefs: mergedSourceRefs,
                canUpgradeTrust: canUseTrust,
              });
              const memberIds = [...new Set([
                ...priorMemberIds,
                ...component.map((item) => item.id),
              ])].sort();

              await saveMemoryItem({
                ...reinforced,
                sourceRefs: mergedSourceRefs,
                backfillMerge: {
                  version: MEMORY_BACKFILL_VERSION,
                  memberIds,
                  mergedAt: now,
                },
              });
            }

            const siblingIds = new Set(siblings.map((item) => item.id));
            if ((currentPersona.coreMemoryItemIds ?? []).some((id) => siblingIds.has(id))) {
              currentPersona = await updatePersona({
                ...currentPersona,
                coreMemoryItemIds: (currentPersona.coreMemoryItemIds ?? [])
                  .filter((id) => !siblingIds.has(id)),
                updatedAt: Math.max(now, currentPersona.updatedAt + 1),
              });
            }

            // Retire siblings one at a time after the survivor is durable. A
            // retry recognizes the survivor marker and completes this loop
            // without applying a second reinforcement.
            for (const sibling of siblings) {
              await saveMemoryItem({
                ...sibling,
                status: 'forgotten',
                backfillMergedInto: survivor.id,
                updatedAt: Math.max(now, sibling.updatedAt + 1),
              });
              statistics.siblingsRemoved += 1;
            }
            statistics.clustersMerged += 1;
          }
        },
      );
    } catch (error) {
      if (error instanceof PersonaDomainBusyError) {
        statistics.skippedBusy += 1;
        continue;
      }
      statistics.errors += 1;
      log.warn('Stored memory duplicate backfill failed for Persona', {
        personaId: listedPersona.id,
        error,
      });
    }
  }

  log.info('Stored memory duplicate backfill completed', statistics);
  return statistics;
}
