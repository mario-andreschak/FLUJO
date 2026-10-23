export const COMPACTION_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const COMPACTION_PROJECTION_VERSION = 1 as const;
export const COMPACTION_POLICY_VERSION = 'summary-v8-bounded-source' as const;

export interface CompactionProjectionIdentity {
  /** Canonical conversation whose projected transcript produced this artifact. */
  conversationId: string;
  nodeId?: string;
  /** Identifies whether ProcessNode supplied a narrowed provider view. */
  view: 'full-history' | 'node-projected';
  /** Handoff plumbing is stripped before artifact digesting/materialization. */
  handoffPolicy: 'strip-v1';
  version: typeof COMPACTION_PROJECTION_VERSION;
  /** Model/tools/effective-policy fingerprint; incompatible requests cannot reuse an anchor. */
  configDigest?: string;
}

export interface WireSummaryArtifact {
  artifactId: string;
  conversationId: string;
  nodeId?: string;
  sourceStartId?: string;
  sourceEndId?: string;
  sourceMessageCount: number;
  sourceDigest: string;
  /** Exact latest user turn for which this prefix was materialized. */
  requestDigest?: string;
  projectionDigest: string;
  summaryText: string;
  summaryResourceUri?: string;
  /** Exact selected original user identities; omitted means all were retained. */
  protectedUserIds?: string[];
  /** Balanced immutable range summaries used to extend this prefix after restart. */
  summaryRanges?: SummaryRange[];
  policyVersion: string;
  modelId?: string;
  schemaVersion: typeof COMPACTION_ARTIFACT_SCHEMA_VERSION;
  createdAt: number;
}

export interface SummaryRange {
  level: number;
  sourceStartId: string;
  sourceEndId: string;
  sourceMessageCount: number;
  sourceDigest: string;
  summaryText: string;
  resourceUri: string;
}

export interface ConversationCompactionState {
  schemaVersion: typeof COMPACTION_ARTIFACT_SCHEMA_VERSION;
  artifacts: WireSummaryArtifact[];
}
