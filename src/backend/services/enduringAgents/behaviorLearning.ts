import { createHash } from 'crypto';

import { validateFlowObjectForRun } from '@/backend/execution/flow/validateFlowForRun';
import { compileSpec } from '@/backend/services/flow/compileFlow';
import {
  BehaviorProposalSchema,
  BehaviorRevisionSchema,
  ENDURING_AGENT_SCHEMA_VERSION,
  RoleVersionSchema,
  type BehaviorProposal,
  type BehaviorProposalAuditEvent,
  type BehaviorProposalEvalResult,
  type BehaviorProposalIssue,
  type MemoryItem,
  type MemorySourceRef,
  type MemoryTrust,
  type Persona,
  type RoleVersion,
} from '@/shared/types/enduringAgent';
import type { Flow } from '@/shared/types/flow';
import { createLogger } from '@/utils/logger';
import {
  assertSafeCollectionId,
  listCollectionItemEntriesStrict,
  loadCollectionItem,
  runInWriteChain,
  saveCollectionItem,
} from '@/utils/storage/backend';

import {
  behaviorRevisionId,
  canonicalJson,
  hashBehaviorFlow,
  snapshotBehaviorFlow,
} from './behaviorRevisions';
import { ENDURING_AGENT_COLLECTIONS } from './collections';
import { randomEnduringAgentId, stableEnduringAgentId } from './ids';
import {
  type MemoryMutationOptions,
  rememberMemory,
} from './memoryKernel';
import { normalizeMemorySourceRefs } from './provenance';
import {
  activateBehaviorBindingRevision,
  createBehaviorRevision,
  createRoleVersion,
  getBehaviorBinding,
  getBehaviorRevision,
  getPersona,
  getRoleVersion,
  listBehaviorBindings,
  listBehaviorRevisions,
  listRoleVersions,
} from './store';

const log = createLogger('backend/services/enduringAgents/behaviorLearning');

const BEHAVIOR_PROPOSAL_COLLECTION = ENDURING_AGENT_COLLECTIONS.behaviorProposals;

export class BehaviorLearningPolicyError extends Error {
  readonly code = 'BEHAVIOR_LEARNING_POLICY';

  constructor(message: string) {
    super(message);
    this.name = 'BehaviorLearningPolicyError';
  }
}

export class BehaviorProposalNotFoundError extends Error {
  readonly code = 'BEHAVIOR_PROPOSAL_NOT_FOUND';

  constructor(readonly proposalId: string) {
    super('BehaviorProposal ' + JSON.stringify(proposalId) + ' was not found.');
    this.name = 'BehaviorProposalNotFoundError';
  }
}

export class BehaviorProposalConflictError extends Error {
  readonly code = 'BEHAVIOR_PROPOSAL_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'BehaviorProposalConflictError';
  }
}

export interface BehaviorProposalCompileResult {
  success: boolean;
  flow?: Flow;
  errorCount: number;
  warningCount: number;
  issues: BehaviorProposalIssue[];
}

export interface DeterministicBehaviorEvalContext {
  proposalId: string;
  persona: Persona;
  baseRevision: NonNullable<Awaited<ReturnType<typeof getBehaviorRevision>>>;
  candidateFlow: Flow;
  candidateContentHash: string;
}

export interface DeterministicBehaviorEval {
  id: string;
  run(
    context: DeterministicBehaviorEvalContext,
  ): Promise<{ passed: boolean; details?: string }> | { passed: boolean; details?: string };
}

export interface CreateBehaviorProposalInput {
  personaId: string;
  behaviorId: string;
  baseBehaviorRevisionId: string;
  rationale: string;
  changeSummary?: string;
  evidenceRefs: MemorySourceRef[];
  candidateSpec: unknown;
  evals: DeterministicBehaviorEval[];
  actor?: string;
  origin?: 'manual' | 'persona_tool' | 'engine_maintenance';
  maintenanceRunId?: string;
  detectorVersion?: string;
  evaluationSuiteVersion?: string;
  diffRiskClass?: 'instruction_only' | 'capability_or_authority' | 'unknown';
  policyDecisionCode?: string;
}

export interface CreateBehaviorProposalOptions {
  compiler?: (spec: unknown) => Promise<BehaviorProposalCompileResult>;
  autoApplyPolicy?: (context: {
    persona: Persona;
    proposal: BehaviorProposal;
  }) => Promise<{ allowed: boolean; actor: string; reason: string }>
    | { allowed: boolean; actor: string; reason: string };
}

