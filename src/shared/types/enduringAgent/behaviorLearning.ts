import { z } from 'zod';

import type { Flow } from '@/shared/types/flow';

import {
  ENDURING_AGENT_SCHEMA_VERSION,
  type MemorySourceRef,
} from './enduringAgent';
import {
  BehaviorSlotKeySchema,
  EnduringAgentIdSchema,
  FlowSnapshotSchema,
  MemorySourceRefSchema,
} from './schemas';

export const BEHAVIOR_PROPOSAL_STATUSES = [
  'validation_failed',
  'awaiting_approval',
  'approved',
  'rejected',
  'activated',
  'rolled_back',
] as const;
export type BehaviorProposalStatus = (typeof BEHAVIOR_PROPOSAL_STATUSES)[number];

export const BEHAVIOR_PROPOSAL_AUDIT_ACTIONS = [
  'proposed',
  'validation_failed',
  'approved',
  'auto_approved',
  'rejected',
  'activated',
  'rolled_back',
  'promoted_to_role',
] as const;
export type BehaviorProposalAuditAction =
  (typeof BEHAVIOR_PROPOSAL_AUDIT_ACTIONS)[number];

export interface BehaviorProposalIssue {
  severity: string;
  code: string;
  message: string;
}

export interface BehaviorProposalValidation {
  compileSucceeded: boolean;
  errorCount: number;
  warningCount: number;
  issues: BehaviorProposalIssue[];
}

export interface BehaviorProposalEvalResult {
  id: string;
  passed: boolean;
  details?: string;
  candidateContentHash: string;
}

export interface BehaviorProposalApproval {
  kind: 'manual' | 'policy';
  actor: string;
  reason: string;
  approvedAt: number;
}

export interface BehaviorProposalAuditEvent {
  action: BehaviorProposalAuditAction;
  actor: string;
  reason: string;
  at: number;
  revisionId?: string;
  roleVersionId?: string;
}

export interface BehaviorProposal {
  schemaVersion: typeof ENDURING_AGENT_SCHEMA_VERSION;
  id: string;
  personaId: string;
  behaviorId: string;
  slotKey: string;
  baseBehaviorRevisionId: string;
  rationale: string;
  /** Plain-language preview of the candidate's observable behavior change. */
  changeSummary?: string;
  evidenceRefs: MemorySourceRef[];
  candidateSpecDigest: string;
  candidateFlow?: Flow;
  candidateContentHash?: string;
  validation: BehaviorProposalValidation;
  evalResults: BehaviorProposalEvalResult[];
  status: BehaviorProposalStatus;
  approval?: BehaviorProposalApproval;
  activatedRevisionId?: string;
  rollbackRevisionId?: string;
  promotedRoleVersionId?: string;
  auditTrail: BehaviorProposalAuditEvent[];
  createdAt: number;
  updatedAt: number;
}

const TimestampSchema = z.number().int().nonnegative();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const NonEmptyText = (max: number) => z.string().trim().min(1).max(max);

export const BehaviorProposalIssueSchema = z.object({
  severity: NonEmptyText(32),
  code: NonEmptyText(160),
  message: NonEmptyText(10_000),
}).strict();

export const BehaviorProposalValidationSchema = z.object({
  compileSucceeded: z.boolean(),
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  issues: z.array(BehaviorProposalIssueSchema).max(1_000),
}).strict();

export const BehaviorProposalEvalResultSchema = z.object({
  id: NonEmptyText(160),
  passed: z.boolean(),
  details: z.string().trim().max(10_000).optional(),
  candidateContentHash: Sha256Schema,
}).strict();

export const BehaviorProposalApprovalSchema = z.object({
  kind: z.enum(['manual', 'policy']),
  actor: NonEmptyText(256),
  reason: NonEmptyText(10_000),
  approvedAt: TimestampSchema,
}).strict();

