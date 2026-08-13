import { z } from 'zod';

import type { Flow } from '@/shared/types/flow';
import {
  BEHAVIOR_BINDING_SCHEMA_VERSION,
  BEHAVIOR_REVISION_SCHEMA_VERSION,
  ENDURING_AGENT_SCHEMA_VERSION,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MEMORY_TRUST_LEVELS,
  PERSONA_ACTIVITY_KINDS,
  PERSONA_SCHEMA_VERSION,
  PERSONA_ACTIVITY_SOURCE_KINDS,
  PERSONA_ACTIVITY_STATUSES,
  PERSONA_AUTONOMY_LEVELS,
  PERSONA_DELETION_ARCHIVE_POLICIES,
  PERSONA_DELETION_STATUSES,
  PERSONA_INTERRUPTION_POLICIES,
  PERSONA_INSTRUCTION_CONTEXT_SCHEMA_VERSION,
  PERSONA_LEASE_STATUSES,
  PERSONA_LIFECYCLE_STATES,
  PERSONA_MAILBOX_DELIVERY_STATUSES,
  PERSONA_MAILBOX_RELATED_ACTIONS,
  PERSONA_MAILBOX_ROUTING_DECISIONS,
  PERSONA_MAILBOX_STATUSES,
  PERSONA_PRIORITIES,
  PERSONA_WORK_ITEM_STATUSES,
  ROLE_DEFINITION_SCHEMA_VERSION,
  ROLE_VERSION_SCHEMA_VERSION,
} from './enduringAgent';

export const ENDURING_AGENT_SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const ENDURING_AGENT_SLOT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const EnduringAgentIdSchema = z.string().regex(ENDURING_AGENT_SAFE_ID_PATTERN);
export const BehaviorSlotKeySchema = z.string().regex(ENDURING_AGENT_SLOT_KEY_PATTERN);
const TimestampSchema = z.number().int().nonnegative();
const NonEmptyText = (max: number) => z.string().trim().min(1).max(max);
const UniqueIdsSchema = z.array(EnduringAgentIdSchema).max(256)
  .refine((ids) => new Set(ids).size === ids.length, 'IDs must be unique.');
const UniqueImpactIdsSchema = z.array(EnduringAgentIdSchema).max(10_000)
  .refine((ids) => new Set(ids).size === ids.length, 'IDs must be unique.');
const RoleDefinitionRecordVersionSchema = z.union([
  z.literal(ENDURING_AGENT_SCHEMA_VERSION),
  z.literal(ROLE_DEFINITION_SCHEMA_VERSION),
]);
const RoleVersionRecordVersionSchema = z.union([
  z.literal(ENDURING_AGENT_SCHEMA_VERSION),
  z.literal(ROLE_VERSION_SCHEMA_VERSION),
]);
const PersonaRecordVersionSchema = z.union([
  z.literal(ENDURING_AGENT_SCHEMA_VERSION),
  z.literal(PERSONA_SCHEMA_VERSION),
]);
const BehaviorRevisionRecordVersionSchema = z.union([
  z.literal(ENDURING_AGENT_SCHEMA_VERSION),
  z.literal(BEHAVIOR_REVISION_SCHEMA_VERSION),
]);
const BehaviorBindingRecordVersionSchema = z.union([
  z.literal(ENDURING_AGENT_SCHEMA_VERSION),
  z.literal(BEHAVIOR_BINDING_SCHEMA_VERSION),
]);

const FlowNodeSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.string().min(1).max(64),
  position: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  }).passthrough(),
  data: z.object({
    label: z.string().max(500),
    type: z.string().min(1).max(64),
    description: z.string().max(10_000).optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
}).passthrough();

export const PermissionRuleSchema = z.object({
  effect: z.enum(['allow', 'deny']),
  action: NonEmptyText(256),
  resource: z.string().trim().min(1).max(2_048).optional(),
}).strict();

const FlowEdgeSchema = z.object({
  id: z.string().min(1).max(512),
  source: z.string().min(1).max(256),
  target: z.string().min(1).max(256),
}).passthrough();

/** Structural Flow validation while preserving every authored extension field. */
export const FlowSnapshotSchema = z.object({
  id: z.string().min(1).max(256),
  name: NonEmptyText(500),
  description: z.string().max(100_000).optional(),
  folder: z.string().max(500).optional(),
  favorite: z.boolean().optional(),
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema.optional(),
  permissionRules: z.array(PermissionRuleSchema).max(10_000).optional(),
  nodes: z.array(FlowNodeSchema).max(10_000),
  edges: z.array(FlowEdgeSchema).max(50_000),
  input: z.string().max(64).optional(),
}).passthrough() as unknown as z.ZodType<Flow>;

export const PersonaAttributionSchema = z.object({
  personaId: EnduringAgentIdSchema,
  activityId: EnduringAgentIdSchema.optional(),
  behaviorRevisionId: EnduringAgentIdSchema.optional(),
}).strict();

export const PersonaInstructionContextSchema = z.object({
  schemaVersion: z.literal(PERSONA_INSTRUCTION_CONTEXT_SCHEMA_VERSION),
  personaId: EnduringAgentIdSchema,
  activityId: EnduringAgentIdSchema,
  behaviorRevisionId: EnduringAgentIdSchema,
  behaviorContentHash: z.string().regex(SHA256_PATTERN),
  behaviorSlotKey: BehaviorSlotKeySchema,
  rootFlowId: z.string().min(1).max(256),
  roleVersionId: EnduringAgentIdSchema,
  personaName: NonEmptyText(160),
  personaMission: z.string().trim().min(1).max(20_000).optional(),
  roleName: NonEmptyText(160),
  roleMission: NonEmptyText(20_000),
  coreMemoryItemIds: UniqueIdsSchema.optional(),
  coreMemoryDigest: z.string().regex(SHA256_PATTERN).optional(),
  instruction: z.string().min(1).max(64_000),
}).strict();

export const PersonaPresentationSchema = z.object({
  avatarUrl: z.string().trim().max(2048).optional(),
  voice: z.string().trim().max(128).optional(),
  language: z.string().trim().max(64).optional(),
}).strict();

export const WorkspaceFlowRefSchema = z.string().trim().min(1).max(256);
export const PersonaAppRefSchema = z.string().min(1).max(200).refine(
  (name) => name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\\') && !/[\x00-\x1f]/.test(name),
  { message: 'Invalid MCP server configuration name.' },
);