export interface CreateProceduralHintInput {
  personaId: string;
  content: string;
  confidence: number;
  importance: number;
  sourceRefs: MemorySourceRef[];
  trust: MemoryTrust;
  id?: string;
}

export interface ApproveBehaviorProposalInput {
  actor: string;
  reason: string;
}

export interface PromoteBehaviorProposalInput {
  confirmation: 'PROMOTE';
  actor: string;
  name?: string;
  migrationNotes: string;
}

export interface SuggestBehaviorInstructionImprovementInput {
  personaId: string;
  slotKey: string;
  rationale: string;
  instruction: string;
  evidenceRefs: MemorySourceRef[];
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new BehaviorProposalConflictError(label + ' is required.');
  return normalized;
}

function requirePersona(persona: Persona | null, personaId: string): Persona {
  if (!persona) {
    throw new BehaviorProposalConflictError(
      'Persona ' + JSON.stringify(personaId) + ' was not found.',
    );
  }
  return persona;
}

function assertCanLearnHint(persona: Persona): void {
  if (persona.autonomyLevel === 'locked') {
    throw new BehaviorLearningPolicyError(
      'Persona ' + JSON.stringify(persona.id)
      + ' is locked and cannot retain procedural hints.',
    );
  }
}

function assertCanPropose(persona: Persona): void {
  if (persona.autonomyLevel === 'locked' || persona.autonomyLevel === 'learn_hints') {
    throw new BehaviorLearningPolicyError(
      'Persona ' + JSON.stringify(persona.id) + ' autonomy level '
      + JSON.stringify(persona.autonomyLevel) + ' cannot create Behavior overrides.',
    );
  }
}

function auditEvent(
  action: BehaviorProposalAuditEvent['action'],
  actor: string,
  reason: string,
  at: number,
  extra: Pick<BehaviorProposalAuditEvent, 'revisionId' | 'roleVersionId'> = {},
): BehaviorProposalAuditEvent {
  return {
    action,
    actor: requireText(actor, 'Audit actor'),
    reason: requireText(reason, 'Audit reason'),
    at,
    ...(extra.revisionId ? { revisionId: extra.revisionId } : {}),
    ...(extra.roleVersionId ? { roleVersionId: extra.roleVersionId } : {}),
  };
}

function parseProposal(value: unknown): BehaviorProposal {
  return BehaviorProposalSchema.parse(value);
}

async function loadProposal(proposalId: string): Promise<BehaviorProposal | null> {
  assertSafeCollectionId(proposalId);
  const value = await loadCollectionItem<unknown | null>(
    BEHAVIOR_PROPOSAL_COLLECTION,
    proposalId,
    null,
  );
  if (value === null) return null;
  const proposal = parseProposal(value);
  if (proposal.id !== proposalId) {
    throw new BehaviorProposalConflictError('BehaviorProposal storage identity is corrupt.');
  }
  return proposal;
}

async function saveNewProposal(proposal: BehaviorProposal): Promise<BehaviorProposal> {
  const parsed = parseProposal(proposal);
  assertSafeCollectionId(parsed.id);
  return runInWriteChain(
    'enduring-agent:' + BEHAVIOR_PROPOSAL_COLLECTION + '/' + parsed.id,
    async () => {
      const existing = await loadProposal(parsed.id);
      if (existing) {
        if (canonicalJson(existing) === canonicalJson(parsed)) return existing;
        throw new BehaviorProposalConflictError(
          'BehaviorProposal ' + JSON.stringify(parsed.id) + ' already exists.',
        );
      }
      await saveCollectionItem(BEHAVIOR_PROPOSAL_COLLECTION, parsed.id, parsed);
      return parsed;
    },
  );
}

async function mutateProposal(
  proposalId: string,
  mutate: (current: BehaviorProposal) => BehaviorProposal | Promise<BehaviorProposal>,
): Promise<BehaviorProposal> {
  assertSafeCollectionId(proposalId);
  return runInWriteChain(
    'enduring-agent:' + BEHAVIOR_PROPOSAL_COLLECTION + '/' + proposalId,
    async () => {
      const current = await loadProposal(proposalId);
      if (!current) throw new BehaviorProposalNotFoundError(proposalId);
      const next = parseProposal(await mutate(current));
      if (next.id !== current.id || next.personaId !== current.personaId) {
        throw new BehaviorProposalConflictError(
          'A BehaviorProposal update cannot change its identity or Persona owner.',
        );
      }
      await saveCollectionItem(BEHAVIOR_PROPOSAL_COLLECTION, next.id, next);
      return next;
    },
  );
}

export function getBehaviorProposal(proposalId: string): Promise<BehaviorProposal | null> {
  return loadProposal(proposalId);
}

