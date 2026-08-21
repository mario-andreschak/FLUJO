import type { Flow } from '@/shared/types/flow';
import type { MCPToolParameterPresets } from '@/shared/types/mcp';

export const ENDURING_AGENT_SCHEMA_VERSION = 1 as const;
/** Affected product records advance independently from durable runtime records. */
export const ROLE_DEFINITION_SCHEMA_VERSION = 2 as const;
export const ROLE_VERSION_SCHEMA_VERSION = 3 as const;
export const PERSONA_SCHEMA_VERSION = 2 as const;
export const PERSONA_CREATION_DRAFT_SCHEMA_VERSION = 1 as const;
export const BEHAVIOR_REVISION_SCHEMA_VERSION = 2 as const;
export const BEHAVIOR_BINDING_SCHEMA_VERSION = 2 as const;
export const PERSONA_INSTRUCTION_CONTEXT_SCHEMA_VERSION = 1 as const;
export const PERSONA_ACTIVITY_SCHEMA_VERSION = 2 as const;

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
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION | typeof ROLE_DEFINITION_SCHEMA_VERSION;
  id: string;
  name: string;
  description?: string;
  /** Opaque optimistic-concurrency token for the public Role API. */
  currentVersionId?: string;
  /** Archived Roles remain readable by pinned Personas but are hidden by default. */
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateRoleDefinitionInput {
  id?: string;
  name: string;
  description?: string;
}

/** Workspace-local reference only; no MCP configuration or credentials are copied. */
export interface RoleSuggestedAppReference {
  mcpServerName: string;
}

export type RoleSuggestedAppStatus =
  | 'available'
  | 'disabled'
  | 'apps_disabled'
  | 'missing';

export interface PublicRoleSuggestedApp extends RoleSuggestedAppReference {
  status: RoleSuggestedAppStatus;
}

export interface PublicRoleBehavior {
  key: string;
  name: string;
  description?: string;
}

export interface CreatePublicRoleInput {
  id?: string;
  name: string;
  prompt: string;
  suggestedApps?: RoleSuggestedAppReference[];
}

export interface UpdatePublicRoleInput {
  expectedCurrentVersionId: string;
  name?: string;
  prompt?: string;
  suggestedApps?: RoleSuggestedAppReference[];
}

export interface DuplicatePublicRoleInput {
  name?: string;
}

export interface RollbackPublicRoleInput {
  expectedCurrentVersionId: string;
  sourceVersionId: string;
}

export interface RestorePublicRoleInput {
  expectedCurrentVersionId: string;
}

export interface RoleLifecycleInput {
  expectedCurrentVersionId: string;
  action?: 'archive' | 'delete';
}

