import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Model } from '@/shared/types/model';

export const ownerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative();
export const BudgetSchema = z.object({
  // Explicit owner decisions. There are deliberately no inferred/default limits.
  maxModelSteps: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
}).strict();
export const ApprovalSchema = z.object({ ownerId, credentialId: ownerId, policyRevision: digest }).strict();
export const AccountSchema = z.object({
  id: ownerId, ownerId, modelId: ownerId,
  kind: z.enum(['openai', 'codex']),
  modelDigest: digest,
  credential: z.string(),
  routingHeaders: z.partialRecord(z.enum(['openai-organization', 'openai-project', 'http-referer', 'x-title']), z.string()),
  state: z.enum(['pending', 'active', 'revoked']), approval: ApprovalSchema,
  createdAt: time, updatedAt: time,
}).strict();
export const EnrollmentSchema = z.object({
  id: ownerId, workspace: ownerId, ownerId, personaId: ownerId, taskId: ownerId,
  accountId: ownerId, modelId: ownerId, workerAuthorizationDigest: digest,
  budget: BudgetSchema, approval: ApprovalSchema,
  allowedTools: z.array(z.enum(['worker_read_file', 'worker_write_file', 'worker_list_dir', 'worker_command'])),
  // A command is authorized by its exact final text, not by a shell executable name.
  commands: z.array(z.string().min(1).max(16384)),
  directory: z.string().optional(),
  state: z.enum(['active', 'revoked']), createdAt: time, updatedAt: time,
}).strict();
export const StepSchema = z.object({
  id: ownerId, enrollmentId: ownerId, accountId: ownerId,
  kind: z.enum(['model', 'native', 'tool']), originalRunId: ownerId,
  leaseId: ownerId, modelDigest: digest,
  nodeId: z.string().min(1).max(512).optional(), ordinal: time.optional(),
  authorityDigest: digest.optional(), urlDigest: digest.optional(), routingDigest: digest.optional(),
  maxOutputTokens: time.nullable().optional(),
  state: z.enum(['issued', 'sending', 'completed', 'rejected', 'aborted', 'unknown']),
  operation: z.string().optional(), bodyDigest: digest.optional(), headersDigest: digest.optional(),
  argsDigest: digest.optional(), tool: z.string().optional(), nativeRunId: z.string().optional(),
  senderId: ownerId.optional(), status: z.number().int().optional(),
  // Missing counters and unavailable billing stay unknown, never synthetic zero.
  usage: z.object({ inputTokens: time.nullable(), outputTokens: time.nullable() }).strict().nullable(),
  createdAt: time, updatedAt: time,
}).strict();
/** Historical read provenance is written only by genuine dispatcher capture,
 * before Source receives a runtime capability. It is never an inference grant. */
export const OriginalOwnerRunSchema = z.object({
  id: ownerId, enrollmentId: ownerId, ownerId, workspace: ownerId,
  personaId: ownerId, taskId: ownerId, activityId: ownerId, dispatchId: ownerId, revisionId: ownerId,
  conversationId: z.string().min(1).max(256), runId: z.string().min(1).max(256),
  modelId: ownerId, modelDigest: digest, flowId: z.string().min(1).max(512), planDigest: digest,
  createdAt: time,
}).strict();
export const BookSchema = z.object({
  version: z.literal(1), accounts: z.array(AccountSchema).max(128),
  enrollments: z.array(EnrollmentSchema).max(1024), steps: z.array(StepSchema).max(20000),
  runs: z.array(OriginalOwnerRunSchema).max(20000).optional(),
}).strict().superRefine((book, context) => {
  for (const name of ['accounts', 'enrollments', 'steps'] as const) {
    if (new Set(book[name].map(item => item.id)).size !== book[name].length) {
      context.addIssue({ code: 'custom', message: 'Duplicate owner record identity', path: [name] });
    }
  }
  if (book.runs && new Set(book.runs.map(item => item.id)).size !== book.runs.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate Original run identity', path: ['runs'] });
  }
});
export type OriginalOwnerAccount = z.infer<typeof AccountSchema>;
export type OriginalOwnerEnrollment = z.infer<typeof EnrollmentSchema>;
export type OriginalOwnerStep = z.infer<typeof StepSchema>;
export type OriginalOwnerBook = z.infer<typeof BookSchema>;
export type OriginalOwnerRun = z.infer<typeof OriginalOwnerRunSchema>;
export function ownerDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function bytesDigest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}
/** Same immutable native model projection used by the Source host. Credentials are excluded. */
export function nativeModelPlan(model: Model) {
  return { id: model.id, name: model.name, adapter: model.adapter, provider: model.provider,
    maxTurns: model.maxTurns, temperature: model.temperature, reasoningEffort: model.reasoningEffort,
    fallbackPolicy: model.fallbackPolicy };
}
export function accountModelPlan(model: Model) {
  return { ...nativeModelPlan(model), baseUrl: model.baseUrl, maxTokens: model.maxTokens,
    reasoningSchema: model.reasoningSchema, promptTemplate: model.promptTemplate,
    supportedParameters: model.supportedParameters, supportsTools: model.supportsTools,
    ownerCredentialBinding: model.ownerCredentialBinding };
}
const errorRoot = globalThis as typeof globalThis & { __flujoOriginalOwnerErrors?: WeakSet<object> };
const errors = errorRoot.__flujoOriginalOwnerErrors ??= new WeakSet<object>();
export class OriginalOwnerError extends Error {
  constructor(readonly code: string, readonly status = 403) {
    super(code); this.name = 'OriginalOwnerError'; errors.add(this);
  }
  static [Symbol.hasInstance](value: unknown): boolean {
    return Boolean(value && typeof value === 'object' && errors.has(value));
  }
}
export function refuse(code = 'original_owner_refused'): never { throw new OriginalOwnerError(code); }