export const PersonaRoleCompositionSchema = z.object({
  ref: EnduringAgentIdSchema,
  name: NonEmptyText(160),
  prompt: NonEmptyText(20_000),
  suggestedAppRefs: z.array(PersonaAppRefSchema).max(128)
    .refine((refs) => new Set(refs).size === refs.length, 'App references must be unique.'),
}).strict();

export const PersonaFlowBindingSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('shared'),
    sharedFlowRef: WorkspaceFlowRefSchema,
  }).strict(),
  z.object({
    mode: z.literal('persona_copy'),
    sharedFlowRef: WorkspaceFlowRefSchema.optional(),
    personaFlowRef: WorkspaceFlowRefSchema,
  }).strict(),
]);

export const PersonaBehaviorCompositionSchema = z.object({
  ref: EnduringAgentIdSchema,
  slotKey: BehaviorSlotKeySchema.optional(),
  name: NonEmptyText(160),
  description: z.string().trim().max(10_000).optional(),
  order: z.number().int().min(0).max(63).optional(),
  binding: PersonaFlowBindingSchema.optional(),
  sourceFlowRef: WorkspaceFlowRefSchema.optional(),
  overrideFlowRef: WorkspaceFlowRefSchema.optional(),
}).strict();

export const PersonaFlowReadinessSchema = z.object({
  state: z.enum(['ready', 'invalid', 'missing']),
  issues: z.array(z.string().max(2_000)).max(32),
}).strict();

export const PersonaFlowCardSchema = z.object({
  binding: PersonaFlowBindingSchema,
  effectiveFlowRef: WorkspaceFlowRefSchema,
  flow: z.any().optional(),
  readiness: PersonaFlowReadinessSchema,
}).strict();

export const PersonaBehaviorFlowCardSchema = PersonaFlowCardSchema.extend({
  ref: EnduringAgentIdSchema,
  slotKey: BehaviorSlotKeySchema,
  name: NonEmptyText(160),
  description: z.string().trim().max(10_000).optional(),
  order: z.number().int().min(0).max(63),
}).strict();

export const PersonaCompositionPreferencesSchema = z.object({
  description: z.string().trim().max(10_000).optional(),
  role: PersonaRoleCompositionSchema.optional(),
  coreFlowRef: WorkspaceFlowRefSchema.optional(),
  coreBinding: PersonaFlowBindingSchema.optional(),
  appRefs: z.array(PersonaAppRefSchema).max(128)
    .refine((refs) => new Set(refs).size === refs.length, 'App references must be unique.')
    .optional(),
  memoryRefs: UniqueIdsSchema.optional(),
  behaviors: z.array(PersonaBehaviorCompositionSchema).max(64)
    .refine((items) => new Set(items.map((item) => item.ref)).size === items.length,
      'Behavior references must be unique.')
    .refine((items) => {
      const orders = items.flatMap((item) => item.order === undefined ? [] : [item.order]);
      return new Set(orders).size === orders.length;
    }, 'Behavior order values must be unique.')
    .optional(),
}).strict();

