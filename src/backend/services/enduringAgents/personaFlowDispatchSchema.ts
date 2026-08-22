import { z } from 'zod';

import { FLOW_INVOCATION_SOURCES } from '@/backend/execution/flow/types';
import {
  EnduringAgentIdSchema,
  PERSONA_ACTIVITY_KINDS,
  PERSONA_ACTIVITY_SOURCE_KINDS,
  PERSONA_PRIORITIES,
  PersonaInstructionContextSchema,
} from '@/shared/types/enduringAgent';

import {
  MemoryMaintenancePlanSchema,
  MemoryMaintenanceResultSchema,
} from './memoryMaintenance';

/**
 * Private durable-envelope version. Keeping the schema outside the dispatcher
 * lets retention validate and persist terminal records without invoking
 * dispatcher lifecycle notifications.
 */
export const PERSONA_FLOW_DISPATCH_SCHEMA_VERSION = 1 as const;

export const PERSONA_FLOW_DISPATCH_STATES = [
  'queued',
  'running',
  'waiting',
  'completed',
  'error',
  'cancelled',
] as const;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function isPlainJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) return true;
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isPlainJsonValue(item, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value).every((item) => isPlainJsonValue(item, seen));
  } finally {
    seen.delete(value);
  }
}

const JsonValueSchema = z.unknown().refine(isPlainJsonValue, {
  message: 'Value must be plain JSON without cycles, undefined values, or non-finite numbers.',
});

export const SerializableFlowRunInputSchema = z.object({
  messages: z.array(JsonValueSchema).optional(),
  mcpAppContexts: JsonValueSchema.optional(),
  prompt: z.string().optional(),
  processNodeId: z.string().trim().min(1).optional(),
  variables: z.record(z.string(), JsonValueSchema).optional(),
  mode: z.enum(['ephemeral', 'conversation']).optional(),
  conversationId: EnduringAgentIdSchema.optional(),
  runId: EnduringAgentIdSchema.optional(),
  title: z.string().optional(),
  flujo: z.boolean().optional(),
  requireApproval: z.boolean().optional(),
  debug: z.boolean().optional(),
  continueDebug: z.boolean().optional(),
  userTurn: z.boolean().optional(),
  parentRunId: EnduringAgentIdSchema.optional(),
  lane: JsonValueSchema.optional(),
  depth: z.number().int().nonnegative().optional(),
  source: z.enum(FLOW_INVOCATION_SOURCES),
  plannedExecutionId: EnduringAgentIdSchema.optional(),
  plannedExecutionName: z.string().optional(),
  chainDepth: z.number().int().nonnegative().optional(),
  onApprovalRequired: z.enum(['auto', 'fail', 'pause']).optional(),
  meetingParticipant: JsonValueSchema.optional(),
  meetingTurn: JsonValueSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.source === 'meeting' && (!input.meetingParticipant || !input.meetingTurn)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Meeting dispatches require meetingParticipant and meetingTurn.',
    });
  }
});

export const DispatchAdmissionSchema = z.object({
  kind: z.enum(PERSONA_ACTIVITY_KINDS),
  priority: z.enum(PERSONA_PRIORITIES),
  source: z.object({
    kind: z.enum(PERSONA_ACTIVITY_SOURCE_KINDS),
    sourceId: z.string().trim().min(1).max(512).optional(),
  }).strict(),
  behaviorSlotKey: z.string().trim().min(1).max(128).optional(),
  relationKey: z.string().trim().min(1).max(512).optional(),
  relatedAction: z.enum(['steer', 'coalesce']).optional(),
  summary: z.string().trim().max(20_000).optional(),
  notBefore: z.number().int().nonnegative().optional(),
}).strict().superRefine((input, ctx) => {
  if (input.relatedAction && !input.relationKey) {
    ctx.addIssue({
      code: 'custom',
      message: 'relatedAction requires relationKey.',
      path: ['relationKey'],
    });
  }
});

const DispatchErrorSchema = z.object({
  code: z.string().trim().min(1).max(128),
  message: z.string().trim().min(1).max(4_000),
  at: z.number().int().nonnegative(),
}).strict();

export const DispatchOutcomeSchema = z.object({
  status: z.enum([
    'completed',
    'error',
    'awaiting_tool_approval',
    'paused_debug',
    'running',
    'capped',
    'steered',
    'coalesced',
  ]),
  conversationId: EnduringAgentIdSchema.optional(),
  runId: EnduringAgentIdSchema.optional(),
  outputText: z.string().max(20_000).optional(),
  finalAction: z.string().max(512).optional(),
  personaId: EnduringAgentIdSchema,
  activityId: EnduringAgentIdSchema,
  behaviorRevisionId: EnduringAgentIdSchema,
}).strict();