export async function listBehaviorProposals(personaId: string): Promise<BehaviorProposal[]> {
  assertSafeCollectionId(personaId);
  const entries = await listCollectionItemEntriesStrict<unknown>(
    BEHAVIOR_PROPOSAL_COLLECTION,
  );
  return entries
    .map(({ id, item }) => {
      const proposal = parseProposal(item);
      if (proposal.id !== id) {
        throw new BehaviorProposalConflictError(
          'BehaviorProposal storage id ' + JSON.stringify(id) + ' does not match its record.',
        );
      }
      return proposal;
    })
    .filter((proposal) => proposal.personaId === personaId)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export async function createProceduralHint(
  input: CreateProceduralHintInput,
  options: MemoryMutationOptions = {},
): Promise<MemoryItem> {
  if (input.sourceRefs.length === 0) {
    throw new BehaviorProposalConflictError('Procedural hints require evidence.');
  }
  const persona = requirePersona(await getPersona(input.personaId), input.personaId);
  assertCanLearnHint(persona);
  return rememberMemory({
    ...(input.id ? { id: input.id } : {}),
    personaId: input.personaId,
    kind: 'procedural_hint',
    scope: 'persona',
    status: 'candidate',
    content: input.content,
    confidence: input.confidence,
    importance: input.importance,
    sourceRefs: input.sourceRefs,
    trust: input.trust,
  }, options);
}

async function defaultCompileCandidate(spec: unknown): Promise<BehaviorProposalCompileResult> {
  const compiled = await compileSpec(spec, { save: false });
  if (!compiled.success) {
    return {
      success: false,
      errorCount: Math.max(1, compiled.issues?.filter(
        (issue) => issue.severity === 'error',
      ).length ?? 1),
      warningCount: compiled.issues?.filter(
        (issue) => issue.severity === 'warning',
      ).length ?? 0,
      issues: (compiled.issues ?? [{
        severity: 'error',
        code: 'compile-failed',
        message: compiled.error,
      }]).map((issue) => ({
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
      })),
    };
  }
  if (compiled.flows.length !== 1) {
    return {
      success: false,
      errorCount: 1,
      warningCount: compiled.validation.warningCount,
      issues: [{
        severity: 'error',
        code: 'behavior-subflow-dependency-unsupported',
        message: 'Behavior proposals must compile to one standalone Flow snapshot.',
      }],
    };
  }
  return {
    success: true,
    flow: compiled.flow,
    errorCount: compiled.validation.errorCount,
    warningCount: compiled.validation.warningCount,
    issues: compiled.validation.issues.map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
    })),
  };
}

async function evaluateCandidate(
  input: CreateBehaviorProposalInput,
  context: DeterministicBehaviorEvalContext,
): Promise<BehaviorProposalEvalResult[]> {
  const seen = new Set<string>();
  const results: BehaviorProposalEvalResult[] = [];
  for (const evaluation of input.evals) {
    const id = requireText(evaluation.id, 'Eval id');
    if (seen.has(id)) {
      throw new BehaviorProposalConflictError(
        'Duplicate deterministic eval id ' + JSON.stringify(id) + '.',
      );
    }
    seen.add(id);
    try {
      const result = await evaluation.run(context);
      results.push({
        id,
        passed: result.passed,
        ...(result.details?.trim() ? { details: result.details.trim() } : {}),
        candidateContentHash: context.candidateContentHash,
      });
    } catch (error) {
      results.push({
        id,
        passed: false,
        details: 'Eval threw: ' + errorMessage(error),
        candidateContentHash: context.candidateContentHash,
      });
    }
  }
  return results;
}