export const RoleDefinitionSchema = z.object({
  schemaVersion: RoleDefinitionRecordVersionSchema,
  id: EnduringAgentIdSchema,
  name: NonEmptyText(160),
  description: z.string().trim().max(10_000).optional(),
  currentVersionId: EnduringAgentIdSchema.optional(),
  archivedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().refine(
  (record) => record.updatedAt >= record.createdAt,
  { message: 'updatedAt cannot precede createdAt.', path: ['updatedAt'] },
);

export const CreateRoleDefinitionInputSchema = z.object({
  id: EnduringAgentIdSchema.optional(),
  name: NonEmptyText(160),
  description: z.string().trim().max(10_000).optional(),
}).strict();

export const RoleSuggestedAppReferenceSchema = z.object({
  mcpServerName: z.string().min(1).max(200).refine(
    (name) => name === name.trim() && name !== '.' && name !== '..' && !/[/\\\x00-\x1f]/.test(name),
    { message: 'Invalid MCP server configuration name.' },
  ),
}).strict();

const RoleSuggestedAppsSchema = z.array(RoleSuggestedAppReferenceSchema).max(64).refine(
  (apps) => new Set(apps.map((app) => app.mcpServerName)).size === apps.length,
  'Suggested App references must be unique.',
);

export const CreatePublicRoleInputSchema = z.object({
  id: EnduringAgentIdSchema.optional(),
  name: NonEmptyText(160),
  prompt: NonEmptyText(20_000),
  suggestedApps: RoleSuggestedAppsSchema.optional(),
}).strict();

export const UpdatePublicRoleInputSchema = z.object({
  expectedCurrentVersionId: EnduringAgentIdSchema,
  name: NonEmptyText(160).optional(),
  prompt: NonEmptyText(20_000).optional(),
  suggestedApps: RoleSuggestedAppsSchema.optional(),
}).strict().refine(
  (input) => input.name !== undefined || input.prompt !== undefined || input.suggestedApps !== undefined,
  { message: 'At least one editable Role field is required.' },
);

export const DuplicatePublicRoleInputSchema = z.object({
  name: NonEmptyText(160).optional(),
}).strict();

export const RollbackPublicRoleInputSchema = z.object({
  expectedCurrentVersionId: EnduringAgentIdSchema,
  sourceVersionId: EnduringAgentIdSchema,
}).strict();

export const RestorePublicRoleInputSchema = z.object({
  expectedCurrentVersionId: EnduringAgentIdSchema,
}).strict();

export const RoleLifecycleInputSchema = z.object({
  expectedCurrentVersionId: EnduringAgentIdSchema,
  action: z.enum(['archive', 'delete']).optional().default('archive'),
}).strict();

export const PublicRoleSuggestedAppSchema = RoleSuggestedAppReferenceSchema.extend({
  status: z.enum(['available', 'disabled', 'apps_disabled', 'missing']),
}).strict();

export const PublicRoleSchema = z.object({
  id: EnduringAgentIdSchema,
  name: NonEmptyText(160),
  prompt: NonEmptyText(20_000),
  suggestedApps: z.array(PublicRoleSuggestedAppSchema).max(64),
  archived: z.boolean(),
  archivedAt: TimestampSchema.optional(),
  currentVersionId: EnduringAgentIdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const PublicRoleVersionSchema = z.object({
  id: EnduringAgentIdSchema,
  roleId: EnduringAgentIdSchema,
  version: z.number().int().positive().max(1_000_000),
  name: NonEmptyText(160),
  prompt: NonEmptyText(20_000),
  suggestedApps: z.array(PublicRoleSuggestedAppSchema).max(64),
  createdAt: TimestampSchema,
  current: z.boolean(),
}).strict();

export const RoleImpactPreviewSchema = z.object({
  roleId: EnduringAgentIdSchema,
  personaIds: UniqueImpactIdsSchema,
  personaCount: z.number().int().nonnegative().max(10_000),
  pinnedRoleVersionIds: UniqueImpactIdsSchema,
  hardDeleteAllowed: z.boolean(),
  safeAction: z.literal('archive'),
}).strict();

export const RoleBehaviorSlotSchema = z.object({
  key: BehaviorSlotKeySchema,
  name: NonEmptyText(160),
  description: z.string().trim().max(10_000).optional(),
  requiredCapabilities: z.array(z.string().regex(CAPABILITY_PATTERN)).max(128).optional(),
  flowTemplate: FlowSnapshotSchema,
}).strict();

export const RoleCapabilityRequirementsSchema = z.object({
  semantic: z.array(z.string().regex(CAPABILITY_PATTERN)).max(128),
  preferredMcpServers: z.array(NonEmptyText(160)).max(128).optional(),
}).strict();

export const RoleDefaultsSchema = z.object({
  autonomyLevel: z.enum(PERSONA_AUTONOMY_LEVELS),
  interruptionPolicy: z.enum(PERSONA_INTERRUPTION_POLICIES),
  memory: z.object({
    candidateLimitPerActivity: z.number().int().min(0).max(100),
    coreMemoryMaxItems: z.number().int().min(0).max(1_000),
  }).strict().optional(),
  presentation: PersonaPresentationSchema.optional(),
}).strict();

export const RoleVersionSchema = z.object({
  schemaVersion: RoleVersionRecordVersionSchema,
  id: EnduringAgentIdSchema,
  roleDefinitionId: EnduringAgentIdSchema,
  version: z.number().int().positive().max(1_000_000),
  name: NonEmptyText(160),
  mission: NonEmptyText(20_000),
  suggestedApps: RoleSuggestedAppsSchema.optional(),
  behaviorSlots: z.array(RoleBehaviorSlotSchema).min(1).max(64),
  capabilityRequirements: RoleCapabilityRequirementsSchema.optional(),
  defaults: RoleDefaultsSchema.optional(),
  migrationNotes: z.string().trim().max(20_000).optional(),
  createdAt: TimestampSchema,
}).strict().refine(
  (record) => new Set(record.behaviorSlots.map((slot) => slot.key)).size === record.behaviorSlots.length,
  { message: 'Behavior slot keys must be unique.', path: ['behaviorSlots'] },
);

export const CreateRoleVersionInputSchema = z.object({
  id: EnduringAgentIdSchema.optional(),
  roleDefinitionId: EnduringAgentIdSchema,
  version: z.number().int().positive().max(1_000_000),
  name: NonEmptyText(160),
  mission: NonEmptyText(20_000),
  suggestedApps: RoleSuggestedAppsSchema.optional(),
  behaviorSlots: z.array(RoleBehaviorSlotSchema).min(1).max(64),
  capabilityRequirements: RoleCapabilityRequirementsSchema.optional(),
  defaults: RoleDefaultsSchema.optional(),
  migrationNotes: z.string().trim().max(20_000).optional(),
}).strict();

export const PersonaSchema = z.object({
  schemaVersion: PersonaRecordVersionSchema,
  id: EnduringAgentIdSchema,
  name: NonEmptyText(160),
  roleVersionId: EnduringAgentIdSchema,
  lifecycleState: z.enum(PERSONA_LIFECYCLE_STATES),
  mission: z.string().trim().max(20_000).optional(),
  presentation: PersonaPresentationSchema.optional(),
  autonomyLevel: z.enum(PERSONA_AUTONOMY_LEVELS),
  interruptionPolicy: z.enum(PERSONA_INTERRUPTION_POLICIES),
  coreMemoryItemIds: UniqueIdsSchema.optional(),
  composition: PersonaCompositionPreferencesSchema.optional(),
  factoryKeyHash: z.string().regex(SHA256_PATTERN).optional(),
  provisioningState: z.enum(['pending', 'ready']).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().refine(
  (record) => record.updatedAt >= record.createdAt,
  { message: 'updatedAt cannot precede createdAt.', path: ['updatedAt'] },
);

export const MemorySourceRefSchema = z.object({
  kind: z.enum(MEMORY_SOURCE_KINDS),
  id: NonEmptyText(512),
  messageId: z.string().min(1).max(512).optional(),
  uri: z.string().max(4096).optional(),
  observedAt: TimestampSchema.optional(),
  workspaceId: z.string().min(1).max(256).optional(),
  producer: z.string().min(1).max(512).optional(),
  contentDigest: z.string().regex(SHA256_PATTERN).optional(),
}).strict();

export const InitialPersonaMemoryInputSchema = z.object({
  content: NonEmptyText(100_000),
  kind: z.enum(['semantic', 'episodic']).optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
  confidence: z.number().min(0).max(1).optional(),
  importance: z.number().min(0).max(1).optional(),
  sourceRefs: z.array(MemorySourceRefSchema).min(1).max(100).optional(),
}).strict();

export const CreatePersonaInputSchema = z.object({
  id: EnduringAgentIdSchema.optional(),
  name: NonEmptyText(160),
  coreFlowRef: WorkspaceFlowRefSchema,
  roleVersionId: EnduringAgentIdSchema.optional(),
  appRefs: z.array(PersonaAppRefSchema).max(128)
    .refine((refs) => new Set(refs).size === refs.length, 'App references must be unique.')
    .optional(),
  mission: z.string().trim().max(20_000).optional(),
  presentation: PersonaPresentationSchema.optional(),
  autonomyLevel: z.enum(PERSONA_AUTONOMY_LEVELS).optional(),
  interruptionPolicy: z.enum(PERSONA_INTERRUPTION_POLICIES).optional(),
  idempotencyKey: z.string().min(1).max(512).optional(),
  initialMemories: z.array(InitialPersonaMemoryInputSchema).max(100).optional(),
}).strict();

export const UpdatePersonaInputSchema = z.object({
  name: NonEmptyText(160).optional(),
  mission: z.string().trim().max(20_000).nullable().optional(),
  presentation: z.object({
    avatarUrl: z.string().trim().max(2048).nullable().optional(),
    voice: z.string().trim().max(128).nullable().optional(),
    language: z.string().trim().max(64).nullable().optional(),
  }).strict().optional(),
  autonomyLevel: z.enum(PERSONA_AUTONOMY_LEVELS).optional(),
  interruptionPolicy: z.enum(PERSONA_INTERRUPTION_POLICIES).optional(),
  lifecycleState: z.enum(['idle', 'sleeping', 'disabled']).optional(),
  expectedUpdatedAt: TimestampSchema.optional(),
}).strict();

export const PersonaCompositionMemorySchema = z.object({
  ref: EnduringAgentIdSchema,
  kind: z.enum(MEMORY_KINDS),
  content: NonEmptyText(100_000),
}).strict();

export const PersonaCompositionSchema = z.object({
  personaRef: EnduringAgentIdSchema,
  name: NonEmptyText(160),
  description: z.string().trim().max(10_000),
  role: PersonaRoleCompositionSchema,
  coreFlowRef: WorkspaceFlowRefSchema.optional(),
  core: PersonaFlowCardSchema.optional(),
  appRefs: z.array(PersonaAppRefSchema).max(128),
  memories: z.array(PersonaCompositionMemorySchema).max(256),
  behaviors: z.array(PersonaBehaviorCompositionSchema).max(64),
  behaviorCards: z.array(PersonaBehaviorFlowCardSchema).max(64),
  expectedUpdatedAt: TimestampSchema,
}).strict();

export const UpdatePersonaBehaviorCompositionSchema = z.object({
  ref: EnduringAgentIdSchema,
  slotKey: BehaviorSlotKeySchema.optional(),
  name: NonEmptyText(160),
  description: z.string().trim().max(10_000).optional(),
  order: z.number().int().min(0).max(63).optional(),
  binding: PersonaFlowBindingSchema.optional(),
  sourceFlowRef: WorkspaceFlowRefSchema.optional(),
  overrideFlowRef: WorkspaceFlowRefSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (!value.binding && !value.sourceFlowRef) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A Flow binding is required.' });
  }
});

export const CopyPersonaFlowInputSchema = z.object({
  expectedUpdatedAt: TimestampSchema,
  target: z.enum(['core', 'behavior']),
  behaviorRef: EnduringAgentIdSchema.optional(),
  sourceFlowRef: WorkspaceFlowRefSchema,
}).strict().superRefine((value, context) => {
  if (value.target === 'behavior' && !value.behaviorRef) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'behaviorRef is required.' });
  }
  if (value.target === 'core' && value.behaviorRef) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'behaviorRef is only valid for Behaviors.' });
  }
});

