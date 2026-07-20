/**
 * Pure grouping helpers for the "Group by wave" mode of the Chat Sidebar
 * (issue #181, Phase 2 follow-up to #147).
 *
 * A conversation carries the `plannedExecutionId` of the scheduler-originated
 * run that produced it (persisted on `SharedState`, issue #113). The Waves
 * resolver (`waveResolver.ts`, served at `GET /api/waves`) maps planned
 * executions into wave chains. This module turns a `WavesResponse` into a
 * fast `executionId -> { waveId, label }` lookup and derives the grouping
 * bucket for each conversation, with sensible fallbacks:
 *   - no `plannedExecutionId`            -> "Ad-hoc" (manual chat / API runs)
 *   - `plannedExecutionId` not in graph  -> "Archived / no longer scheduled"
 *     (the planned execution was deleted / disabled since the run)
 *
 * Kept free of React/MUI so it is unit-testable in the node-env Jest harness
 * (mirrors `cardGrouping.ts` / `flowGrouping.ts`).
 */
import type { WavesResponse } from '@/shared/types/waves/waves';
import type { CardGroup } from './cardGrouping';

/** What the lookup resolves an executionId to. */
export interface WaveLookupEntry {
  /** The owning wave's deterministic id. */
  waveId: string;
  /** Human-readable label for the wave's sidebar section. */
  label: string;
}

/** Stable key for conversations with no `plannedExecutionId` (ad-hoc runs). */
export const WAVE_ADHOC_KEY = 'wave:__adhoc__';
/** Header label for the ad-hoc bucket. */
export const WAVE_ADHOC_LABEL = 'Ad-hoc';
/** Stable key for conversations whose planned execution is gone from the graph. */
export const WAVE_ARCHIVED_KEY = 'wave:__archived__';
/** Header label for the archived bucket. */
export const WAVE_ARCHIVED_LABEL = 'Archived / no longer scheduled';

/**
 * Build an `executionId -> { waveId, label }` lookup from a `WavesResponse`.
 *
 * Every node in a wave maps to that wave. The wave's display label prefers the
 * (organic) root node's name, then its flow name, then the wave id as a last
 * resort — so a wave is labelled by whatever a human would recognise it by.
 */
export function buildWaveLookup(
  waves: WavesResponse | null | undefined,
): Map<string, WaveLookupEntry> {
  const map = new Map<string, WaveLookupEntry>();
  if (!waves?.waves) return map;
  for (const wave of waves.waves) {
    const rootId = wave.rootExecutionIds?.[0];
    const rootNode =
      (rootId && wave.nodes.find((n) => n.executionId === rootId)) || wave.nodes[0];
    const label = rootNode?.name || rootNode?.flowName || wave.id;
    for (const node of wave.nodes) {
      map.set(node.executionId, { waveId: wave.id, label });
    }
  }
  return map;
}

/**
 * Derive the `{ key, label }` grouping bucket for a conversation from its
 * `plannedExecutionId`, using a lookup from {@link buildWaveLookup}. Suitable
 * as the `deriveGroup` callback for `groupItems`.
 */
export function waveBucket(
  plannedExecutionId: string | null | undefined,
  lookup: Map<string, WaveLookupEntry>,
): { key: string; label: string } {
  if (!plannedExecutionId) {
    return { key: WAVE_ADHOC_KEY, label: WAVE_ADHOC_LABEL };
  }
  const info = lookup.get(plannedExecutionId);
  if (!info) {
    return { key: WAVE_ARCHIVED_KEY, label: WAVE_ARCHIVED_LABEL };
  }
  return { key: `wave:${info.waveId}`, label: info.label };
}

/**
 * Reorder grouped output so the "Ad-hoc" and "Archived" fallback buckets are
 * always rendered LAST, preserving the (recency-driven) order of the real wave
 * groups otherwise. Pure and order-preserving for the primary groups.
 */
export function orderWaveGroups<T>(groups: CardGroup<T>[]): CardGroup<T>[] {
  const fallback = new Set<string>([WAVE_ADHOC_KEY, WAVE_ARCHIVED_KEY]);
  const primary = groups.filter((g) => !fallback.has(g.key));
  const trailing = groups.filter((g) => fallback.has(g.key));
  return [...primary, ...trailing];
}
