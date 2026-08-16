import type { FlujoChatMessage } from '@/shared/types/chat';
import type { ConversationCompactionState, WireSummaryArtifact } from './types';
import { COMPACTION_ARTIFACT_SCHEMA_VERSION } from './types';

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
    typeof artifact.createdAt === 'number';
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
  const artifacts = state.artifacts.filter(artifact =>
    isArtifact(artifact) &&
    artifact.conversationId === conversationId &&
    (!artifact.sourceStartId || canonicalIds.has(artifact.sourceStartId)) &&
    (!artifact.sourceEndId || canonicalIds.has(artifact.sourceEndId))
  );
  return artifacts.length > 0
    ? { schemaVersion: COMPACTION_ARTIFACT_SCHEMA_VERSION, artifacts }
    : undefined;
}