export const UpdatePersonaCompositionInputSchema = z.object({
  expectedUpdatedAt: TimestampSchema,
  name: NonEmptyText(160).optional(),
  description: z.string().trim().max(10_000).nullable().optional(),
  role: PersonaRoleCompositionSchema.optional(),
  coreFlowRef: WorkspaceFlowRefSchema.nullable().optional(),
  appRefs: z.array(PersonaAppRefSchema).max(128)
    .refine((refs) => new Set(refs).size === refs.length, 'App references must be unique.')
    .optional(),
  memoryRefs: UniqueIdsSchema.optional(),
  behaviors: z.array(UpdatePersonaBehaviorCompositionSchema).max(64)
    .refine((items) => new Set(items.map((item) => item.ref)).size === items.length,
      'Behavior references must be unique.')
    .refine((items) => {
      const orders = items.flatMap((item) => item.order === undefined ? [] : [item.order]);
      return new Set(orders).size === orders.length;
    }, 'Behavior order values must be unique.')
    .optional(),
}).strict();

export const BehaviorRevisionSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('role_template'),
    roleVersionId: EnduringAgentIdSchema,
    slotKey: BehaviorSlotKeySchema,
    templateFlowId: z.string().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal('persona_override'),
    parentRevisionId: EnduringAgentIdSchema.optional(),
    evidenceRefs: z.array(NonEmptyText(2048)).max(100).optional(),
    sourceFlowRef: WorkspaceFlowRefSchema.optional(),
    overrideFlowRef: WorkspaceFlowRefSchema.optional(),
    workspaceId: NonEmptyText(256).optional(),
    selectedFlowRef: WorkspaceFlowRefSchema.optional(),
    flowVersionId: NonEmptyText(128).optional(),
  }).strict(),
  z.object({
    kind: z.literal('import'),
    sourceRef: z.string().trim().max(4096).optional(),
  }).strict(),
]);

export const BehaviorRevisionSchema = z.object({
  schemaVersion: BehaviorRevisionRecordVersionSchema,
  id: EnduringAgentIdSchema,
  behaviorId: EnduringAgentIdSchema,
  personaId: EnduringAgentIdSchema,
  slotKey: BehaviorSlotKeySchema,
  revision: z.number().int().positive().max(1_000_000),
  contentHash: z.string().regex(SHA256_PATTERN),
  flowSnapshot: FlowSnapshotSchema,
  source: BehaviorRevisionSourceSchema,
  createdAt: TimestampSchema,
}).strict();

export const CreateBehaviorRevisionInputSchema = BehaviorRevisionSchema.omit({
  schemaVersion: true,
  contentHash: true,
  createdAt: true,
}).extend({
  id: EnduringAgentIdSchema.optional(),
}).strict();