export interface PublicRole {
  id: string;
  name: string;
  prompt: string;
  suggestedApps: PublicRoleSuggestedApp[];
  behaviors: PublicRoleBehavior[];
  archived: boolean;
  currentVersionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface PublicRoleVersion {
  id: string;
  roleId: string;
  version: number;
  name: string;
  prompt: string;
  suggestedApps: PublicRoleSuggestedApp[];
  behaviors: PublicRoleBehavior[];
  createdAt: number;
  current: boolean;
}

export interface RoleImpactPreview {
  roleId: string;
  personaIds: string[];
  personaCount: number;
  pinnedRoleVersionIds: string[];
  hardDeleteAllowed: boolean;
  safeAction: 'archive';
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
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION | typeof ROLE_VERSION_SCHEMA_VERSION;
  id: string;
  roleDefinitionId: string;
  version: number;
  name: string;
  mission: string;
  /** Optional workspace-local App suggestions used only by the public Role layer. */
  suggestedApps?: RoleSuggestedAppReference[];
  coreFlowTemplate?: Flow;
  defaultModelId?: string;
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
  suggestedApps?: RoleSuggestedAppReference[];
  coreFlowTemplate?: Flow;
  defaultModelId?: string;
  behaviorSlots: RoleBehaviorSlot[];
  capabilityRequirements?: RoleCapabilityRequirements;
  defaults?: RoleDefaults;
  migrationNotes?: string;
}

export interface Persona {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION | typeof PERSONA_SCHEMA_VERSION;
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
  /**
   * Product-facing mutable references. Runtime execution never reads these in
   * place of a pinned RoleVersion, BehaviorRevision, or Activity Flow snapshot.
   */
  composition?: PersonaCompositionPreferences;
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
  /** Mutable authoring Core Flow; omitted keeps the deterministic primary Role binding. */
  coreFlowRef?: string;
  /** Explicit workspace Role version; Persona creation never selects one implicitly. */
  roleVersionId: string;
  /** Human-confirmed exact MCP configuration names; omitted uses Role suggestions. */
  appRefs?: string[];
  /** Existing workspace Flows selected as optional callable Behaviors, in display order. */
  behaviorFlowRefs?: string[];
  mission?: string;
  presentation?: Pick<PersonaPresentation, 'avatarUrl' | 'language'>;
  autonomyLevel?: PersonaAutonomyLevel;
  interruptionPolicy?: PersonaInterruptionPolicy;
  /** Makes retries deterministic; it is hashed before persistence. */
  idempotencyKey?: string;
  /** Explicit user-provided facts only; no biography is generated implicitly. */
  initialMemories?: InitialPersonaMemoryInput[];
}

/** Editable wizard values only; none of these references are materialized while drafting. */
export interface PersonaCreationDraftPayload {
  step: number;
  name: string;
  mission: string;
  avatarUrl: string;
  roleVersionId: string;
  coreFlowRef: string;
  behaviorFlowRefs: string[];
  appRefs: string[];
  appsEdited: boolean;
  memories: string[];
  /** Preserves deterministic final-create retries across save and resume. */
  idempotencyKey: string;
}

export interface PersonaCreationDraft {
  schemaVersion: typeof PERSONA_CREATION_DRAFT_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  status: 'draft';
  payload: PersonaCreationDraftPayload;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreatePersonaCreationDraftInput {
  /** Supplying a stable id makes a retried create idempotent. */
  id?: string;
  payload: PersonaCreationDraftPayload;
}

export interface UpdatePersonaCreationDraftInput {
  expectedRevision: number;
  payload: PersonaCreationDraftPayload;
}

export interface DeletePersonaCreationDraftInput {
  expectedRevision: number;
}

/** User-editable Persona settings. Runtime-owned identity and timestamps stay immutable. */
export interface UpdatePersonaInput {
  name?: string;
  /** Selects the immutable Role version used to frame future Activities. */
  roleVersionId?: string;
  mission?: string | null;
  presentation?: {
    avatarUrl?: string | null;
    language?: string | null;
  };
  autonomyLevel?: PersonaAutonomyLevel;
  interruptionPolicy?: PersonaInterruptionPolicy;
  /** Administrative lifecycle controls never manufacture busy/waiting/error states. */
  lifecycleState?: Extract<PersonaLifecycleState, 'idle' | 'sleeping' | 'disabled'>;
  /** Optimistic-concurrency guard used by the inspectability UI. */
  expectedUpdatedAt?: number;
}

/** Friendly Role projection selected by one Persona composition. */
export interface PersonaRoleComposition {
  /** Stable RoleDefinition reference. */
  ref: string;
  name: string;
  /** Plain-language Role prompt. */
  prompt: string;
  /** Ordered workspace MCP App configuration references. */
  suggestedAppRefs: string[];
}

export type PersonaFlowBinding =
  | {
      mode: 'shared';
      sharedFlowRef: string;
    }
  | {
      mode: 'persona_copy';
      sharedFlowRef?: string;
      personaFlowRef: string;
    };

/** Friendly editable Behavior Flow binding; revision mechanics stay internal. */
export interface PersonaBehaviorComposition {
  /** Stable existing BehaviorBinding id. */
  ref: string;
  /** Stable callable slot identity. */
  slotKey?: string;
  name: string;
  description?: string;
  order?: number;
  binding?: PersonaFlowBinding;
  /** Compatibility fields retained while runtime readers migrate to binding. */
  sourceFlowRef?: string;
  overrideFlowRef?: string;
}

export type PersonaFlowReadinessState = 'ready' | 'invalid' | 'missing';

export interface PersonaFlowReadiness {
  state: PersonaFlowReadinessState;
  issues: string[];
}

export interface PersonaFlowCard {
  binding: PersonaFlowBinding;
  effectiveFlowRef: string;
  flow?: Flow;
  readiness: PersonaFlowReadiness;
}

export interface PersonaBehaviorFlowCard extends PersonaFlowCard {
  ref: string;
  slotKey: string;
  name: string;
  description?: string;
  order: number;
}

export interface CopyPersonaFlowInput {
  expectedUpdatedAt: number;
  target: 'core' | 'behavior';
  behaviorRef?: string;
  sourceFlowRef: string;
}

export interface CopyPersonaFlowResult {
  composition: PersonaComposition;
  flow: Flow;
}

/**
 * Optional persisted compatibility layer. Missing fields are normalized from
 * the durable Persona bundle when projecting legacy records.
 */
export interface PersonaCompositionPreferences {
  description?: string;
  role?: PersonaRoleComposition;
  coreFlowRef?: string;
  coreBinding?: PersonaFlowBinding;
  appRefs?: string[];
  memoryRefs?: string[];
  behaviors?: PersonaBehaviorComposition[];
}

export interface PersonaCompositionMemory {
  ref: string;
  kind: MemoryKind;
  content: string;
}

/** Default product API view; deliberately omits revisions, hashes, leases, and runtime state. */
export interface PersonaComposition {
  personaRef: string;
  name: string;
  description: string;
  role: PersonaRoleComposition;
  coreFlowRef?: string;
  core?: PersonaFlowCard;
  appRefs: string[];
  memories: PersonaCompositionMemory[];
  behaviors: PersonaBehaviorComposition[];
  behaviorCards: PersonaBehaviorFlowCard[];
  /** Concurrency token required by composition updates. */
  expectedUpdatedAt: number;
}

export interface UpdatePersonaBehaviorComposition {
  ref: string;
  slotKey?: string;
  name: string;
  description?: string;
  order?: number;
  binding?: PersonaFlowBinding;
  /** Compatibility inputs accepted from older clients. */
  sourceFlowRef?: string;
  /** null clears a previously selected Persona override. */
  overrideFlowRef?: string | null;
}

export interface UpdatePersonaCompositionInput {
  expectedUpdatedAt: number;
  name?: string;
  coreFlowRef?: string | null;
  memoryRefs?: string[];
  behaviors?: UpdatePersonaBehaviorComposition[];
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
      /** Mutable authoring provenance only; flowSnapshot remains executable authority. */
      sourceFlowRef?: string;
      overrideFlowRef?: string;
      /** Authoritative identity captured with a reference-backed execution pin. */
      workspaceId?: string;
      selectedFlowRef?: string;
      flowVersionId?: string;
      /** Authored Core baseline captured when an accepted Primary override activates. */
      authoredFlowProvenance?: {
        flowRef: string;
        contentHash: string;
        updatedAt?: number;
      };
    }
  | {
      kind: 'import';
      sourceRef?: string;
    };

/** Immutable, content-addressed, Persona-owned executable Flow snapshot. */
export interface BehaviorRevision {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION | typeof BEHAVIOR_REVISION_SCHEMA_VERSION;
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
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION | typeof BEHAVIOR_BINDING_SCHEMA_VERSION;
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

export interface ActivateBehaviorRevisionInput {
  revisionId: string;
  /** Compare-and-swap guard so a stale desk cannot overwrite a newer activation. */
  expectedActiveRevisionId: string;
}

/**
 * Optional authorization for one concrete, workspace-owned MCP configuration.
 * The grant is projected only into the Persona's Activity-local Core Flow and
 * never mutates a persisted Core or Behavior Flow.
 */
export interface PersonaAppGrant {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION;
  id: string;
  personaId: string;
  /** Exact MCP configuration identity, for example `github-jim`. */
  mcpServerName: string;
  /** Omitted on legacy/default grants means every currently discovered tool. */
  enabledTools?: string[];
  /** Persona-Core overrides for server-wide fixed tool arguments. */
  toolParameterPresets?: MCPToolParameterPresets;
  createdAt: number;
  updatedAt: number;
}

export interface CreatePersonaAppGrantInput {
  mcpServerName: string;
  enabledTools?: string[];
  toolParameterPresets?: MCPToolParameterPresets;
}

/** Compare-and-swap input for replacing one exact Persona App configuration. */
export interface ReplacePersonaAppGrantInput {
  mcpServerName: string;
  enabledTools?: string[];
  toolParameterPresets?: MCPToolParameterPresets;
  expectedUpdatedAt: number;
}

export interface PersonaAppLaunchInput {
  /** MCP Apps resource selected from the granted config's live discovery. */
  uri: string;
}

/** One-shot, non-secret descriptor consumed by the existing global Apps host. */
export interface PersonaAppLaunchDescriptor {
  personaId: string;
  grantId: string;
  mcpServerName: string;
  uri: string;
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

/** Semantic result of the work, independent from runtime/lease status. */
export const PERSONA_ACTIVITY_OUTCOME_SCHEMA_VERSION = 1 as const;
export const PERSONA_ACTIVITY_OUTCOME_RESOLUTIONS = [
  'succeeded',
  'partial',
  'blocked',
  'failed',
  'unknown',
] as const;
export type PersonaActivityOutcomeResolution =
  (typeof PERSONA_ACTIVITY_OUTCOME_RESOLUTIONS)[number];
export const PERSONA_ACTIVITY_BLOCKER_KINDS = [
  'information',
  'approval',
  'permission',
  'capability',
  'dependency',
  'external',
  'transient',
  'policy',
  'unknown',
] as const;
export type PersonaActivityBlockerKind =
  (typeof PERSONA_ACTIVITY_BLOCKER_KINDS)[number];
export const PERSONA_ACTIVITY_OUTCOME_DECISION_SOURCES = [
  'persona_claim',
  'engine',
  'user',
  'legacy',
] as const;
export type PersonaActivityOutcomeDecisionSource =
  (typeof PERSONA_ACTIVITY_OUTCOME_DECISION_SOURCES)[number];

export interface PersonaActivityOutcome {
  schemaVersion: typeof PERSONA_ACTIVITY_OUTCOME_SCHEMA_VERSION;
  resolution: PersonaActivityOutcomeResolution;
  blockerKind?: PersonaActivityBlockerKind;
  summary?: string;
  nextAction?: string;
  decisionSource: PersonaActivityOutcomeDecisionSource;
  evidenceRefs: MemorySourceRef[];
  decidedAt: number;
}

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
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION | typeof PERSONA_ACTIVITY_SCHEMA_VERSION;
  id: string;
  personaId: string;
  kind: PersonaActivityKind;
  status: PersonaActivityStatus;
  source: PersonaActivitySource;
  behaviorId?: string;
  behaviorRevisionId?: string;
  /** Immutable Activity-owned Core/context snapshot. Optional only for legacy records. */
  coreFlowId?: string;
  coreFlowRevisionId?: string;
  /** Exact Persona App configuration names frozen when this Activity started. */
  coreAppRefs?: string[];
  instructionContext?: PersonaInstructionContext;
  instructionContextDigest?: string;
  instructionContextSchemaVersion?: typeof PERSONA_INSTRUCTION_CONTEXT_SCHEMA_VERSION;
  entryPointPayloadRef?: string;
  leaseId?: string;
  conversationId?: string;
  runId?: string;
  meetingId?: string;
  resourceRefs?: string[];
  /** Product/learning meaning; runtime status remains authoritative for execution. */
  outcome?: PersonaActivityOutcome;
  /** Opaque link to the private dispatch outcome retained for compatibility. */
  outcomeRef?: string;
  error?: string;
  /** Durable cooperative-interruption request; the current holder yields explicitly. */
  interruptionRequestedAt?: number;
  interruptionRequestedByMailboxItemId?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Bulky detail was removed while identity/audit fields were retained (issue #453). */
  compactedAt?: number;
}

export interface CreatePersonaActivityInput {
  id?: string;
  personaId: string;
  kind: PersonaActivityKind;
  source: PersonaActivitySource;
  behaviorId?: string;
  behaviorRevisionId?: string;
}

export const BEHAVIOR_MAINTENANCE_RUN_SCHEMA_VERSION = 1 as const;
export const BEHAVIOR_MAINTENANCE_RUN_STATES = [
  'queued',
  'collecting',
  'diagnosing',
  'drafting',
  'evaluating',
  'awaiting_review',
  'completed',
  'failed',
  'cancelled',
] as const;
export type BehaviorMaintenanceRunState =
  (typeof BEHAVIOR_MAINTENANCE_RUN_STATES)[number];
export const BEHAVIOR_MAINTENANCE_ACTIONS = [
  'no_change',
  'memory_candidate',
  'instruction_behavior_candidate',
  'setup_recommendation',
  'eval_candidate',
  'needs_human_diagnosis',
] as const;
export type BehaviorMaintenanceAction =
  (typeof BEHAVIOR_MAINTENANCE_ACTIONS)[number];

/** Private-content-free durable lifecycle record for post-Activity diagnosis. */
export interface BehaviorMaintenanceRun {
  schemaVersion: typeof BEHAVIOR_MAINTENANCE_RUN_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  personaId: string;
  sourceActivityIds: string[];
  sourceWindowDigest: string;
  behaviorSlotKey: string;
  baseRevisionId: string;
  baseContentHash: string;
  detectorVersion: string;
  policyVersion: string;
  evaluationSuiteVersion: string;
  state: BehaviorMaintenanceRunState;
  /** Short-lived ownership fence for crash-safe asynchronous diagnosis. */
  diagnosisLeaseId?: string;
  diagnosisLeaseExpiresAt?: number;
  reasonCode?: string;
  action?: BehaviorMaintenanceAction;
  evidenceTrust: {
    trustedCount: number;
    untrustedCount: number;
    missingCount: number;
    externallyTainted: boolean;
  };
  relatedProposalIds: string[];
  attempts: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  /** Detail was removed while hashes/counters/audit state were retained. */
  compactedAt?: number;
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

/** Explicit user request to admit one saved Task to the Persona runtime. */
export interface AssignPersonaWorkItemInput {
  expectedUpdatedAt: number;
  /** Caller retry token validated at the API boundary; durable identity is Task-scoped. */
  idempotencyKey: string;
}

export type PersonaWorkItemAdmission = 'queued' | 'already_queued';

export interface AssignPersonaWorkItemResult {
  workItem: PersonaWorkItem;
  admission: PersonaWorkItemAdmission;
}

export const PERSONA_TASK_DISPLAY_STATES = [
  'ready',
  'blocked',
  'waiting',
  'overdue',
  'in_progress',
  'completed',
  'cancelled',
] as const;
export type PersonaTaskDisplayState = (typeof PERSONA_TASK_DISPLAY_STATES)[number];

export type PersonaPresentationOrigin =
  | 'user_chat'
  | 'assignment'
  | 'automation'
  | 'trigger'
  | 'meeting'
  | 'voice'
  | 'api'
  | 'maintenance'
  | 'unknown';

export type PersonaPresentationOutcome =
  | 'queued'
  | 'working'
  | 'waiting'
  | 'completed'
  | 'cancelled'
  | 'needs_attention';

export interface PersonaPresentationRecordLink {
  kind: 'conversation' | 'meeting';
  id: string;
}

export interface PersonaConversationSummary {
  conversationId: string;
  origin: PersonaPresentationOrigin;
  outcome: PersonaPresentationOutcome;
  occurredAt: number;
  active: boolean;
  queuedInputCount: number;
}

export interface PersonaTaskSummary {
  id: string;
  title: string;
  description?: string;
  state: PersonaTaskDisplayState;
  priority: PersonaPriority;
  nextAction?: string;
  deadline?: number;
  blockerTitles: string[];
  completedAt?: number;
  /** Bounded, user-facing result from the Task's latest Activity. */
  resultSummary?: string;
  recordLinks?: PersonaPresentationRecordLink[];
  expectedUpdatedAt: number;
}

export interface PersonaHistoryEntry {
  /** Opaque presentation key; never a raw Activity/runtime identifier. */
  key: string;
  kind: PersonaActivityKind;
  origin: PersonaPresentationOrigin;
  outcome: PersonaPresentationOutcome;
  occurredAt: number;
  summary: string;
  /** Bounded, user-facing result; raw execution envelopes remain private. */
  resultSummary?: string;
  recordLinks: PersonaPresentationRecordLink[];
  /** Safe diagnostics only. Control-plane ids, tokens, payloads, and errors are excluded. */
  advanced: {
    activityKind: PersonaActivityKind;
    sourceKind: PersonaActivitySourceKind;
    status: PersonaActivityStatus;
  };
}

export interface PersonaPresentationSummary {
  conversations: PersonaConversationSummary[];
  tasks: PersonaTaskSummary[];
  history: PersonaHistoryEntry[];
  current: PersonaHistoryEntry | null;
  queuedInputCount: number;
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
  /** Timestamp when a human reviewed/activated this item via UI/API. */
  reviewedAt?: number;
  /** Timestamp of the most recent recall (lexical search result). Throttled to 1/hour to avoid write amplification. */
  lastRecalledAt?: number;
  /** Count of independent corroborating observations from distinct sources. Used for auto-promotion gating. */
  corroborationCount?: number;
  /** Timestamp of the most recent corroboration event. */
  lastCorroboratedAt?: number;
  /** Computed expiry timestamp for candidate items only. Set at creation, never modified. */
  expiresAt?: number;
  /** Lifecycle reason for status transitions (e.g., 'expired', 'auto_promoted'). */
  lifecycleReason?: 'expired' | 'auto_promoted';
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
  /** Bulky detail was removed while identity/audit fields were retained (issue #453). */
  compactedAt?: number;
  /** SHA-256 digest preserving idempotency semantics after compaction blanked detail. */
  admissionDigest?: string;
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
  /** Archived lease compacted by the retention sweep (issue #453). */
  compactedAt?: number;
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
  behaviorProposals: number;
  behaviorMaintenanceRuns: number;
  behaviorOutcomeMetrics: number;
  appGrants: number;
  memoryItems: number;
  memoryEmbeddings: number;
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