export const PersonaFlowDispatchRecordSchema = z.object({
  schemaVersion: z.literal(PERSONA_FLOW_DISPATCH_SCHEMA_VERSION),
  id: EnduringAgentIdSchema,
  workspaceId: z.string().trim().min(1).max(256),
  personaId: EnduringAgentIdSchema,
  idempotencyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(PERSONA_FLOW_DISPATCH_STATES),
  admission: DispatchAdmissionSchema,
  flowInput: SerializableFlowRunInputSchema.optional(),
  mailboxItemId: EnduringAgentIdSchema.optional(),
  routingDecision: z.enum([
    'duplicate',
    'queued',
    'steered',
    'coalesced',
    'interrupt_requested',
  ]).optional(),
  targetActivityId: EnduringAgentIdSchema.optional(),
  activityId: EnduringAgentIdSchema.optional(),
  behaviorRevisionId: EnduringAgentIdSchema.optional(),
  instructionContext: PersonaInstructionContextSchema.optional(),
  maintenancePlan: MemoryMaintenancePlanSchema.optional(),
  maintenanceResult: MemoryMaintenanceResultSchema.optional(),
  memoryCandidateLimit: z.number().int().min(0).max(3).optional(),
  waitingReason: z.enum(['delivery', 'approval', 'debug', 'running', 'interrupted']).optional(),
  cancellationRequestedAt: z.number().int().nonnegative().optional(),
  cancellationReason: z.string().trim().min(1).max(512).optional(),
  resumeRequestedAt: z.number().int().nonnegative().optional(),
  resumeSettledAt: z.number().int().nonnegative().optional(),
  resumeReason: z.enum(['approval', 'debug', 'manual']).optional(),
  resumeFromWaitingReason: z.enum(['approval', 'debug', 'running', 'interrupted']).optional(),
  resumePreparationRequired: z.boolean().optional(),
  outcome: DispatchOutcomeSchema.optional(),
  error: DispatchErrorSchema.optional(),
  lastError: DispatchErrorSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  completedAt: z.number().int().nonnegative().optional(),
  compactedAt: z.number().int().nonnegative().optional(),
}).strict().superRefine((record, ctx) => {
  const terminal = record.state === 'completed'
    || record.state === 'error'
    || record.state === 'cancelled';
  if (!record.flowInput && record.state !== 'error' && record.compactedAt === undefined) {
    ctx.addIssue({ code: 'custom', message: 'Only an error recovery or compacted record may omit flowInput.' });
  }
  if (record.compactedAt !== undefined && !terminal) {
    ctx.addIssue({ code: 'custom', message: 'Only a terminal dispatch may be compacted.' });
  }
  if (record.state === 'running' && (!record.activityId || !record.behaviorRevisionId)) {
    ctx.addIssue({ code: 'custom', message: 'A running dispatch requires Activity and revision ids.' });
  }
  if (record.instructionContext && (
    record.instructionContext.personaId !== record.personaId
    || record.instructionContext.activityId !== record.activityId
    || record.instructionContext.behaviorRevisionId !== record.behaviorRevisionId
  )) {
    ctx.addIssue({
      code: 'custom',
      message: 'A frozen instruction context must match the dispatch attribution triple.',
      path: ['instructionContext'],
    });
  }
  if (record.maintenancePlan && (
    record.admission.kind !== 'maintenance'
    || record.admission.source.kind !== 'maintenance'
    || record.admission.source.sourceId !== record.maintenancePlan.sourceActivityId
  )) {
    ctx.addIssue({
      code: 'custom',
      message: 'A maintenance evidence plan must match its maintenance Activity source.',
      path: ['maintenancePlan'],
    });
  }
  if (record.maintenanceResult && record.admission.kind !== 'maintenance') {
    ctx.addIssue({
      code: 'custom',
      message: 'Only a maintenance dispatch may carry a maintenance result.',
      path: ['maintenanceResult'],
    });
  }
  if (record.state === 'waiting' && !record.waitingReason) {
    ctx.addIssue({ code: 'custom', message: 'A waiting dispatch requires waitingReason.' });
  }
  if (record.state !== 'waiting' && record.waitingReason) {
    ctx.addIssue({ code: 'custom', message: 'Only a waiting dispatch may carry waitingReason.' });
  }
  if (record.state === 'error' && !record.error) {
    ctx.addIssue({ code: 'custom', message: 'An errored dispatch requires a sanitized error.' });
  }
  if (record.state !== 'error' && record.error) {
    ctx.addIssue({ code: 'custom', message: 'Only an errored dispatch may carry error.' });
  }
  if (terminal && record.completedAt === undefined) {
    ctx.addIssue({ code: 'custom', message: 'A terminal dispatch requires completedAt.' });
  }
  if (!terminal && record.completedAt !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'A non-terminal dispatch cannot carry completedAt.' });
  }
});