export const BehaviorBindingSchema = z.object({
  schemaVersion: BehaviorBindingRecordVersionSchema,
  id: EnduringAgentIdSchema,
  personaId: EnduringAgentIdSchema,
  slotKey: BehaviorSlotKeySchema,
  activeRevisionId: EnduringAgentIdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().refine(
  (record) => record.updatedAt >= record.createdAt,
  { message: 'updatedAt cannot precede createdAt.', path: ['updatedAt'] },
);

export const CreateBehaviorBindingInputSchema = z.object({
  id: EnduringAgentIdSchema.optional(),
  personaId: EnduringAgentIdSchema,
  slotKey: BehaviorSlotKeySchema,
  activeRevisionId: EnduringAgentIdSchema,
}).strict();

export const ActivateBehaviorRevisionInputSchema = z.object({
  revisionId: EnduringAgentIdSchema,
  expectedActiveRevisionId: EnduringAgentIdSchema,
}).strict();

/** Mirrors the MCP config route's path-safe name contract without narrowing legacy names. */
export const McpServerConfigNameSchema = z.string().min(1).max(200).refine(
  (name) => name !== '.' && name !== '..' && !/[/\\\x00-\x1f]/.test(name),
  { message: 'Invalid MCP server configuration name.' },
);

export const PersonaAppGrantSchema = z.object({
  schemaVersion: z.literal(ENDURING_AGENT_SCHEMA_VERSION),
  id: EnduringAgentIdSchema,
  personaId: EnduringAgentIdSchema,
  mcpServerName: McpServerConfigNameSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().refine(
  (record) => record.updatedAt >= record.createdAt,
  { message: 'updatedAt cannot precede createdAt.', path: ['updatedAt'] },
);

export const CreatePersonaAppGrantInputSchema = z.object({
  mcpServerName: McpServerConfigNameSchema,
}).strict();

export const ReplacePersonaAppGrantInputSchema = z.object({
  mcpServerName: McpServerConfigNameSchema,
  expectedUpdatedAt: TimestampSchema,
}).strict();

export const PersonaAppLaunchInputSchema = z.object({
  uri: z.string().min(1).max(4096).regex(/^ui:\/\//i),
}).strict();

export const PersonaActivitySourceSchema = z.object({
  kind: z.enum(PERSONA_ACTIVITY_SOURCE_KINDS),
  sourceId: z.string().min(1).max(512).optional(),
  idempotencyKey: z.string().min(1).max(512).optional(),
}).strict();

export const PersonaActivitySchema = z.object({
  schemaVersion: z.literal(ENDURING_AGENT_SCHEMA_VERSION),
  id: EnduringAgentIdSchema,
  personaId: EnduringAgentIdSchema,
  kind: z.enum(PERSONA_ACTIVITY_KINDS),
  status: z.enum(PERSONA_ACTIVITY_STATUSES),
  source: PersonaActivitySourceSchema,
  behaviorId: EnduringAgentIdSchema.optional(),
  behaviorRevisionId: EnduringAgentIdSchema.optional(),
  coreFlowId: z.string().min(1).max(256).optional(),
  coreFlowRevisionId: EnduringAgentIdSchema.optional(),
  coreAppRefs: z.array(McpServerConfigNameSchema).max(64).optional(),
  instructionContext: PersonaInstructionContextSchema.optional(),
  instructionContextDigest: z.string().regex(SHA256_PATTERN).optional(),
  instructionContextSchemaVersion: z.literal(PERSONA_INSTRUCTION_CONTEXT_SCHEMA_VERSION).optional(),
  entryPointPayloadRef: z.string().min(1).max(4096).optional(),
  leaseId: EnduringAgentIdSchema.optional(),
  conversationId: EnduringAgentIdSchema.optional(),
  runId: EnduringAgentIdSchema.optional(),
  meetingId: EnduringAgentIdSchema.optional(),
  resourceRefs: z.array(NonEmptyText(4096)).max(1_000).optional(),
  outcomeRef: z.string().max(4096).optional(),
  error: z.string().max(20_000).optional(),
  interruptionRequestedAt: TimestampSchema.optional(),
  interruptionRequestedByMailboxItemId: EnduringAgentIdSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  startedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
}).strict().superRefine((record, ctx) => {
  const terminal = record.status === 'completed'
    || record.status === 'cancelled'
    || record.status === 'error';
  const snapshotFields = [
    record.coreFlowId,
    record.coreFlowRevisionId,
    record.instructionContext,
    record.instructionContextDigest,
    record.instructionContextSchemaVersion,
  ];
  const hasSnapshot = snapshotFields.some((value) => value !== undefined);
  if (hasSnapshot && snapshotFields.some((value) => value === undefined)) {
    ctx.addIssue({
      code: 'custom',
      message: 'An Activity Core snapshot must be persisted as one complete immutable bundle.',
      path: ['instructionContext'],
    });
  }
  if (record.instructionContext) {
    if (record.instructionContext.personaId !== record.personaId) {
      ctx.addIssue({
        code: 'custom',
        message: 'Activity context must identify the owning Persona.',
        path: ['instructionContext', 'personaId'],
      });
    }
    if (record.instructionContext.activityId !== record.id) {
      ctx.addIssue({
        code: 'custom',
        message: 'Activity context must identify the owning Activity.',
        path: ['instructionContext', 'activityId'],
      });
    }
    if (record.instructionContext.behaviorRevisionId !== record.behaviorRevisionId) {
      ctx.addIssue({
        code: 'custom',
        message: 'Activity context must match the pinned Behavior revision.',
        path: ['instructionContext', 'behaviorRevisionId'],
      });
    }
    if (record.instructionContext.rootFlowId !== record.coreFlowId) {
      ctx.addIssue({
        code: 'custom',
        message: 'Activity Core Flow must match the frozen context root Flow.',
        path: ['coreFlowId'],
      });
    }
    if (record.coreFlowRevisionId !== record.behaviorRevisionId) {
      ctx.addIssue({
        code: 'custom',
        message: 'Activity Core revision must match the immutable Behavior revision pin.',
        path: ['coreFlowRevisionId'],
      });
    }
    if (record.instructionContextSchemaVersion !== record.instructionContext.schemaVersion) {
      ctx.addIssue({
        code: 'custom',
        message: 'Activity context schema version must match the frozen context.',
        path: ['instructionContextSchemaVersion'],
      });
    }
  }

  if (record.updatedAt < record.createdAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'updatedAt cannot precede createdAt.',
      path: ['updatedAt'],
    });
  }
  if (record.startedAt !== undefined && record.startedAt < record.createdAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'startedAt cannot precede createdAt.',
      path: ['startedAt'],
    });
  }
  if (record.startedAt !== undefined && record.startedAt > record.updatedAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'startedAt cannot follow updatedAt.',
      path: ['startedAt'],
    });
  }
  if (
    record.completedAt !== undefined
    && record.completedAt < (record.startedAt ?? record.createdAt)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'completedAt cannot precede the Activity start.',
      path: ['completedAt'],
    });
  }
  if (record.completedAt !== undefined && record.completedAt > record.updatedAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'completedAt cannot follow updatedAt.',
      path: ['completedAt'],
    });
  }
  if (record.status === 'queued' && record.startedAt !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'A queued Activity cannot have startedAt.',
      path: ['startedAt'],
    });
  }
  if ((record.status === 'running' || record.status === 'waiting') && record.startedAt === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `${record.status} Activities require startedAt.`,
      path: ['startedAt'],
    });
  }
  if ((record.status === 'running' || record.status === 'waiting') && record.leaseId === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `${record.status} Activities require leaseId.`,
      path: ['leaseId'],
    });
  }
  if (record.status === 'queued' && record.leaseId !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'A queued Activity cannot have leaseId.',
      path: ['leaseId'],
    });
  }
  if (terminal && record.completedAt === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `${record.status} Activities require completedAt.`,
      path: ['completedAt'],
    });
  }
  if (!terminal && record.completedAt !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'A non-terminal Activity cannot have completedAt.',
      path: ['completedAt'],
    });
  }
  if (record.status === 'completed' && record.startedAt === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'A completed Activity requires startedAt.',
      path: ['startedAt'],
    });
  }
  if (record.status === 'error' && !record.error?.trim()) {
    ctx.addIssue({
      code: 'custom',
      message: 'An errored Activity requires an error message.',
      path: ['error'],
    });
  }
  if (
    (record.interruptionRequestedAt === undefined)
    !== (record.interruptionRequestedByMailboxItemId === undefined)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'An Activity interruption request requires both timestamp and mailbox item id.',
      path: ['interruptionRequestedAt'],
    });
  }
  if (
    record.interruptionRequestedAt !== undefined
    && record.interruptionRequestedAt < (record.startedAt ?? record.createdAt)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'interruptionRequestedAt cannot precede the Activity start.',
      path: ['interruptionRequestedAt'],
    });
  }
  if (
    record.interruptionRequestedAt !== undefined
    && record.interruptionRequestedAt > record.updatedAt
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'interruptionRequestedAt cannot follow updatedAt.',
      path: ['interruptionRequestedAt'],
    });
  }
});

