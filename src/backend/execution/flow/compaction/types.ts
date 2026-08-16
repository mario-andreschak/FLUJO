export const COMPACTION_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const COMPACTION_PROJECTION_VERSION = 1 as const;
export const COMPACTION_POLICY_VERSION = 'summary-v1' as const;

export interface CompactionProjectionIdentity {
  /** Canonical conversation whose projected transcript produced this artifact. */
  conversationId: string;
  nodeId?: string;
  /** Identifies whether ProcessNode supplied a narrowed provider view. */
  view: 'full-history' | 'node-projected';
  /** Handoff plumbing is stripped before artifact digesting/materialization. */
  handoffPolicy: 'strip-v1';
  version: typeof COMPACTION_PROJECTION_VERSION;
}

export interface WireSummaryArtifact {
  artifactId: string;
  conversationId: string;
  nodeId?: string;
  sourceStartId?: string;
  sourceEndId?: string;
  sourceMessageCount: number;
  sourceDigest: string;
  projectionDigest: string;
  summaryText: string;
  summaryResourceUri?: string;
  policyVersion: string;
  modelId?: string;
  schemaVersion: typeof COMPACTION_ARTIFACT_SCHEMA_VERSION;
  createdAt: number;
}

export interface ConversationCompactionState {
  schemaVersion: typeof COMPACTION_ARTIFACT_SCHEMA_VERSION;
  artifacts: WireSummaryArtifact[];
}