export async function createBehaviorProposal(
  input: CreateBehaviorProposalInput,
  options: CreateBehaviorProposalOptions = {},
): Promise<BehaviorProposal> {
  if (input.evidenceRefs.length === 0) {
    throw new BehaviorProposalConflictError('Behavior proposals require evidence.');
  }
  if (input.evals.length === 0) {
    throw new BehaviorProposalConflictError(
      'Behavior proposals require at least one deterministic eval.',
    );
  }

  const persona = requirePersona(await getPersona(input.personaId), input.personaId);
  assertCanPropose(persona);
  const binding = await getBehaviorBinding(input.behaviorId);
  if (!binding || binding.personaId !== persona.id) {
    throw new BehaviorProposalConflictError(
      'Behavior binding is missing or owned by another Persona.',
    );
  }
  if (binding.activeRevisionId !== input.baseBehaviorRevisionId) {
    throw new BehaviorProposalConflictError(
      'Behavior proposal base is stale; inspect the active revision and retry.',
    );
  }
  const baseRevision = await getBehaviorRevision(input.baseBehaviorRevisionId);
  if (
    !baseRevision
    || baseRevision.personaId !== persona.id
    || baseRevision.behaviorId !== binding.id
    || baseRevision.slotKey !== binding.slotKey
  ) {
    throw new BehaviorProposalConflictError(
      'Behavior proposal base revision is missing or crosses Persona ownership.',
    );
  }

  const now = Date.now();
  const proposalId = randomEnduringAgentId('proposal');
  const compile = options.compiler ?? defaultCompileCandidate;
  let compiled: BehaviorProposalCompileResult;
  try {
    compiled = await compile(input.candidateSpec);
  } catch (error) {
    compiled = {
      success: false,
      errorCount: 1,
      warningCount: 0,
      issues: [{
        severity: 'error',
        code: 'compile-threw',
        message: errorMessage(error),
      }],
    };
  }

  let candidateFlow: Flow | undefined;
  let candidateContentHash: string | undefined;
  let evalResults: BehaviorProposalEvalResult[] = [];
  if (compiled.success && compiled.flow) {
    try {
      candidateFlow = snapshotBehaviorFlow({
        ...compiled.flow,
        id: stableEnduringAgentId('flow', {
          purpose: 'behavior-proposal-candidate-v1',
          proposalId,
        }),
      });
      candidateContentHash = hashBehaviorFlow(candidateFlow);
      if (compiled.errorCount === 0) {
        evalResults = await evaluateCandidate(input, {
          proposalId,
          persona,
          baseRevision,
          candidateFlow,
          candidateContentHash,
        });
      }
    } catch (error) {
      compiled = {
        success: false,
        errorCount: 1,
        warningCount: compiled.warningCount,
        issues: [
          ...compiled.issues,
          {
            severity: 'error',
            code: 'candidate-snapshot-invalid',
            message: errorMessage(error),
          },
        ],
      };
      candidateFlow = undefined;
      candidateContentHash = undefined;
    }
  }

  const clean = compiled.success
    && Boolean(candidateFlow)
    && compiled.errorCount === 0
    && evalResults.length === input.evals.length
    && evalResults.every((result) => result.passed);
  const actor = input.actor?.trim() || 'behavior-learning';
  const candidateSpecDigest = digest(input.candidateSpec);
  const normalizedEvidence = normalizeMemorySourceRefs(input.evidenceRefs, {
    now,
    digestMaterial: {
      rationale: input.rationale,
      ...(input.changeSummary?.trim() ? { changeSummary: input.changeSummary.trim() } : {}),
      candidateSpecDigest,
    },
  });
  const externallyTaintedEvidence = normalizedEvidence.filter(
    (ref) => ref.producer === 'external_untrusted',
  ).length;
  const evidenceTaint = externallyTaintedEvidence === 0
    ? 'trusted' as const
    : externallyTaintedEvidence === normalizedEvidence.length
      ? 'external_untrusted' as const
      : 'mixed' as const;
  const proposal = BehaviorProposalSchema.parse({
    schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
    id: proposalId,
    personaId: persona.id,
    behaviorId: binding.id,
    slotKey: binding.slotKey,
    baseBehaviorRevisionId: baseRevision.id,
    rationale: requireText(input.rationale, 'Proposal rationale'),
    ...(input.changeSummary?.trim()
      ? { changeSummary: requireText(input.changeSummary, 'Proposal change summary') }
      : {}),
    evidenceRefs: normalizedEvidence,
    provenance: {
      schemaVersion: 1,
      origin: input.origin ?? 'manual',
      ...(input.maintenanceRunId ? { maintenanceRunId: input.maintenanceRunId } : {}),
      ...(input.detectorVersion ? { detectorVersion: input.detectorVersion } : {}),
      ...(input.evaluationSuiteVersion
        ? { evaluationSuiteVersion: input.evaluationSuiteVersion }
        : {}),
      evidenceDigest: digest(normalizedEvidence),
      evidenceTaint,
      diffRiskClass: input.diffRiskClass ?? 'unknown',
      policyDecisionCode: input.policyDecisionCode ?? 'manual_review_required',
    },
    candidateSpecDigest,
    ...(candidateFlow ? { candidateFlow } : {}),
    ...(candidateContentHash ? { candidateContentHash } : {}),
    validation: {
      compileSucceeded: Boolean(candidateFlow),
      errorCount: candidateFlow ? compiled.errorCount : Math.max(1, compiled.errorCount),
      warningCount: compiled.warningCount,
      issues: compiled.issues,
    },
    evalResults,
    status: clean ? 'awaiting_approval' : 'validation_failed',
    auditTrail: [auditEvent(
      clean ? 'proposed' : 'validation_failed',
      actor,
      clean
        ? 'Candidate Flow compiled, validated, and passed every deterministic eval.'
        : 'Candidate Flow failed compilation, validation, or deterministic evals.',
      now,
    )],
    createdAt: now,
    updatedAt: now,
  }) as BehaviorProposal;

  const currentBinding = await getBehaviorBinding(binding.id);
  if (currentBinding?.activeRevisionId !== baseRevision.id) {
    throw new BehaviorProposalConflictError(
      'Behavior binding changed while the proposal was evaluated; retry against the new revision.',
    );
  }

  let saved = await saveNewProposal(proposal);
  if (
    saved.status === 'awaiting_approval'
    && persona.autonomyLevel === 'auto_apply_validated'
    && options.autoApplyPolicy
    && !saved.evidenceRefs.some((ref) => (
      ref.kind === 'tool_result' && ref.producer === 'external_untrusted'
    ))
  ) {
    const decision = await options.autoApplyPolicy({ persona, proposal: saved });
    if (decision.allowed) {
      saved = await approveBehaviorProposalInternal(saved.id, {
        kind: 'policy',
        actor: decision.actor,
        reason: decision.reason,
      });
      saved = await activateBehaviorProposal(saved.id);
    }
  }
  return saved;
}