export const CreatePersonaActivityInputSchema = z.object({
  id: EnduringAgentIdSchema.optional(),
  personaId: EnduringAgentIdSchema,
  kind: z.enum(PERSONA_ACTIVITY_KINDS),
  source: PersonaActivitySourceSchema,
  behaviorId: EnduringAgentIdSchema.optional(),
  behaviorRevisionId: EnduringAgentIdSchema.optional(),
}).strict();

export const PersonaWorkItemSchema = z.object({
  schemaVersion: z.literal(ENDURING_AGENT_SCHEMA_VERSION),
  id: EnduringAgentIdSchema,
  personaId: EnduringAgentIdSchema,
  title: NonEmptyText(500),
  description: z.string().trim().max(100_000).optional(),
  status: z.enum(PERSONA_WORK_ITEM_STATUSES),
  priority: z.enum(PERSONA_PRIORITIES),
  dependencyIds: UniqueIdsSchema,
  nextAction: z.string().trim().max(20_000).optional(),
  deadline: TimestampSchema.optional(),
  createdByActivityId: EnduringAgentIdSchema.optional(),
  behaviorRevisionId: EnduringAgentIdSchema.optional(),
  sourceRefs: z.array(MemorySourceRefSchema).max(100).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
}).strict().superRefine((record, ctx) => {
  if (record.dependencyIds.includes(record.id)) {
    ctx.addIssue({
      code: 'custom',
      message: 'A WorkItem cannot depend on itself.',
      path: ['dependencyIds'],
    });
  }
  if (record.updatedAt < record.createdAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'updatedAt cannot precede createdAt.',
      path: ['updatedAt'],
    });
  }
  if (record.completedAt !== undefined && record.completedAt < record.createdAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'completedAt cannot precede createdAt.',
      path: ['completedAt'],
    });
  }
  if (record.completedAt !== undefined && record.completedAt > record.updatedAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'completedAt cannot follow updatedAt.',
      path: ['completedAt'],
    });
  }
  if (record.status === 'completed' && record.completedAt === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'A completed WorkItem requires completedAt.',
      path: ['completedAt'],
    });
  }
  if (record.status !== 'completed' && record.completedAt !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Only a completed WorkItem may have completedAt.',
      path: ['completedAt'],
    });
  }
});

export const CreatePersonaWorkItemInputSchema = z.object({
  id: EnduringAgentIdSchema.optional(),
  personaId: EnduringAgentIdSchema,
  title: NonEmptyText(500),
  description: z.string().trim().max(100_000).optional(),
  priority: z.enum(PERSONA_PRIORITIES).optional(),
  dependencyIds: UniqueIdsSchema.optional(),
  nextAction: z.string().trim().max(20_000).optional(),
  deadline: TimestampSchema.optional(),
  createdByActivityId: EnduringAgentIdSchema.optional(),
  sourceRefs: z.array(MemorySourceRefSchema).max(100).optional(),
}).strict();

export const UpdatePersonaWorkItemInputSchema = z.object({
  title: NonEmptyText(500).optional(),
  description: z.string().trim().max(100_000).nullable().optional(),
  status: z.enum(PERSONA_WORK_ITEM_STATUSES).optional(),
  priority: z.enum(PERSONA_PRIORITIES).optional(),
  dependencyIds: UniqueIdsSchema.optional(),
  nextAction: z.string().trim().max(20_000).nullable().optional(),
  deadline: TimestampSchema.nullable().optional(),
  expectedUpdatedAt: TimestampSchema.optional(),
}).strict();

export const AssignPersonaWorkItemInputSchema = z.object({
  expectedUpdatedAt: TimestampSchema,
  idempotencyKey: NonEmptyText(512),
}).strict();

export const MemoryItemSchema = z.object({
  schemaVersion: z.literal(ENDURING_AGENT_SCHEMA_VERSION),
  id: EnduringAgentIdSchema,
  personaId: EnduringAgentIdSchema,
  kind: z.enum(MEMORY_KINDS),
  scope: z.enum(MEMORY_SCOPES),
  status: z.enum(MEMORY_STATUSES),
  content: NonEmptyText(100_000),
  confidence: z.number().min(0).max(1),
  importance: z.number().min(0).max(1),
  sourceRefs: z.array(MemorySourceRefSchema).min(1).max(100),
  trust: z.enum(MEMORY_TRUST_LEVELS),
  validFrom: TimestampSchema.optional(),
  validUntil: TimestampSchema.optional(),
  supersedes: UniqueIdsSchema.optional(),
  conflictsWith: UniqueIdsSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((record, ctx) => {
  if (
    record.validFrom !== undefined
    && record.validUntil !== undefined
    && record.validUntil < record.validFrom
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'validUntil cannot precede validFrom.',
      path: ['validUntil'],
    });
  }
  if (record.updatedAt < record.createdAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'updatedAt cannot precede createdAt.',
      path: ['updatedAt'],
    });
  }
  if (record.supersedes?.includes(record.id)) {
    ctx.addIssue({
      code: 'custom',
      message: 'A MemoryItem cannot supersede itself.',
      path: ['supersedes'],
    });
  }
  if (record.conflictsWith?.includes(record.id)) {
    ctx.addIssue({
      code: 'custom',
      message: 'A MemoryItem cannot conflict with itself.',
      path: ['conflictsWith'],
    });
  }
});

