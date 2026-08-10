import type { Flow } from '@/shared/types/flow';

export const ENDURING_AGENT_SCHEMA_VERSION = 1 as const;
export const PERSONA_INSTRUCTION_CONTEXT_SCHEMA_VERSION = 1 as const;

export const PERSONA_LIFECYCLE_STATES = [
  'idle',
  'busy',
  'waiting',
  'sleeping',
  'disabled',
  'error',
] as const;
export type PersonaLifecycleState = (typeof PERSONA_LIFECYCLE_STATES)[number];

export const PERSONA_AUTONOMY_LEVELS = [
  'locked',
  'learn_hints',
  'propose_overrides',
  'auto_apply_validated',
] as const;
export type PersonaAutonomyLevel = (typeof PERSONA_AUTONOMY_LEVELS)[number];

export const PERSONA_INTERRUPTION_POLICIES = [
  'queue',
  'related_only',
  'allow_urgent',
] as const;
export type PersonaInterruptionPolicy = (typeof PERSONA_INTERRUPTION_POLICIES)[number];

export interface PersonaAttribution {
  personaId: string;
  activityId?: string;
  behaviorRevisionId?: string;
}

/**
 * Capability-free identity/mission instructions frozen by the trusted Persona
 * dispatcher for one top-level Activity. The rendered instruction is persisted
 * verbatim so approval/debug resumes and crash recovery never re-resolve mutable
 * Persona metadata or depend on a newer renderer implementation.
 */
export interface PersonaInstructionContext {
  schemaVersion: typeof PERSONA_INSTRUCTION_CONTEXT_SCHEMA_VERSION;
  personaId: string;
  activityId: string;
  behaviorRevisionId: string;
  behaviorContentHash: string;
  behaviorSlotKey: string;
  rootFlowId: string;
  roleVersionId: string;
  personaName: string;
  personaMission?: string;
  roleName: string;
  roleMission: string;
  /** Exact curated records frozen for this Activity; contents remain data. */
  coreMemoryItemIds?: string[];
  coreMemoryDigest?: string;
  /** Exact trusted system-prompt prefix; never interpolate runtime pills in it. */
  instruction: string;
}

