import { createHash } from 'crypto';

import type { MemorySourceRef } from '@/shared/types/enduringAgent';
import { getCurrentWorkspace } from '@/utils/workspace';

import { canonicalJson } from './behaviorRevisions';

function defaultProducer(ref: MemorySourceRef): string {
  switch (ref.kind) {
    case 'user_statement': return 'user';
    case 'tool_result': return 'tool';
    case 'compaction': return 'summarizing-compaction';
    case 'import': return 'import';
    default: return ref.kind;
  }
}
export function evidenceDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Stamp workspace/provenance fields that model-authored arguments cannot select. */
export function normalizeMemorySourceRefs(
  refs: readonly MemorySourceRef[],
  options: { now?: number; producer?: string; digestMaterial?: unknown } = {},
): MemorySourceRef[] {
  const now = options.now ?? Date.now();
  const workspaceId = getCurrentWorkspace();
  return refs.map((source) => {
    const locator = {
      kind: source.kind,
      id: source.id,
      messageId: source.messageId ?? null,
      uri: source.uri ?? null,
      workspaceId,
    };
    return {
      ...source,
      workspaceId,
      observedAt: source.observedAt ?? now,
      producer: options.producer ?? source.producer ?? defaultProducer(source),
      contentDigest: source.contentDigest ?? evidenceDigest(
        options.digestMaterial === undefined ? locator : { locator, evidence: options.digestMaterial },
      ),
    };
  });
}