export const CreateMemoryItemInputSchema = z.object({
  id: EnduringAgentIdSchema.optional(),
  personaId: EnduringAgentIdSchema,
  kind: z.enum(MEMORY_KINDS),
  scope: z.enum(MEMORY_SCOPES),
  status: z.enum(['candidate', 'active']).optional(),
  content: NonEmptyText(100_000),
  confidence: z.number().min(0).max(1),
  importance: z.number().min(0).max(1),
  sourceRefs: z.array(MemorySourceRefSchema).min(1).max(100),
  trust: z.enum(MEMORY_TRUST_LEVELS),
  validFrom: TimestampSchema.optional(),
  validUntil: TimestampSchema.optional(),
  supersedes: UniqueIdsSchema.optional(),
  conflictsWith: UniqueIdsSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (
    input.validFrom !== undefined
    && input.validUntil !== undefined
    && input.validUntil < input.validFrom
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'validUntil cannot precede validFrom.',
      path: ['validUntil'],
    });
  }
  if (input.id !== undefined && input.supersedes?.includes(input.id)) {
    ctx.addIssue({
      code: 'custom',
      message: 'A MemoryItem cannot supersede itself.',
      path: ['supersedes'],
    });
  }
  if (input.id !== undefined && input.conflictsWith?.includes(input.id)) {
    ctx.addIssue({
      code: 'custom',
      message: 'A MemoryItem cannot conflict with itself.',
      path: ['conflictsWith'],
    });
  }
});

export const PersonaMailboxItemSchema = z.object({
  schemaVersion: z.literal(ENDURING_AGENT_SCHEMA_VERSION),
  id: EnduringAgentIdSchema,
  personaId: EnduringAgentIdSchema,
  idempotencyKey: z.string().regex(SHA256_PATTERN),
  sequence: z.number().int().positive(),
  kind: z.enum(PERSONA_ACTIVITY_KINDS),
  priority: z.enum(PERSONA_PRIORITIES),
  status: z.enum(PERSONA_MAILBOX_STATUSES),
  source: PersonaActivitySourceSchema,
  behaviorSlotKey: BehaviorSlotKeySchema.optional(),
  relationKey: z.string().trim().max(512).optional(),
  relatedAction: z.enum(PERSONA_MAILBOX_RELATED_ACTIONS).optional(),
  routingDecision: z.enum(PERSONA_MAILBOX_ROUTING_DECISIONS).optional(),
  targetActivityId: EnduringAgentIdSchema.optional(),
  deliveryStatus: z.enum(PERSONA_MAILBOX_DELIVERY_STATUSES).optional(),
  deliveredAt: TimestampSchema.optional(),
  interruptedActivityId: EnduringAgentIdSchema.optional(),
  summary: z.string().trim().max(20_000).optional(),
  payloadRef: z.string().trim().max(4096).optional(),
  notBefore: TimestampSchema.optional(),
  claimedActivityId: EnduringAgentIdSchema.optional(),
  coalescedIntoId: EnduringAgentIdSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
}).strict().superRefine((record, ctx) => {
  const terminal = record.status === 'coalesced'
    || record.status === 'completed'
    || record.status === 'rejected';

  if (record.updatedAt < record.createdAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'updatedAt cannot precede createdAt.',
      path: ['updatedAt'],
    });
  }
  if (record.completedAt !== undefined && record.completedAt < record.createdAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'completedAt cannot precede createdAt.',
      path: ['completedAt'],
    });
  }
  if (record.completedAt !== undefined && record.completedAt > record.updatedAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'completedAt cannot follow updatedAt.',
      path: ['completedAt'],
    });
  }
  if (terminal && record.completedAt === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `${record.status} mailbox items require completedAt.`,
      path: ['completedAt'],
    });
  }
  if (!terminal && record.completedAt !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'A non-terminal mailbox item cannot have completedAt.',
      path: ['completedAt'],
    });
  }
  if ((record.status === 'claimed' || record.status === 'completed') && !record.claimedActivityId) {
    ctx.addIssue({
      code: 'custom',
      message: `${record.status} mailbox items require claimedActivityId.`,
      path: ['claimedActivityId'],
    });
  }
  if (record.status === 'queued' && record.claimedActivityId !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'A queued mailbox item cannot have claimedActivityId.',
      path: ['claimedActivityId'],
    });
  }
  if (record.status === 'coalesced' && !record.coalescedIntoId) {
    ctx.addIssue({
      code: 'custom',
      message: 'A coalesced mailbox item requires coalescedIntoId.',
      path: ['coalescedIntoId'],
    });
  }
  if (record.status !== 'coalesced' && record.coalescedIntoId !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Only a coalesced mailbox item may have coalescedIntoId.',
      path: ['coalescedIntoId'],
    });
  }
  if (record.coalescedIntoId === record.id) {
    ctx.addIssue({
      code: 'custom',
      message: 'A mailbox item cannot coalesce into itself.',
      path: ['coalescedIntoId'],
    });
  }
  if (record.relatedAction !== undefined && !record.relationKey?.trim()) {
    ctx.addIssue({
      code: 'custom',
      message: 'A related mailbox action requires a nonempty relationKey.',
      path: ['relationKey'],
    });
  }
  const relatedDelivery = record.routingDecision === 'steer'
    || record.routingDecision === 'coalesce';
  if (relatedDelivery) {
    if (record.status !== 'coalesced') {
      ctx.addIssue({
        code: 'custom',
        message: 'A steered/coalesced delivery must use coalesced mailbox status.',
        path: ['status'],
      });
    }
    if (!record.targetActivityId) {
      ctx.addIssue({
        code: 'custom',
        message: 'A steered/coalesced delivery requires targetActivityId.',
        path: ['targetActivityId'],
      });
    }
    if (!record.deliveryStatus) {
      ctx.addIssue({
        code: 'custom',
        message: 'A steered/coalesced delivery requires deliveryStatus.',
        path: ['deliveryStatus'],
      });
    }
    if (record.relatedAction !== record.routingDecision) {
      ctx.addIssue({
        code: 'custom',
        message: 'The persisted related action must match its routing decision.',
        path: ['relatedAction'],
      });
    }
  } else if (
    record.targetActivityId !== undefined
    || record.deliveryStatus !== undefined
    || record.deliveredAt !== undefined
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Only a steered/coalesced delivery may carry delivery state.',
      path: ['deliveryStatus'],
    });
  }
  if (record.deliveryStatus === 'pending' && record.deliveredAt !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'A pending mailbox delivery cannot have deliveredAt.',
      path: ['deliveredAt'],
    });
  }
  if (record.deliveryStatus === 'delivered' && record.deliveredAt === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'A delivered mailbox item requires deliveredAt.',
      path: ['deliveredAt'],
    });
  }
  if (record.deliveredAt !== undefined && record.deliveredAt > record.updatedAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'deliveredAt cannot follow updatedAt.',
      path: ['deliveredAt'],
    });
  }
  if (record.routingDecision === 'interrupt') {
    if (!record.interruptedActivityId) {
      ctx.addIssue({
        code: 'custom',
        message: 'An interrupt-routed mailbox item requires interruptedActivityId.',
        path: ['interruptedActivityId'],
      });
    }
    if (record.priority !== 'urgent') {
      ctx.addIssue({
        code: 'custom',
        message: 'Only urgent mailbox work may request an interruption.',
        path: ['priority'],
      });
    }
  } else if (record.interruptedActivityId !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Only an interrupt-routed mailbox item may identify an interrupted Activity.',
      path: ['interruptedActivityId'],
    });
  }
});