/**
 * Turn one bounded, plain-language lesson from trusted Persona work into an
 * evaluated Behavior proposal. The candidate only appends an instruction to
 * an existing Process step; it cannot add tools, Apps, nodes, or permissions.
 */
export async function suggestBehaviorInstructionImprovement(
  input: SuggestBehaviorInstructionImprovementInput,
): Promise<BehaviorProposal> {
  const instruction = requireText(input.instruction, 'Reusable instruction');
  const rationale = requireText(input.rationale, 'Improvement rationale');
  const slotKey = requireText(input.slotKey, 'Behavior');
  if (instruction.length > 4_000) {
    throw new BehaviorProposalConflictError(
      'A reusable instruction must be 4,000 characters or fewer.',
    );
  }
  const binding = (await listBehaviorBindings(input.personaId)).find(
    (candidate) => candidate.slotKey === slotKey,
  );
  if (!binding) {
    throw new BehaviorProposalConflictError(
      'The selected Behavior is not available to this Persona.',
    );
  }
  const base = await getBehaviorRevision(binding.activeRevisionId);
  if (!base || base.personaId !== input.personaId) {
    throw new BehaviorProposalConflictError(
      'The selected Behavior has no current version.',
    );
  }

  const candidate = structuredClone(base.flowSnapshot);
  const processNode = candidate.nodes.find((node) => node.type === 'process');
  if (!processNode) {
    throw new BehaviorProposalConflictError(
      'The selected Behavior has no AI work step to improve.',
    );
  }
  const data = processNode.data as typeof processNode.data & {
    properties?: Record<string, unknown> & { promptTemplate?: unknown };
  };
  const properties = data.properties ?? {};
  const existingPrompt = typeof properties.promptTemplate === 'string'
    ? properties.promptTemplate.trim()
    : '';
  if (existingPrompt.includes(instruction)) {
    throw new BehaviorProposalConflictError(
      'This Behavior already includes that improvement.',
    );
  }
  properties.promptTemplate = [
    existingPrompt,
    'Reusable lesson from completed Persona work:',
    instruction,
  ].filter(Boolean).join('\n\n');
  data.properties = properties;

  return createBehaviorProposal({
    personaId: input.personaId,
    behaviorId: binding.id,
    baseBehaviorRevisionId: base.id,
    rationale,
    changeSummary: instruction,
    evidenceRefs: input.evidenceRefs,
    candidateSpec: {
      kind: 'append_process_instruction',
      slotKey,
      instruction,
      baseContentHash: base.contentHash,
    },
    actor: 'persona-self-improvement',
    origin: 'persona_tool',
    diffRiskClass: 'instruction_only',
    policyDecisionCode: 'owner_approval_required',
    evals: [{
      id: 'bounded-instruction-only',
      run: ({ baseRevision, candidateFlow }) => {
        const sameNodes = baseRevision.flowSnapshot.nodes.map((node) => node.id).join('\n')
          === candidateFlow.nodes.map((node) => node.id).join('\n');
        const sameEdges = baseRevision.flowSnapshot.edges.map((edge) => edge.id).join('\n')
          === candidateFlow.edges.map((edge) => edge.id).join('\n');
        const retainedInstruction = JSON.stringify(candidateFlow).includes(instruction);
        return {
          passed: sameNodes && sameEdges && retainedInstruction,
          details: sameNodes && sameEdges && retainedInstruction
            ? 'Only one existing Process instruction changed; graph authority stayed the same.'
            : 'The candidate changed more than the reviewed Process instruction.',
        };
      },
    }],
  }, {
    compiler: async () => {
      const validation = await validateFlowObjectForRun(candidate);
      return {
        success: validation.isRunnable,
        ...(validation.isRunnable ? { flow: candidate } : {}),
        errorCount: validation.errorCount,
        warningCount: validation.warningCount,
        issues: validation.issues.map((issue) => ({
          severity: issue.severity,
          code: issue.code,
          message: issue.message,
        })),
      };
    },
  });
}