export const BehaviorProposalAuditEventSchema = z.object({
  action: z.enum(BEHAVIOR_PROPOSAL_AUDIT_ACTIONS),
  actor: NonEmptyText(256),
  reason: NonEmptyText(10_000),
  at: TimestampSchema,
  revisionId: EnduringAgentIdSchema.optional(),
  roleVersionId: EnduringAgentIdSchema.optional(),
}).strict();

export const BehaviorProposalSchema: z.ZodType<BehaviorProposal> = z.object({
  schemaVersion: z.literal(ENDURING_AGENT_SCHEMA_VERSION),
  id: EnduringAgentIdSchema,
  personaId: EnduringAgentIdSchema,
  behaviorId: EnduringAgentIdSchema,
  slotKey: BehaviorSlotKeySchema,
  baseBehaviorRevisionId: EnduringAgentIdSchema,
  rationale: NonEmptyText(20_000),
  changeSummary: NonEmptyText(20_000).optional(),
  evidenceRefs: z.array(MemorySourceRefSchema).min(1).max(100),
  candidateSpecDigest: Sha256Schema,
  candidateFlow: FlowSnapshotSchema.optional(),
  candidateContentHash: Sha256Schema.optional(),
  validation: BehaviorProposalValidationSchema,
  evalResults: z.array(BehaviorProposalEvalResultSchema).max(100),
  status: z.enum(BEHAVIOR_PROPOSAL_STATUSES),
  approval: BehaviorProposalApprovalSchema.optional(),
  activatedRevisionId: EnduringAgentIdSchema.optional(),
  rollbackRevisionId: EnduringAgentIdSchema.optional(),
  promotedRoleVersionId: EnduringAgentIdSchema.optional(),
  auditTrail: z.array(BehaviorProposalAuditEventSchema).min(1).max(1_000),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((proposal, context) => {
  if (proposal.validation.compileSucceeded !== Boolean(proposal.candidateFlow)) {
    context.addIssue({
      code: 'custom',
      path: ['candidateFlow'],
      message: 'A compiled candidate Flow is required exactly when compilation succeeded.',
    });
  }
  if (Boolean(proposal.candidateFlow) !== Boolean(proposal.candidateContentHash)) {
    context.addIssue({
      code: 'custom',
      path: ['candidateContentHash'],
      message: 'A candidate Flow and its content hash must be recorded together.',
    });
  }
  if (
    proposal.candidateContentHash
    && proposal.evalResults.some(
      (result) => result.candidateContentHash !== proposal.candidateContentHash,
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['evalResults'],
      message: 'Every eval result must be bound to the proposal candidate content hash.',
    });
  }
  if (!['validation_failed', 'rejected'].includes(proposal.status) && (
    proposal.validation.errorCount > 0
    || proposal.evalResults.length === 0
    || proposal.evalResults.some((result) => !result.passed)
  )) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'Only a clean, fully evaluated proposal may leave validation_failed.',
    });
  }
  if (
    ['approved', 'activated', 'rolled_back'].includes(proposal.status)
    && !proposal.approval
  ) {
    context.addIssue({
      code: 'custom',
      path: ['approval'],
      message: 'Approved and activated proposals require an approval decision.',
    });
  }
  if (
    ['activated', 'rolled_back'].includes(proposal.status)
    && !proposal.activatedRevisionId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['activatedRevisionId'],
      message: 'Activated and rolled-back proposals require the activated revision audit id.',
    });
  }
  if (proposal.status === 'rolled_back' && !proposal.rollbackRevisionId) {
    context.addIssue({
      code: 'custom',
      path: ['rollbackRevisionId'],
      message: 'A rolled-back proposal requires the rollback target revision id.',
    });
  }
  if (
    !['activated', 'rolled_back'].includes(proposal.status)
    && proposal.activatedRevisionId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['activatedRevisionId'],
      message: 'A proposal cannot record activation before it is activated.',
    });
  }
  if (proposal.status !== 'rolled_back' && proposal.rollbackRevisionId) {
    context.addIssue({
      code: 'custom',
      path: ['rollbackRevisionId'],
      message: 'A proposal cannot record rollback before it is rolled back.',
    });
  }
});
