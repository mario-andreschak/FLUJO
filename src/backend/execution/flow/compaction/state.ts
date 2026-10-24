import type { FlujoChatMessage } from '@/shared/types/chat';
import type { ConversationCompactionState, WireSummaryArtifact } from './types';
import { COMPACTION_ARTIFACT_SCHEMA_VERSION } from './types';

/** Summary metadata is a disposable projection cache, never execution-owned
 * history. Keep the current artifact per node/model and a bounded recent cache
 * rather than accumulating one full anchor for every growing recent tail. */
export function retainSummaryArtifacts(
  previous: readonly WireSummaryArtifact[],
  next: WireSummaryArtifact,
): WireSummaryArtifact[] {
  return boundSummaryArtifacts([...previous, next]);
}

function boundSummaryArtifacts(candidates: readonly WireSummaryArtifact[]): WireSummaryArtifact[] {
  let characters = 0;
  const retained: WireSummaryArtifact[] = [];
  const identities = new Set<string>();
  for (let index = candidates.length - 1; index >= 0; index--) {
    const artifact = candidates[index];
    const identity = JSON.stringify([artifact.nodeId, artifact.modelId]);
    if (identities.has(identity)) continue;
    identities.add(identity);
    const size = artifact.summaryText.length + JSON.stringify(artifact.summaryRanges ?? []).length
      + JSON.stringify(artifact.protectedUserIds ?? []).length;
    if (retained.length >= 64 || characters + size > 1_048_576) continue;
    characters += size;
    retained.push(artifact);
  }
  return retained.reverse();
}

function isArtifact(value: unknown): value is WireSummaryArtifact {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as Partial<WireSummaryArtifact>;
  return artifact.schemaVersion === COMPACTION_ARTIFACT_SCHEMA_VERSION &&
    typeof artifact.artifactId === 'string' &&
    typeof artifact.conversationId === 'string' &&
    typeof artifact.sourceDigest === 'string' &&
    typeof artifact.projectionDigest === 'string' &&
    typeof artifact.summaryText === 'string' &&
    typeof artifact.policyVersion === 'string' &&
    typeof artifact.sourceMessageCount === 'number' &&
    typeof artifact.createdAt === 'number' &&
    (artifact.protectedUserIds === undefined || (Array.isArray(artifact.protectedUserIds)
      && artifact.protectedUserIds.every(id => typeof id === 'string'))) &&
    (artifact.summaryRanges === undefined || (Array.isArray(artifact.summaryRanges) && artifact.summaryRanges.length <= 256
      && artifact.summaryRanges.every(range => range && Number.isSafeInteger(range.level) && range.level >= 0
        && Number.isSafeInteger(range.sourceMessageCount) && range.sourceMessageCount > 0
        && typeof range.sourceStartId === 'string' && typeof range.sourceEndId === 'string'
        && typeof range.sourceDigest === 'string' && typeof range.summaryText === 'string'
        && typeof range.resourceUri === 'string' && range.resourceUri.startsWith('flujo://run/' + artifact.conversationId + '/'))));
}

/**
 * Validate durable compaction metadata without ever using it to reconstruct or
 * mutate canonical history. Exact digest/policy/model validation happens again
 * against the node-projected source immediately before reuse.
 */
export function validateCompactionState(
  state: ConversationCompactionState | undefined,
  conversationId: string,
  messages: readonly FlujoChatMessage[],
): ConversationCompactionState | undefined {
  if (!state || state.schemaVersion !== COMPACTION_ARTIFACT_SCHEMA_VERSION || !Array.isArray(state.artifacts)) {
    return undefined;
  }
  const canonicalIds = new Set(messages.map(message => message.id));
  const artifacts = boundSummaryArtifacts(state.artifacts.filter(artifact =>
    isArtifact(artifact) &&
    artifact.conversationId === conversationId &&
    (!artifact.sourceStartId || canonicalIds.has(artifact.sourceStartId)) &&
    (!artifact.sourceEndId || canonicalIds.has(artifact.sourceEndId))
  ));
  return artifacts.length > 0
    ? { schemaVersion: COMPACTION_ARTIFACT_SCHEMA_VERSION, artifacts }
    : undefined;
}