async function approveBehaviorProposalInternal(
  proposalId: string,
  input: ApproveBehaviorProposalInput & { kind: 'manual' | 'policy' },
): Promise<BehaviorProposal> {
  return mutateProposal(proposalId, async (proposal) => {
    if (proposal.status === 'approved' || proposal.status === 'activated') return proposal;
    if (proposal.status !== 'awaiting_approval') {
      throw new BehaviorLearningPolicyError(
        'Only a clean proposal awaiting approval may be approved.',
      );
    }
    const persona = requirePersona(await getPersona(proposal.personaId), proposal.personaId);
    assertCanPropose(persona);
    if (input.kind === 'policy' && persona.autonomyLevel !== 'auto_apply_validated') {
      throw new BehaviorLearningPolicyError(
        'Policy approval requires auto_apply_validated autonomy.',
      );
    }
    const now = Date.now();
    return {
      ...proposal,
      status: 'approved',
      approval: {
        kind: input.kind,
        actor: requireText(input.actor, 'Approval actor'),
        reason: requireText(input.reason, 'Approval reason'),
        approvedAt: now,
      },
      auditTrail: [
        ...proposal.auditTrail,
        auditEvent(
          input.kind === 'policy' ? 'auto_approved' : 'approved',
          input.actor,
          input.reason,
          now,
        ),
      ],
      updatedAt: now,
    };
  });
}

export function approveBehaviorProposal(
  proposalId: string,
  input: ApproveBehaviorProposalInput,
): Promise<BehaviorProposal> {
  return approveBehaviorProposalInternal(proposalId, { ...input, kind: 'manual' });
}

/** Record a durable human decision to leave a proposed change unapplied. */
export function rejectBehaviorProposal(
  proposalId: string,
  input: ApproveBehaviorProposalInput,
): Promise<BehaviorProposal> {
  return mutateProposal(proposalId, (proposal) => {
    if (proposal.status === 'rejected') return proposal;
    if (proposal.status === 'activated' || proposal.status === 'rolled_back') {
      throw new BehaviorLearningPolicyError(
        'An applied Behavior improvement must be undone instead of rejected.',
      );
    }
    const now = Date.now();
    return {
      ...proposal,
      status: 'rejected',
      auditTrail: [
        ...proposal.auditTrail,
        auditEvent('rejected', input.actor, input.reason, now),
      ],
      updatedAt: now,
    };
  });
}

async function revisionForProposal(proposal: BehaviorProposal) {
  const existing = (await listBehaviorRevisions(proposal.personaId)).find(
    (revision) => revision.behaviorId === proposal.behaviorId
      && revision.source.kind === 'persona_override'
      && revision.source.evidenceRefs?.includes(proposal.id),
  );
  if (existing) return existing;
  if (!proposal.candidateFlow || !proposal.candidateContentHash) {
    throw new BehaviorProposalConflictError('Proposal has no validated candidate Flow.');
  }

  const revisions = (await listBehaviorRevisions(proposal.personaId))
    .filter((revision) => revision.behaviorId === proposal.behaviorId);
  const ordinal = Math.max(0, ...revisions.map((revision) => revision.revision)) + 1;
  const contentHash = hashBehaviorFlow(proposal.candidateFlow);
  if (contentHash !== proposal.candidateContentHash) {
    throw new BehaviorProposalConflictError(
      'Proposal candidate Flow no longer matches its audit hash.',
    );
  }
  return createBehaviorRevision(BehaviorRevisionSchema.parse({
    schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
    id: behaviorRevisionId({
      personaId: proposal.personaId,
      behaviorId: proposal.behaviorId,
      revision: ordinal,
      contentHash,
    }),
    behaviorId: proposal.behaviorId,
    personaId: proposal.personaId,
    slotKey: proposal.slotKey,
    revision: ordinal,
    contentHash,
    flowSnapshot: proposal.candidateFlow,
    source: {
      kind: 'persona_override',
      parentRevisionId: proposal.baseBehaviorRevisionId,
      evidenceRefs: [
        proposal.id,
        ...proposal.evidenceRefs.map((ref) => ref.id),
      ],
    },
    createdAt: proposal.createdAt,
  }));
}