export interface RoleDefinition {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION;
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateRoleDefinitionInput {
  id?: string;
  name: string;
  description?: string;
}

export interface RoleBehaviorSlot {
  key: string;
  name: string;
  description?: string;
  requiredCapabilities?: string[];
  /** Immutable template embedded in—and therefore versioned with—the Role. */
  flowTemplate: Flow;
}

export interface RoleCapabilityRequirements {
  semantic: string[];
  preferredMcpServers?: string[];
}

export interface PersonaPresentation {
  avatarUrl?: string;
  voice?: string;
  language?: string;
}

export interface RoleDefaults {
  autonomyLevel: PersonaAutonomyLevel;
  interruptionPolicy: PersonaInterruptionPolicy;
  memory?: {
    candidateLimitPerActivity: number;
    coreMemoryMaxItems: number;
  };
  presentation?: PersonaPresentation;
}

/** Immutable after creation. A new definition revision receives a new id. */
export interface RoleVersion {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION;
  id: string;
  roleDefinitionId: string;
  version: number;
  name: string;
  mission: string;
  behaviorSlots: RoleBehaviorSlot[];
  capabilityRequirements?: RoleCapabilityRequirements;
  defaults?: RoleDefaults;
  migrationNotes?: string;
  createdAt: number;
}

export interface CreateRoleVersionInput {
  id?: string;
  roleDefinitionId: string;
  version: number;
  name: string;
  mission: string;
  behaviorSlots: RoleBehaviorSlot[];
  capabilityRequirements?: RoleCapabilityRequirements;
  defaults?: RoleDefaults;
  migrationNotes?: string;
}

export interface Persona {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION;
  id: string;
  name: string;
  /** Immutable pin until an explicit upgrade operation changes it. */
  roleVersionId: string;
  lifecycleState: PersonaLifecycleState;
  mission?: string;
  presentation?: PersonaPresentation;
  autonomyLevel: PersonaAutonomyLevel;
  interruptionPolicy: PersonaInterruptionPolicy;
  /** Curated materialized view; items still live in the MemoryItem collection. */
  coreMemoryItemIds?: string[];
  /** Hash only—never persist a caller's raw idempotency token. */
  factoryKeyHash?: string;
  /** Crash-retry marker for the multi-record deterministic factory. */
  provisioningState?: 'pending' | 'ready';
  createdAt: number;
  updatedAt: number;
}

export interface InitialPersonaMemoryInput {
  content: string;
  kind?: Extract<MemoryKind, 'semantic' | 'episodic'>;
  scope?: MemoryScope;
  confidence?: number;
  importance?: number;
  sourceRefs?: MemorySourceRef[];
}

export interface CreatePersonaInput {
  id?: string;
  name: string;
  roleVersionId?: string;
  mission?: string;
  presentation?: PersonaPresentation;
  autonomyLevel?: PersonaAutonomyLevel;
  interruptionPolicy?: PersonaInterruptionPolicy;
  /** Makes retries deterministic; it is hashed before persistence. */
  idempotencyKey?: string;
  /** Explicit user-provided facts only; no biography is generated implicitly. */
  initialMemories?: InitialPersonaMemoryInput[];
}

export type BehaviorRevisionSource =
  | {
      kind: 'role_template';
      roleVersionId: string;
      slotKey: string;
      templateFlowId: string;
    }
  | {
      kind: 'persona_override';
      parentRevisionId?: string;
      evidenceRefs?: string[];
    }
  | {
      kind: 'import';
      sourceRef?: string;
    };

/** Immutable, content-addressed, Persona-owned executable Flow snapshot. */
export interface BehaviorRevision {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION;
  id: string;
  behaviorId: string;
  personaId: string;
  slotKey: string;
  revision: number;
  contentHash: string;
  flowSnapshot: Flow;
  source: BehaviorRevisionSource;
  createdAt: number;
}

export interface CreateBehaviorRevisionInput {
  id?: string;
  behaviorId: string;
  personaId: string;
  slotKey: string;
  revision: number;
  flowSnapshot: Flow;
  source: BehaviorRevisionSource;
}

/** Stable Persona-owned Behavior slot pointing at one immutable revision. */
export interface BehaviorBinding {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION;
  id: string;
  personaId: string;
  slotKey: string;
  activeRevisionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateBehaviorBindingInput {
  id?: string;
  personaId: string;
  slotKey: string;
  activeRevisionId: string;
}

export const PERSONA_ACTIVITY_KINDS = [
  'interactive_chat',
  'assignment',
  'scheduled',
  'triggered',
  'meeting',
  'voice',
  'maintenance',
] as const;
export type PersonaActivityKind = (typeof PERSONA_ACTIVITY_KINDS)[number];

export const PERSONA_ACTIVITY_STATUSES = [
  'queued',
  'running',
  'waiting',
  'completed',
  'cancelled',
  'error',
] as const;
export type PersonaActivityStatus = (typeof PERSONA_ACTIVITY_STATUSES)[number];

export const PERSONA_ACTIVITY_SOURCE_KINDS = [
  'chat',
  'assignment',
  'schedule',
  'trigger',
  'meeting',
  'voice',
  'maintenance',
  'api',
] as const;
export type PersonaActivitySourceKind = (typeof PERSONA_ACTIVITY_SOURCE_KINDS)[number];

export interface PersonaActivitySource {
  kind: PersonaActivitySourceKind;
  sourceId?: string;
  idempotencyKey?: string;
}

export interface PersonaActivity {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION;
  id: string;
  personaId: string;
  kind: PersonaActivityKind;
  status: PersonaActivityStatus;
  source: PersonaActivitySource;
  behaviorId?: string;
  behaviorRevisionId?: string;
  leaseId?: string;
  conversationId?: string;
  runId?: string;
  meetingId?: string;
  resourceRefs?: string[];
  outcomeRef?: string;
  error?: string;
  /** Durable cooperative-interruption request; the current holder yields explicitly. */
  interruptionRequestedAt?: number;
  interruptionRequestedByMailboxItemId?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface CreatePersonaActivityInput {
  id?: string;
  personaId: string;
  kind: PersonaActivityKind;
  source: PersonaActivitySource;
  behaviorId?: string;
  behaviorRevisionId?: string;
}

export const PERSONA_WORK_ITEM_STATUSES = [
  'open',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
] as const;
export type PersonaWorkItemStatus = (typeof PERSONA_WORK_ITEM_STATUSES)[number];

export const PERSONA_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type PersonaPriority = (typeof PERSONA_PRIORITIES)[number];

export interface PersonaWorkItem {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION;
  id: string;
  personaId: string;
  title: string;
  description?: string;
  status: PersonaWorkItemStatus;
  priority: PersonaPriority;
  dependencyIds: string[];
  nextAction?: string;
  deadline?: number;
  createdByActivityId?: string;
  behaviorRevisionId?: string;
  sourceRefs?: MemorySourceRef[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface CreatePersonaWorkItemInput {
  id?: string;
  personaId: string;
  title: string;
  description?: string;
  priority?: PersonaPriority;
  dependencyIds?: string[];
  nextAction?: string;
  deadline?: number;
  createdByActivityId?: string;
  sourceRefs?: MemorySourceRef[];
}

export interface UpdatePersonaWorkItemInput {
  title?: string;
  description?: string | null;
  status?: PersonaWorkItemStatus;
  priority?: PersonaPriority;
  dependencyIds?: string[];
  nextAction?: string | null;
  deadline?: number | null;
  /** Optional optimistic-concurrency guard for REST and tool callers. */
  expectedUpdatedAt?: number;
}

export const MEMORY_KINDS = [
  'episodic',
  'semantic',
  'reflection',
  'procedural_hint',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_SCOPES = [
  'persona',
  'activity',
  'workspace',
  'relationship',
] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_STATUSES = ['candidate', 'active', 'superseded', 'forgotten'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_TRUST_LEVELS = [
  'explicit_user',
  'verified_tool',
  'model_inference',
  'external_untrusted',
] as const;
export type MemoryTrust = (typeof MEMORY_TRUST_LEVELS)[number];

export const MEMORY_SOURCE_KINDS = [
  'user_statement',
  'conversation',
  'activity',
  'run',
  'meeting',
  'tool_result',
  'compaction',
  'import',
] as const;
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

export interface MemorySourceRef {
  kind: MemorySourceKind;
  id: string;
  messageId?: string;
  uri?: string;
  observedAt?: number;
  /** Workspace is stamped by the trusted service and never selected by a model. */
  workspaceId?: string;
  /** Stable producer identity such as `user`, `tool:<server>/<name>`, or `maintenance`. */
  producer?: string;
  /** SHA-256 of the referenced evidence or, when unavailable, its canonical locator. */
  contentDigest?: string;
}

export interface MemoryItem {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION;
  id: string;
  personaId: string;
  kind: MemoryKind;
  scope: MemoryScope;
  status: MemoryStatus;
  content: string;
  confidence: number;
  importance: number;
  sourceRefs: MemorySourceRef[];
  trust: MemoryTrust;
  validFrom?: number;
  validUntil?: number;
  supersedes?: string[];
  /** Explicitly retained contradictory evidence; conflicts are never overwritten. */
  conflictsWith?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateMemoryItemInput {
  id?: string;
  personaId: string;
  kind: MemoryKind;
  scope: MemoryScope;
  status?: Extract<MemoryStatus, 'candidate' | 'active'>;
  content: string;
  confidence: number;
  importance: number;
  sourceRefs: MemorySourceRef[];
  trust: MemoryTrust;
  validFrom?: number;
  validUntil?: number;
  supersedes?: string[];
  conflictsWith?: string[];
}

export const PERSONA_MAILBOX_STATUSES = [
  'queued',
  'claimed',
  'coalesced',
  'completed',
  'rejected',
] as const;
export type PersonaMailboxStatus = (typeof PERSONA_MAILBOX_STATUSES)[number];

export const PERSONA_MAILBOX_RELATED_ACTIONS = ['steer', 'coalesce'] as const;
export type PersonaMailboxRelatedAction =
  (typeof PERSONA_MAILBOX_RELATED_ACTIONS)[number];

export const PERSONA_MAILBOX_ROUTING_DECISIONS = [
  'queue',
  'steer',
  'coalesce',
  'interrupt',
] as const;
export type PersonaMailboxRoutingDecision =
  (typeof PERSONA_MAILBOX_ROUTING_DECISIONS)[number];

export const PERSONA_MAILBOX_DELIVERY_STATUSES = ['pending', 'delivered'] as const;
export type PersonaMailboxDeliveryStatus =
  (typeof PERSONA_MAILBOX_DELIVERY_STATUSES)[number];

export interface PersonaMailboxItem {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION;
  id: string;
  personaId: string;
  /** SHA-256 digest of the caller-provided key; raw retry tokens are not persisted. */
  idempotencyKey: string;
  /** Monotonic per-Persona admission order used as the durable FIFO tie-breaker. */
  sequence: number;
  kind: PersonaActivityKind;
  priority: PersonaPriority;
  status: PersonaMailboxStatus;
  source: PersonaActivitySource;
  /** Trusted Role slot selected when the item is admitted to the mailbox. */
  behaviorSlotKey?: string;
  relationKey?: string;
  /** Adapter-requested related-work behavior; persisted for idempotency comparison. */
  relatedAction?: PersonaMailboxRelatedAction;
  /** Trusted routing outcome selected atomically by the Persona runtime. */
  routingDecision?: PersonaMailboxRoutingDecision;
  /** Existing Activity which receives a steering/coalesced delivery. */
  targetActivityId?: string;
  /** Delivery acknowledgement for steering/coalesced inputs. */
  deliveryStatus?: PersonaMailboxDeliveryStatus;
  deliveredAt?: number;
  /** Activity asked to yield before this queued urgent item may run. */
  interruptedActivityId?: string;
  summary?: string;
  payloadRef?: string;
  notBefore?: number;
  claimedActivityId?: string;
  coalescedIntoId?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface CreatePersonaMailboxItemInput {
  personaId: string;
  /** Raw request key. The runtime hashes it before deriving or storing identity. */
  idempotencyKey: string;
  kind: PersonaActivityKind;
  priority?: PersonaPriority;
  source: PersonaActivitySource;
  behaviorSlotKey?: string;
  relationKey?: string;
  relatedAction?: PersonaMailboxRelatedAction;
  summary?: string;
  payloadRef?: string;
  notBefore?: number;
}

export const PERSONA_LEASE_STATUSES = ['active', 'released', 'expired'] as const;
export type PersonaLeaseStatus = (typeof PERSONA_LEASE_STATUSES)[number];

/** Stored under the Persona id, while `id` identifies this acquisition. */
export interface PersonaLease {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  personaId: string;
  activityId: string;
  holderId: string;
  status: PersonaLeaseStatus;
  fencingToken: number;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
  releasedAt?: number;
}

export interface CreatePersonaLeaseInput {
  personaId: string;
  activityId: string;
  holderId: string;
  ttlMs: number;
}

export const PERSONA_DELETION_ARCHIVE_POLICIES = [
  'anonymize',
  'retain_tombstone',
] as const;
export type PersonaDeletionArchivePolicy =
  (typeof PERSONA_DELETION_ARCHIVE_POLICIES)[number];

export const PERSONA_DELETION_STATUSES = ['deleting', 'completed'] as const;
export type PersonaDeletionStatus = (typeof PERSONA_DELETION_STATUSES)[number];

export interface PersonaDeletionCounts {
  behaviorBindings: number;
  behaviorRevisions: number;
  memoryItems: number;
  workItems: number;
  liveActivities: number;
  archivedActivities: number;
  openMailboxItems: number;
  archivedMailboxItems: number;
  leaseRecords: number;
  coreMemoryItems: number;
  homeFiles: number;
  homeBytes: number;
}

/** Privacy review returned before any destructive Persona operation. */
export interface PersonaDeletionPreview {
  personaId: string;
  workspaceId: string;
  generatedAt: number;
  /** Binds confirmation to the exact inspected state without persisting private content. */
  previewToken: string;
  counts: PersonaDeletionCounts;
  activeLease: boolean;
  homeExists: boolean;
  referencedArchiveEvidence: {
    activities: number;
    mailboxItems: number;
    futureCrossSystemAttributionPolicy: 'anonymize_or_minimal_tombstone';
  };
  externalSharedResources: {
    /** Named configs referenced by owned Behavior snapshots; the configs are retained. */
    mcpConfigNames: string[];
    action: 'retained';
  };
  backupPolicy: {
    action: 'retained_until_workspace_backup_expiry';
    immediatePurgeSupported: false;
  };
}

export interface DeletePersonaInput {
  previewToken: string;
  archivePolicy: PersonaDeletionArchivePolicy;
  confirmation: 'DELETE';
}

/** Minimal durable anti-resurrection marker and deletion audit record. */
export interface PersonaDeletionTombstone {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  personaIdHash: string;
  /** Present only when the caller explicitly chooses retained attribution. */
  retainedPersonaId?: string;
  status: PersonaDeletionStatus;
  archivePolicy: PersonaDeletionArchivePolicy;
  previewToken: string;
  counts: PersonaDeletionCounts;
  requestedAt: number;
  updatedAt: number;
  completedAt?: number;
}