export const CreatePersonaMailboxItemInputSchema = z.object({
  personaId: EnduringAgentIdSchema,
  idempotencyKey: NonEmptyText(512),
  kind: z.enum(PERSONA_ACTIVITY_KINDS),
  priority: z.enum(PERSONA_PRIORITIES).optional(),
  source: PersonaActivitySourceSchema,
  behaviorSlotKey: BehaviorSlotKeySchema.optional(),
  relationKey: z.string().trim().max(512).optional(),
  relatedAction: z.enum(PERSONA_MAILBOX_RELATED_ACTIONS).optional(),
  summary: z.string().trim().max(20_000).optional(),
  payloadRef: z.string().trim().max(4096).optional(),
  notBefore: TimestampSchema.optional(),
}).strict().superRefine((record, ctx) => {
  if (record.relatedAction !== undefined && !record.relationKey?.trim()) {
    ctx.addIssue({
      code: 'custom',
      message: 'A related mailbox action requires a nonempty relationKey.',
      path: ['relationKey'],
    });
  }
});

export const PersonaLeaseSchema = z.object({
  schemaVersion: z.literal(ENDURING_AGENT_SCHEMA_VERSION),
  id: EnduringAgentIdSchema,
  workspaceId: NonEmptyText(256),
  personaId: EnduringAgentIdSchema,
  activityId: EnduringAgentIdSchema,
  holderId: EnduringAgentIdSchema,
  status: z.enum(PERSONA_LEASE_STATUSES),
  fencingToken: z.number().int().positive(),
  acquiredAt: TimestampSchema,
  renewedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  releasedAt: TimestampSchema.optional(),
}).strict().superRefine((record, ctx) => {
  if (record.renewedAt < record.acquiredAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'renewedAt cannot precede acquiredAt.',
      path: ['renewedAt'],
    });
  }
  if (record.expiresAt <= record.renewedAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'expiresAt must follow renewedAt.',
      path: ['expiresAt'],
    });
  }
  if (record.releasedAt !== undefined && record.releasedAt < record.renewedAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'releasedAt cannot precede renewedAt.',
      path: ['releasedAt'],
    });
  }
  if (record.status === 'released' && record.releasedAt === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'A released lease requires releasedAt.',
      path: ['releasedAt'],
    });
  }
  if (record.status !== 'released' && record.releasedAt !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Only a released lease may have releasedAt.',
      path: ['releasedAt'],
    });
  }
});

export const CreatePersonaLeaseInputSchema = z.object({
  personaId: EnduringAgentIdSchema,
  activityId: EnduringAgentIdSchema,
  holderId: EnduringAgentIdSchema,
  ttlMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1_000),
}).strict();

export const PersonaDeletionCountsSchema = z.object({
  behaviorBindings: z.number().int().nonnegative(),
  behaviorRevisions: z.number().int().nonnegative(),
  // Additive defaults preserve already-written deletion tombstones from earlier phases.
  behaviorProposals: z.number().int().nonnegative().default(0),
  appGrants: z.number().int().nonnegative().default(0),
  memoryItems: z.number().int().nonnegative(),
  workItems: z.number().int().nonnegative(),
  liveActivities: z.number().int().nonnegative(),
  archivedActivities: z.number().int().nonnegative(),
  openMailboxItems: z.number().int().nonnegative(),
  archivedMailboxItems: z.number().int().nonnegative(),
  leaseRecords: z.number().int().nonnegative(),
  coreMemoryItems: z.number().int().nonnegative(),
  homeFiles: z.number().int().nonnegative(),
  homeBytes: z.number().int().nonnegative(),
}).strict();

export const DeletePersonaInputSchema = z.object({
  previewToken: z.string().regex(SHA256_PATTERN),
  archivePolicy: z.enum(PERSONA_DELETION_ARCHIVE_POLICIES),
  confirmation: z.literal('DELETE'),
}).strict();

export const PersonaDeletionTombstoneSchema = z.object({
  schemaVersion: z.literal(ENDURING_AGENT_SCHEMA_VERSION),
  id: EnduringAgentIdSchema,
  workspaceId: NonEmptyText(256),
  personaIdHash: z.string().regex(SHA256_PATTERN),
  retainedPersonaId: EnduringAgentIdSchema.optional(),
  status: z.enum(PERSONA_DELETION_STATUSES),
  archivePolicy: z.enum(PERSONA_DELETION_ARCHIVE_POLICIES),
  previewToken: z.string().regex(SHA256_PATTERN),
  counts: PersonaDeletionCountsSchema,
  requestedAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
}).strict().superRefine((record, ctx) => {
  if (record.updatedAt < record.requestedAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'updatedAt cannot precede requestedAt.',
      path: ['updatedAt'],
    });
  }
  if (record.completedAt !== undefined && record.completedAt > record.updatedAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'completedAt cannot follow updatedAt.',
      path: ['completedAt'],
    });
  }
  if (record.status === 'completed' && record.completedAt === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'A completed deletion requires completedAt.',
      path: ['completedAt'],
    });
  }
  if (record.status !== 'completed' && record.completedAt !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Only a completed deletion may have completedAt.',
      path: ['completedAt'],
    });
  }
  if (record.archivePolicy === 'anonymize' && record.retainedPersonaId !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'An anonymized deletion cannot retain the Persona id.',
      path: ['retainedPersonaId'],
    });
  }
  if (record.archivePolicy === 'retain_tombstone' && record.retainedPersonaId === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'A retained tombstone requires the Persona id.',
      path: ['retainedPersonaId'],
    });
  }
});
