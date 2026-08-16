import { createHash } from 'crypto';

import type { Flow } from '@/shared/types/flow';

export interface FlowExecutionSnapshot {
  workspaceId: string;
  flowId: string;
  versionId: string;
  contentHash: string;
  flow: Flow;
}

/** Deterministic JSON used for content-addressing captured Flow definitions. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** Hash the exact immutable Flow definition that will be handed to the engine. */
export function hashFlowExecutionSnapshot(flow: Flow): string {
  return createHash('sha256').update(canonicalJson(flow)).digest('hex');
}

/**
 * Clone and content-address one authoritative Flow read. The clone is the
 * execution authority: callers persist it with the hash and never re-read the
 * mutable Flow reference while an Activity is running or resuming.
 */
export function createFlowExecutionSnapshot(
  workspaceId: string,
  flow: Flow,
): FlowExecutionSnapshot {
  const snapshot = structuredClone(flow);
  const contentHash = hashFlowExecutionSnapshot(snapshot);
  return {
    workspaceId,
    flowId: snapshot.id,
    versionId: `sha256:${contentHash}`,
    contentHash,
    flow: snapshot,
  };
}