export async function activateBehaviorProposal(proposalId: string): Promise<BehaviorProposal> {
  const proposal = await loadProposal(proposalId);
  if (!proposal) throw new BehaviorProposalNotFoundError(proposalId);
  if (proposal.status === 'activated') return proposal;
  if (proposal.status !== 'approved' || !proposal.approval) {
    throw new BehaviorLearningPolicyError(
      'Behavior activation requires a clean proposal and an approval gate decision.',
    );
  }
  const persona = requirePersona(await getPersona(proposal.personaId), proposal.personaId);
  assertCanPropose(persona);
  const revision = await revisionForProposal(proposal);
  const binding = await getBehaviorBinding(proposal.behaviorId);
  if (!binding || binding.personaId !== proposal.personaId) {
    throw new BehaviorProposalConflictError('Behavior binding is missing or foreign.');
  }
  if (binding.activeRevisionId !== revision.id) {
    try {
      await activateBehaviorBindingRevision({
        personaId: proposal.personaId,
        behaviorId: proposal.behaviorId,
        revisionId: revision.id,
        expectedActiveRevisionId: proposal.baseBehaviorRevisionId,
      });
    } catch (error) {
      const currentBinding = await getBehaviorBinding(proposal.behaviorId);
      if (currentBinding?.activeRevisionId !== revision.id) throw error;
    }
  }
  const now = Date.now();
  const activated = await mutateProposal(proposal.id, (current) => {
    if (current.status === 'activated') return current;
    if (current.status !== 'approved') {
      throw new BehaviorProposalConflictError(
        'Behavior proposal status changed while its revision was activated.',
      );
    }
    return {
      ...current,
      status: 'activated',
      activatedRevisionId: revision.id,
      auditTrail: [
        ...current.auditTrail,
        auditEvent(
          'activated',
          current.approval?.actor ?? 'behavior-learning',
          'Activated the approved immutable Persona-only Behavior revision.',
          now,
          { revisionId: revision.id },
        ),
      ],
      updatedAt: now,
    };
  });
  // Outcome measurement is observability, never part of the activation
  // contract. A failure here degrades to "no metric", which simply means the
  // regression detector never fires for this proposal (issue #455).
  try {
    const { snapshotBehaviorOutcomeBaseline } = await import('./behaviorOutcome');
    await snapshotBehaviorOutcomeBaseline(activated);
  } catch (error) {
    log.warn(
      'Failed to snapshot the outcome baseline for Behavior proposal '
      + JSON.stringify(activated.id) + ':',
      error,
    );
  }
  return activated;
}

export interface RollbackBehaviorProposalOptions {
  /**
   * Audit action recorded for this revert. Defaults to the human
   * `rolled_back`; the outcome detector passes `auto_rolled_back` so the UI
   * never has to parse actor strings to explain an automatic revert.
   */
  auditAction?: 'rolled_back' | 'auto_rolled_back';
}

export async function rollbackBehaviorProposal(
  proposalId: string,
  input: ApproveBehaviorProposalInput,
  options: RollbackBehaviorProposalOptions = {},
): Promise<BehaviorProposal> {
  const proposal = await loadProposal(proposalId);
  if (!proposal) throw new BehaviorProposalNotFoundError(proposalId);
  if (proposal.status === 'rolled_back') return proposal;
  if (proposal.status !== 'activated' || !proposal.activatedRevisionId) {
    throw new BehaviorLearningPolicyError('Only an activated Behavior proposal can be rolled back.');
  }
  const binding = await getBehaviorBinding(proposal.behaviorId);
  if (!binding || binding.personaId !== proposal.personaId) {
    throw new BehaviorProposalConflictError('Behavior binding is missing or foreign.');
  }
  if (binding.activeRevisionId !== proposal.baseBehaviorRevisionId) {
    await activateBehaviorBindingRevision({
      personaId: proposal.personaId,
      behaviorId: proposal.behaviorId,
      revisionId: proposal.baseBehaviorRevisionId,
      expectedActiveRevisionId: proposal.activatedRevisionId,
    });
  }
  const now = Date.now();
  return mutateProposal(proposal.id, (current) => {
    if (current.status === 'rolled_back') return current;
    if (current.status !== 'activated') {
      throw new BehaviorProposalConflictError(
        'Behavior proposal status changed while its revision was rolled back.',
      );
    }
    return {
      ...current,
      status: 'rolled_back',
      rollbackRevisionId: current.baseBehaviorRevisionId,
      auditTrail: [
        ...current.auditTrail,
        auditEvent(
          options.auditAction ?? 'rolled_back',
          input.actor,
          input.reason,
          now,
          { revisionId: current.baseBehaviorRevisionId },
        ),
      ],
      updatedAt: now,
    };
  });
}

