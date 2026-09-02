export const PERSONA_SOAK_EVIDENCE_SCHEMA_VERSION = 1 as const;

export const SOAK_CRITERION_REGISTRY = {
  'unattended-runtime-throughput': {
    requiredInAcceptance: true,
    requiredInSmoke: true,
  },
  'persisted-workload-reconciliation': {
    requiredInAcceptance: true,
    requiredInSmoke: true,
  },
  'scheduled-fault-recovery': {
    requiredInAcceptance: true,
    requiredInSmoke: false,
  },
  'recall-precision-stability': {
    requiredInAcceptance: true,
    requiredInSmoke: true,
  },
  'runtime-scale-recall-latency': {
    requiredInAcceptance: true,
    requiredInSmoke: true,
  },
  'bounded-detailed-runtime-state': {
    requiredInAcceptance: true,
    requiredInSmoke: false,
  },
  'flat-event-append-cost': {
    requiredInAcceptance: true,
    requiredInSmoke: false,
  },
  'runtime-event-continuity': {
    requiredInAcceptance: true,
    requiredInSmoke: true,
  },
  'zero-split-brain': {
    requiredInAcceptance: true,
    requiredInSmoke: true,
  },
  'zero-stranded-or-stuck': {
    requiredInAcceptance: true,
    requiredInSmoke: true,
  },
  'resident-memory-bound': {
    requiredInAcceptance: true,
    requiredInSmoke: false,
  },
  'learning-auto-rollback': {
    requiredInAcceptance: true,
    requiredInSmoke: false,
  },
  'os-process-hard-crash-recovery': {
    requiredInAcceptance: true,
    requiredInSmoke: false,
  },
} as const;

export type SoakCriterionId = keyof typeof SOAK_CRITERION_REGISTRY;
export type SoakRunMode = 'smoke' | 'acceptance';
export type SoakCriterionStatus = 'passed' | 'failed' | 'not_evaluated';
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface SoakRunIdentity {
  schemaVersion: typeof PERSONA_SOAK_EVIDENCE_SCHEMA_VERSION;
  runId: string;
  mode: SoakRunMode;
  authoritative: boolean;
  commitSha: string;
  seed: number;
  days: number;
  activitiesPerDay: number;
  learningEnabled: boolean;
  startedAt: string;
  endedAt: string;
  runner: {
    node: string;
    platform: string;
    architecture: string;
    osRelease: string;
    cpuModel: string;
    logicalCpuCount: number;
  };
  configuration: {
    gatingMode: 'enforce' | 'warn' | 'report';
    recallSamplesPerDay: number;
    eventAppendSamplesPerDay: number;
    percentileMethod: 'nearest-rank';
    scheduledFaultIds: string[];
  };
}

export interface SoakCriterionResult {
  id: SoakCriterionId;
  required: boolean;
  status: SoakCriterionStatus;
  summary: string;
  observed: JsonObject;
  threshold: {
    description: string;
    source: string;
  };
  provenance: {
    sources: string[];
    recordIds?: string[];
  };
  failureReason?: string;
}

export interface SoakFaultEvidence {
  id: string;
  day: number;
  kind: string;
  status: SoakCriterionStatus;
  before: JsonObject;
  fault: JsonObject;
  after: JsonObject;
  provenance: string[];
  failureReason?: string;
}

export interface WorkloadReconciliationEvidence {
  attempted: number;
  accepted: number;
  completed: number;
  failed: number;
  duplicate: number;
  unresolved: number;
  missingSourceIds: string[];
  duplicateSourceIds: string[];
  nonterminalSourceIds: string[];
  mailboxLinkMismatchSourceIds: string[];
  identityMismatchSourceIds: string[];
}

export interface LearningRollbackEvidence {
  evaluated: boolean;
  personaId?: string;
  behaviorId?: string;
  proposalId?: string;
  metricId?: string;
  baseRevisionId?: string;
  activatedRevisionId?: string;
  finalRevisionId?: string;
  proposalStatus?: string;
  metricVerdict?: string;
  baselineSamples: number;
  regressionSamples: number;
  autoRollbackAt?: number;
}

