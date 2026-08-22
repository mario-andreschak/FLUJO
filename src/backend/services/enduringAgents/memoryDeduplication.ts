import type {
  MemoryItem,
  MemorySourceRef,
  MemoryTrust,
} from '@/shared/types/enduringAgent';

import {
  contentShingles,
  jaccardSimilarity,
  MEMORY_DEDUP_SETTINGS,
  normaliseMemoryContent,
} from './memoryRanking';
import { normalizeMemorySourceRefs } from './provenance';

export const MEMORY_BACKFILL_VERSION = 1 as const;

const TRUST_RANK: Record<MemoryTrust, number> = {
  explicit_user: 4,
  verified_tool: 3,
  model_inference: 2,
  external_untrusted: 1,
};

export interface ReinforceMemoryItemOptions {
  now: number;
  incomingTrust: MemoryTrust;
  incomingSourceRefs: readonly MemorySourceRef[];
  canUpgradeTrust?: (trust: MemoryTrust) => boolean;
}

export interface MemoryDuplicateComponents {
  components: MemoryItem[][];
  duplicatePairsFound: number;
}

function sourceRefIdentity(ref: MemorySourceRef): string {
  return JSON.stringify([
    ref.kind,
    ref.id,
    ref.messageId ?? null,
    ref.uri ?? null,
    ref.workspaceId ?? null,
    ref.producer ?? null,
    ref.contentDigest ?? null,
  ]);
}

/** Normalize evidence and collapse exact references while retaining the oldest observation. */
export function normalizeAndDeduplicateMemorySourceRefs(
  refs: readonly MemorySourceRef[],
  now: number,
): MemorySourceRef[] {
  const result: MemorySourceRef[] = [];
  const indexes = new Map<string, number>();

  for (const ref of normalizeMemorySourceRefs(refs, { now })) {
    const key = sourceRefIdentity(ref);
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, result.length);
      result.push(ref);
      continue;
    }

    const existing = result[existingIndex];
    if ((ref.observedAt ?? now) < (existing.observedAt ?? now)) {
      result[existingIndex] = ref;
    }
  }

  return result;
}

/**
 * Shared issue #450 reinforcement calculation. Persistence remains at the caller's
 * mutation boundary.
 */
export function buildReinforcedMemoryItem(
  survivor: MemoryItem,
  options: ReinforceMemoryItemOptions,
): MemoryItem {
  let trust = survivor.trust;
  if (
    TRUST_RANK[options.incomingTrust] > TRUST_RANK[survivor.trust]
    && (options.canUpgradeTrust?.(options.incomingTrust) ?? true)
  ) {
    trust = options.incomingTrust;
  }

  const sourceRefs = normalizeAndDeduplicateMemorySourceRefs(
    [...survivor.sourceRefs, ...options.incomingSourceRefs],
    options.now,
  ).slice(0, MEMORY_DEDUP_SETTINGS.maxSourceRefsPerItem);

  return {
    ...survivor,
    confidence: Math.min(
      1,
      survivor.confidence + MEMORY_DEDUP_SETTINGS.confidenceReinforcementStep,
    ),
    importance: Math.min(
      1,
      survivor.importance + MEMORY_DEDUP_SETTINGS.importanceReinforcementStep,
    ),
    trust,
    sourceRefs,
    updatedAt: Math.max(options.now, survivor.updatedAt + 1),
  };
}

/**
 * Exhaustively find connected components of active near-duplicates. Components
 * never cross Persona, kind, or scope boundaries.
 */
export function findMemoryDuplicateComponents(
  memories: readonly MemoryItem[],
): MemoryDuplicateComponents {
  const active = memories
    .filter((item) => item.status === 'active')
    .sort((a, b) => a.id.localeCompare(b.id));
  const groups = new Map<string, MemoryItem[]>();

  for (const item of active) {
    const key = JSON.stringify([item.personaId, item.kind, item.scope]);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const components: MemoryItem[][] = [];
  let duplicatePairsFound = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const parent = group.map((_, index) => index);
    const shingles = group.map((item) => (
      contentShingles(normaliseMemoryContent(item.content))
    ));

    const find = (index: number): number => {
      let root = index;
      while (parent[root] !== root) root = parent[root];
      while (parent[index] !== index) {
        const next = parent[index];
        parent[index] = root;
        index = next;
      }
      return root;
    };
    const union = (left: number, right: number): void => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
    };

    for (let left = 0; left < group.length - 1; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        if (
          jaccardSimilarity(shingles[left], shingles[right])
          >= MEMORY_DEDUP_SETTINGS.nearDuplicateThreshold
        ) {
          duplicatePairsFound += 1;
          union(left, right);
        }
      }
    }

    const byRoot = new Map<number, MemoryItem[]>();
    for (let index = 0; index < group.length; index += 1) {
      const root = find(index);
      const component = byRoot.get(root);
      if (component) component.push(group[index]);
      else byRoot.set(root, [group[index]]);
    }

    for (const component of byRoot.values()) {
      if (component.length > 1) {
        components.push(component.sort((a, b) => a.id.localeCompare(b.id)));
      }
    }
  }

  components.sort((a, b) => a[0].id.localeCompare(b[0].id));
  return { components, duplicatePairsFound };
}

/** Pick the same survivor regardless of input or filesystem enumeration order. */
export function selectMemoryDuplicateSurvivor(
  component: readonly MemoryItem[],
  coreMemoryItemIds: ReadonlySet<string>,
): MemoryItem {
  if (component.length === 0) {
    throw new Error('Cannot select a survivor from an empty duplicate component.');
  }

  return [...component].sort((left, right) => (
    Number(coreMemoryItemIds.has(right.id)) - Number(coreMemoryItemIds.has(left.id))
    || TRUST_RANK[right.trust] - TRUST_RANK[left.trust]
    || right.confidence - left.confidence
    || right.importance - left.importance
    || left.createdAt - right.createdAt
    || left.id.localeCompare(right.id)
  ))[0];
}

export function highestPermittedMemoryTrust(
  memories: readonly MemoryItem[],
  fallback: MemoryTrust,
  isPermitted: (trust: MemoryTrust) => boolean,
): MemoryTrust {
  const trusts = [...new Set(memories.map((item) => item.trust))]
    .sort((left, right) => TRUST_RANK[right] - TRUST_RANK[left]);
  return trusts.find(isPermitted) ?? fallback;
}