async function promotedRoleVersion(
  proposal: BehaviorProposal,
  input: PromoteBehaviorProposalInput,
): Promise<RoleVersion> {
  const stableId = stableEnduringAgentId('rolever', {
    purpose: 'behavior-proposal-promotion-v1',
    proposalId: proposal.id,
  });
  const existing = await getRoleVersion(stableId);
  if (existing) {
    const requestedName = input.name?.trim();
    if (
      existing.migrationNotes !== input.migrationNotes.trim()
      || (requestedName && existing.name !== requestedName)
    ) {
      throw new BehaviorProposalConflictError(
        'Role promotion retry changed its reviewed name or migration notes.',
      );
    }
    return existing;
  }

  const persona = requirePersona(await getPersona(proposal.personaId), proposal.personaId);
  const source = await getRoleVersion(persona.roleVersionId);
  if (!source) {
    throw new BehaviorProposalConflictError('Persona pinned RoleVersion is missing.');
  }
  const slot = source.behaviorSlots.find((candidate) => candidate.key === proposal.slotKey);
  if (!slot || !proposal.candidateFlow) {
    throw new BehaviorProposalConflictError('Proposal does not map to a Role behavior slot.');
  }
  const versions = await listRoleVersions(source.roleDefinitionId);
  const version = Math.max(0, ...versions.map((candidate) => candidate.version)) + 1;
  const templateFlow = snapshotBehaviorFlow({
    ...proposal.candidateFlow,
    id: stableEnduringAgentId('flow', {
      purpose: 'promoted-role-template-v1',
      roleVersionId: stableId,
      slotKey: proposal.slotKey,
    }),
    name: slot.flowTemplate.name,
  });
  return createRoleVersion(RoleVersionSchema.parse({
    ...source,
    id: stableId,
    version,
    name: input.name?.trim() || source.name + ' v' + version,
    behaviorSlots: source.behaviorSlots.map((candidate) => (
      candidate.key === proposal.slotKey
        ? { ...candidate, flowTemplate: templateFlow }
        : candidate
    )),
    migrationNotes: requireText(input.migrationNotes, 'Promotion migration notes'),
    createdAt: Math.max(source.createdAt + 1, proposal.createdAt),
  }));
}

export async function promoteBehaviorProposalToRoleVersion(
  proposalId: string,
  input: PromoteBehaviorProposalInput,
): Promise<RoleVersion> {
  if (input.confirmation !== 'PROMOTE') {
    throw new BehaviorLearningPolicyError('Role promotion requires explicit PROMOTE confirmation.');
  }
  let proposal = await loadProposal(proposalId);
  if (!proposal) throw new BehaviorProposalNotFoundError(proposalId);
  if (proposal.status !== 'activated') {
    throw new BehaviorLearningPolicyError(
      'A proposal must be activated and observed on its Persona before Role promotion.',
    );
  }
  if (proposal.promotedRoleVersionId) {
    const existing = await getRoleVersion(proposal.promotedRoleVersionId);
    if (!existing) {
      throw new BehaviorProposalConflictError('Promoted RoleVersion audit reference is missing.');
    }
    const requestedName = input.name?.trim();
    if (
      existing.migrationNotes !== input.migrationNotes.trim()
      || (requestedName && existing.name !== requestedName)
    ) {
      throw new BehaviorProposalConflictError(
        'Role promotion retry changed its reviewed name or migration notes.',
      );
    }
    return existing;
  }

  const roleVersion = await promotedRoleVersion(proposal, input);
  const now = Date.now();
  proposal = await mutateProposal(proposal.id, (current) => ({
    ...current,
    promotedRoleVersionId: roleVersion.id,
    auditTrail: [
      ...current.auditTrail,
      auditEvent(
        'promoted_to_role',
        input.actor,
        input.migrationNotes,
        now,
        { roleVersionId: roleVersion.id },
      ),
    ],
    updatedAt: now,
  }));
  return roleVersion;
}