export interface SoakEvidenceDocument {
  schemaVersion: typeof PERSONA_SOAK_EVIDENCE_SCHEMA_VERSION;
  runIdentity: SoakRunIdentity;
  workloadReconciliation: WorkloadReconciliationEvidence;
  faultEvidence: SoakFaultEvidence[];
  criteria: SoakCriterionResult[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyJsonValues(value: unknown): boolean {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(hasOnlyJsonValues);
  if (isObject(value)) return Object.values(value).every(hasOnlyJsonValues);
  return false;
}

export function criterionRequired(id: SoakCriterionId, mode: SoakRunMode): boolean {
  const policy = SOAK_CRITERION_REGISTRY[id];
  return mode === 'acceptance' ? policy.requiredInAcceptance : policy.requiredInSmoke;
}

export function createSoakCriterion(input: Omit<SoakCriterionResult, 'required'> & {
  mode: SoakRunMode;
}): SoakCriterionResult {
  const { mode, ...criterion } = input;
  return {
    ...criterion,
    required: criterionRequired(criterion.id, mode),
  };
}

export function validateSoakCriterion(
  value: unknown,
  mode: SoakRunMode,
): string[] {
  if (!isObject(value)) return ['criterion must be an object'];
  const errors: string[] = [];
  const id = value.id;
  if (typeof id !== 'string' || !(id in SOAK_CRITERION_REGISTRY)) {
    errors.push('criterion id is missing or unknown');
  }
  if (!['passed', 'failed', 'not_evaluated'].includes(String(value.status))) {
    errors.push('criterion status is invalid');
  }
  if (typeof value.required !== 'boolean') {
    errors.push('criterion required policy is missing');
  } else if (
    typeof id === 'string'
    && id in SOAK_CRITERION_REGISTRY
    && value.required !== criterionRequired(id as SoakCriterionId, mode)
  ) {
    errors.push('criterion required policy does not match the registry');
  }
  if (typeof value.summary !== 'string' || value.summary.length === 0) {
    errors.push('criterion summary is missing');
  }
  if (!isObject(value.observed) || !hasOnlyJsonValues(value.observed)) {
    errors.push('criterion observed values are malformed');
  }
  if (
    !isObject(value.threshold)
    || typeof value.threshold.description !== 'string'
    || value.threshold.description.length === 0
    || typeof value.threshold.source !== 'string'
    || value.threshold.source.length === 0
  ) {
    errors.push('criterion threshold is malformed');
  }
  if (
    !isObject(value.provenance)
    || !Array.isArray(value.provenance.sources)
    || value.provenance.sources.length === 0
    || value.provenance.sources.some(source => typeof source !== 'string' || source.length === 0)
  ) {
    errors.push('criterion provenance is malformed');
  }
  if (
    value.status !== 'passed'
    && (typeof value.failureReason !== 'string' || value.failureReason.length === 0)
  ) {
    errors.push('non-passing criterion must include a failure reason');
  }
  return errors;
}

export function validateSoakEvidence(document: SoakEvidenceDocument): string[] {
  const errors: string[] = [];
  if (document.schemaVersion !== PERSONA_SOAK_EVIDENCE_SCHEMA_VERSION) {
    errors.push('unsupported soak evidence schema version');
  }
  const identity = document.runIdentity;
  if (!identity || identity.schemaVersion !== PERSONA_SOAK_EVIDENCE_SCHEMA_VERSION) {
    errors.push('run identity is missing or malformed');
    return errors;
  }
  if (!identity.runId || !identity.commitSha) {
    errors.push('run identity is missing runId or commitSha');
  }
  if (!['smoke', 'acceptance'].includes(identity.mode)) {
    errors.push('run identity mode is invalid');
  }
  if (identity.mode === 'smoke' && identity.authoritative) {
    errors.push('smoke run identity cannot be authoritative');
  }
  if (
    identity.mode === 'acceptance'
    && (
      !identity.authoritative
      || identity.commitSha === 'unreported'
      || identity.days !== 28
      || identity.activitiesPerDay !== 20
      || !identity.learningEnabled
    )
  ) {
    errors.push('acceptance run identity does not match the authoritative 28x20 contract');
  }
  if (
    !Number.isSafeInteger(identity.seed)
    || !Number.isSafeInteger(identity.days)
    || !Number.isSafeInteger(identity.activitiesPerDay)
    || identity.days <= 0
    || identity.activitiesPerDay <= 0
  ) {
    errors.push('run identity workload configuration is invalid');
  }
  if (
    !identity.runner
    || !identity.runner.node
    || !identity.runner.platform
    || !identity.runner.architecture
    || !identity.runner.osRelease
    || !identity.runner.cpuModel
    || !Number.isSafeInteger(identity.runner.logicalCpuCount)
    || identity.runner.logicalCpuCount <= 0
  ) {
    errors.push('run identity runner provenance is invalid');
  }
  if (
    !identity.startedAt
    || !identity.endedAt
    || Number.isNaN(Date.parse(identity.startedAt))
    || Number.isNaN(Date.parse(identity.endedAt))
    || Date.parse(identity.endedAt) < Date.parse(identity.startedAt)
  ) {
    errors.push('run identity timestamps are invalid');
  }
  const configuration = identity.configuration;
  if (
    !configuration
    || !['enforce', 'warn', 'report'].includes(configuration.gatingMode)
    || !Number.isSafeInteger(configuration.recallSamplesPerDay)
    || configuration.recallSamplesPerDay <= 0
    || !Number.isSafeInteger(configuration.eventAppendSamplesPerDay)
    || configuration.eventAppendSamplesPerDay <= 0
    || configuration.percentileMethod !== 'nearest-rank'
    || !Array.isArray(configuration.scheduledFaultIds)
    || configuration.scheduledFaultIds.some(id => typeof id !== 'string' || id.length === 0)
    || new Set(configuration.scheduledFaultIds).size !== configuration.scheduledFaultIds.length
  ) {
    errors.push('run identity evidence configuration is invalid');
  }

  const reconciliation = document.workloadReconciliation;
  if (
    !reconciliation
    || !Number.isSafeInteger(reconciliation.attempted)
    || !Number.isSafeInteger(reconciliation.accepted)
    || !Number.isSafeInteger(reconciliation.completed)
    || !Number.isSafeInteger(reconciliation.failed)
    || !Number.isSafeInteger(reconciliation.duplicate)
    || !Number.isSafeInteger(reconciliation.unresolved)
    || reconciliation.attempted < 0
    || reconciliation.accepted < 0
    || reconciliation.completed < 0
    || reconciliation.failed < 0
    || reconciliation.duplicate < 0
    || reconciliation.unresolved < 0
    || reconciliation.accepted > reconciliation.attempted
    || reconciliation.completed > reconciliation.attempted
    || !Array.isArray(reconciliation.missingSourceIds)
    || reconciliation.missingSourceIds.some(id => typeof id !== 'string' || id.length === 0)
    || !Array.isArray(reconciliation.duplicateSourceIds)
    || reconciliation.duplicateSourceIds.some(id => typeof id !== 'string' || id.length === 0)
    || !Array.isArray(reconciliation.nonterminalSourceIds)
    || reconciliation.nonterminalSourceIds.some(id => typeof id !== 'string' || id.length === 0)
    || !Array.isArray(reconciliation.mailboxLinkMismatchSourceIds)
    || reconciliation.mailboxLinkMismatchSourceIds.some(
      id => typeof id !== 'string' || id.length === 0,
    )
    || !Array.isArray(reconciliation.identityMismatchSourceIds)
    || reconciliation.identityMismatchSourceIds.some(
      id => typeof id !== 'string' || id.length === 0,
    )
  ) {
    errors.push('workload reconciliation evidence is malformed');
  }

  if (!Array.isArray(document.faultEvidence)) {
    errors.push('fault evidence must be an array');
  } else {
    const faultIds = new Set<string>();
    for (const fault of document.faultEvidence) {
      if (!fault.id || faultIds.has(fault.id)) errors.push(`invalid or duplicate fault id: ${fault.id}`);
      faultIds.add(fault.id);
      if (!['passed', 'failed', 'not_evaluated'].includes(fault.status)) {
        errors.push(`${fault.id}: invalid fault status`);
      }
      if (
        !hasOnlyJsonValues(fault.before)
        || !hasOnlyJsonValues(fault.fault)
        || !hasOnlyJsonValues(fault.after)
        || !Array.isArray(fault.provenance)
        || fault.provenance.length === 0
        || fault.provenance.some(source => typeof source !== 'string' || source.length === 0)
      ) {
        errors.push(`${fault.id}: malformed before/fault/after provenance`);
      }
      if (
        fault.status === 'passed'
        && ('captureError' in fault.before || 'captureError' in fault.after)
      ) {
        errors.push(`${fault.id}: passed fault contains a snapshot capture error`);
      }
      if (
        fault.status !== 'passed'
        && (typeof fault.failureReason !== 'string' || fault.failureReason.length === 0)
      ) {
        errors.push(`${fault.id}: non-passing fault has no failure reason`);
      }
    }
    const expectedFaultIds = identity.configuration?.scheduledFaultIds ?? [];
    const actualFaultIds = document.faultEvidence.map(fault => fault.id);
    const missingFaultIds = expectedFaultIds.filter(id => !actualFaultIds.includes(id));
    const unexpectedFaultIds = actualFaultIds.filter(id => !expectedFaultIds.includes(id));
    if (missingFaultIds.length > 0 || unexpectedFaultIds.length > 0) {
      errors.push(
        `fault evidence does not match the scheduled matrix (missing=${missingFaultIds.join(',')}; unexpected=${unexpectedFaultIds.join(',')})`,
      );
    }
  }

  if (!Array.isArray(document.criteria)) {
    errors.push('criteria must be an array');
    return errors;
  }
  const expectedIds = Object.keys(SOAK_CRITERION_REGISTRY) as SoakCriterionId[];
  const seen = new Set<string>();
  for (const criterion of document.criteria) {
    const id = isObject(criterion) && typeof criterion.id === 'string'
      ? criterion.id
      : '<unknown>';
    if (seen.has(id)) errors.push(`duplicate criterion: ${id}`);
    seen.add(id);
    for (const error of validateSoakCriterion(criterion, identity.mode)) {
      errors.push(`${id}: ${error}`);
    }
  }
  for (const id of expectedIds) {
    if (!seen.has(id)) errors.push(`missing criterion: ${id}`);
  }
  if (document.criteria.length !== expectedIds.length) {
    errors.push('criterion count does not match the registry');
  }
  const workloadCriterion = document.criteria.find(
    criterion => criterion.id === 'persisted-workload-reconciliation',
  );
  if (
    workloadCriterion?.status === 'passed'
    && (
      reconciliation?.accepted !== reconciliation?.attempted
      || reconciliation?.completed !== reconciliation?.attempted
      || reconciliation?.failed !== 0
      || reconciliation?.duplicate !== 0
      || reconciliation?.unresolved !== 0
      || reconciliation?.missingSourceIds?.length !== 0
      || reconciliation?.duplicateSourceIds?.length !== 0
      || reconciliation?.nonterminalSourceIds?.length !== 0
      || reconciliation?.mailboxLinkMismatchSourceIds?.length !== 0
      || reconciliation?.identityMismatchSourceIds?.length !== 0
    )
  ) {
    errors.push('passed workload criterion conflicts with reconciliation evidence');
  }
  const faultCriterion = document.criteria.find(
    criterion => criterion.id === 'scheduled-fault-recovery',
  );
  if (
    faultCriterion?.status === 'passed'
    && Array.isArray(document.faultEvidence)
    && document.faultEvidence.some(fault => fault.status !== 'passed')
  ) {
    errors.push('passed fault criterion conflicts with non-passing fault evidence');
  }
  return errors;
}

export function soakEnforcementFailures(document: SoakEvidenceDocument): string[] {
  const errors = validateSoakEvidence(document);
  for (const criterion of document.criteria ?? []) {
    if (criterion.required && criterion.status !== 'passed') {
      errors.push(
        `required criterion ${criterion.id} is ${criterion.status}: ${criterion.failureReason ?? criterion.summary}`,
      );
    }
  }
  return errors;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter(key => value[key] !== undefined)
        .map(key => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableJsonStringify(value: unknown, space?: number): string {
  const serialized = JSON.stringify(stableValue(value), null, space);
  if (serialized === undefined) throw new Error('Value is not JSON serializable.');
  return serialized;
}
