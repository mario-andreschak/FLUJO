import { promises as fs } from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const CRITERION_IDS = [
  'unattended-runtime-throughput',
  'persisted-workload-reconciliation',
  'scheduled-fault-recovery',
  'recall-precision-stability',
  'runtime-scale-recall-latency',
  'bounded-detailed-runtime-state',
  'flat-event-append-cost',
  'runtime-event-continuity',
  'zero-split-brain',
  'zero-stranded-or-stuck',
  'resident-memory-bound',
  'learning-auto-rollback',
  'os-process-hard-crash-recovery',
];

const SMOKE_REQUIRED_IDS = new Set([
  'unattended-runtime-throughput',
  'persisted-workload-reconciliation',
  'recall-precision-stability',
  'runtime-scale-recall-latency',
  'runtime-event-continuity',
  'zero-split-brain',
  'zero-stranded-or-stuck',
]);

const UNDEFINED_CONTRACT_IDS = new Set([
  'bounded-detailed-runtime-state', 'flat-event-append-cost', 'resident-memory-bound',
]);

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unknown argument: ${argument}`);
    const equals = argument.indexOf('=');
    if (equals >= 0) {
      values.set(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      values.set(key, '1');
    } else {
      values.set(key, value);
      index += 1;
    }
  }
  return values;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyJsonValues(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(hasOnlyJsonValues);
  if (isObject(value)) return Object.values(value).every(hasOnlyJsonValues);
  return false;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableStringify(value, space) {
  return JSON.stringify(stableValue(value), null, space);
}

async function readRequired(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`Required soak artifact is missing: ${file} (${error.message})`);
  }
}

function validateCriterion(criterion, mode, errors) {
  if (!isObject(criterion)) {
    errors.push('criterion record is not an object');
    return;
  }
  if (!CRITERION_IDS.includes(criterion.id)) {
    errors.push(`unknown criterion id: ${criterion.id}`);
  }
  if (!['passed', 'failed', 'not_evaluated'].includes(criterion.status)) {
    errors.push(`${criterion.id}: invalid status`);
  }
  const expectedRequired = mode === 'acceptance'
    || (mode === 'infrastructure' ? !UNDEFINED_CONTRACT_IDS.has(criterion.id) : SMOKE_REQUIRED_IDS.has(criterion.id));
  if (typeof criterion.required !== 'boolean') {
    errors.push(`${criterion.id}: required policy is missing`);
  } else if (criterion.required !== expectedRequired) {
    errors.push(`${criterion.id}: required policy does not match the registry`);
  }
  if (typeof criterion.summary !== 'string' || criterion.summary.length === 0) {
    errors.push(`${criterion.id}: summary is missing`);
  }
  if (!isObject(criterion.observed) || !hasOnlyJsonValues(criterion.observed)) {
    errors.push(`${criterion.id}: observed values are malformed`);
  }
  if (
    !isObject(criterion.threshold)
    || typeof criterion.threshold.description !== 'string'
    || criterion.threshold.description.length === 0
    || typeof criterion.threshold.source !== 'string'
    || criterion.threshold.source.length === 0
  ) {
    errors.push(`${criterion.id}: threshold contract is malformed`);
  }
  if (
    !isObject(criterion.provenance)
    || !Array.isArray(criterion.provenance.sources)
    || criterion.provenance.sources.length === 0
    || criterion.provenance.sources.some(
      source => typeof source !== 'string' || source.length === 0,
    )
    || (criterion.provenance.recordIds !== undefined
      && (!Array.isArray(criterion.provenance.recordIds)
        || criterion.provenance.recordIds.some(
          recordId => typeof recordId !== 'string' || recordId.length === 0,
        )))
  ) {
    errors.push(`${criterion.id}: provenance is malformed`);
  }
  if (
    criterion.status !== 'passed'
    && (typeof criterion.failureReason !== 'string' || criterion.failureReason.length === 0)
  ) {
    errors.push(`${criterion.id}: non-passing record has no failure reason`);
  }
  if (criterion.required && criterion.status !== 'passed') {
    errors.push(`${criterion.id}: required criterion is ${criterion.status}`);
  }
}

export async function validatePersonaSoakArtifacts({
  directory,
  expectedCommit,
  expectedMode,
}) {
  const errors = [];
  const jsonPath = path.join(directory, 'persona-soak.json');
  const jsonlPath = path.join(directory, 'persona-soak.jsonl');
  const markdownPath = path.join(directory, 'persona-soak.md');
  const [jsonText, jsonlText, markdown] = await Promise.all([
    readRequired(jsonPath),
    readRequired(jsonlPath),
    readRequired(markdownPath),
  ]);

  let report;
  try {
    report = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`persona-soak.json is malformed: ${error.message}`);
  }
  if (jsonText !== `${stableStringify(report, 2)}\n`) {
    errors.push('persona-soak.json is not in deterministic canonical form');
  }
  if (report.schemaVersion !== 1 || report.runIdentity?.schemaVersion !== 1) {
    errors.push('unsupported or missing evidence schema version');
  }
  const identity = report.runIdentity;
  if (!isObject(identity)) {
    errors.push('run identity is missing');
  } else {
    if (identity.commitSha !== expectedCommit) {
      errors.push(`commit mismatch: expected ${expectedCommit}, observed ${identity.commitSha}`);
    }
    if (identity.mode !== expectedMode) {
      errors.push(`mode mismatch: expected ${expectedMode}, observed ${identity.mode}`);
    }
    if (
      !identity.runId
      || !identity.startedAt
      || !identity.endedAt
      || Number.isNaN(Date.parse(identity.startedAt))
      || Number.isNaN(Date.parse(identity.endedAt))
      || Date.parse(identity.endedAt) < Date.parse(identity.startedAt)
    ) {
      errors.push('run identity is missing IDs or has invalid timestamps');
    }
    if (
      !isObject(identity.runner)
      || typeof identity.runner.node !== 'string'
      || typeof identity.runner.platform !== 'string'
      || typeof identity.runner.architecture !== 'string'
      || typeof identity.runner.osRelease !== 'string'
      || typeof identity.runner.cpuModel !== 'string'
      || !Number.isInteger(identity.runner.logicalCpuCount)
      || identity.runner.logicalCpuCount <= 0
    ) {
      errors.push('run identity runner provenance is malformed');
    }
    const configuration = identity.configuration;
    if (
      !isObject(configuration)
      || !['enforce', 'warn', 'report'].includes(configuration.gatingMode)
      || !Number.isInteger(configuration.recallSamplesPerDay)
      || configuration.recallSamplesPerDay <= 0
      || !Number.isInteger(configuration.eventAppendSamplesPerDay)
      || configuration.eventAppendSamplesPerDay <= 0
      || configuration.percentileMethod !== 'nearest-rank'
      || !Array.isArray(configuration.scheduledFaultIds)
      || configuration.scheduledFaultIds.some(
        id => typeof id !== 'string' || id.length === 0,
      )
      || new Set(configuration.scheduledFaultIds).size
        !== configuration.scheduledFaultIds.length
    ) {
      errors.push('run identity evidence configuration is malformed');
    }
    if (expectedMode === 'acceptance') {
      if (
        identity.authoritative !== true
        || identity.days !== 28
        || identity.activitiesPerDay !== 20
        || identity.learningEnabled !== true
      ) {
        errors.push('acceptance identity is not the authoritative 28x20 learning configuration');
      }
    } else if (identity.authoritative !== false) {
      errors.push('infrastructure and smoke evidence must be non-authoritative');
    }
    if (expectedMode === 'infrastructure' && (identity.days !== 28 || identity.activitiesPerDay !== 20 || identity.learningEnabled !== true)) {
      errors.push('infrastructure identity requires the full 28x20 learning configuration');
    }
  }

  if (!Array.isArray(report.criteria)) {
    errors.push('criteria array is missing');
  } else {
    const ids = report.criteria.map(criterion => criterion?.id);
    for (const id of CRITERION_IDS) {
      if (!ids.includes(id)) errors.push(`missing criterion: ${id}`);
    }
    if (new Set(ids).size !== ids.length) errors.push('criterion IDs are duplicated');
    if (ids.length !== CRITERION_IDS.length) errors.push('criterion count does not match registry');
    for (const criterion of report.criteria) validateCriterion(criterion, expectedMode, errors);
  }

  const reconciliation = report.workloadReconciliation;
  const reconciliationCounts = [
    'attempted', 'accepted', 'completed', 'failed', 'duplicate', 'unresolved',
  ];
  const reconciliationLists = [
    'missingSourceIds',
    'duplicateSourceIds',
    'nonterminalSourceIds',
    'mailboxLinkMismatchSourceIds',
    'identityMismatchSourceIds',
  ];
  if (
    !isObject(reconciliation)
    || reconciliationCounts.some(
      key => !Number.isInteger(reconciliation[key]) || reconciliation[key] < 0,
    )
    || reconciliation.accepted > reconciliation.attempted
    || reconciliation.completed > reconciliation.attempted
    || reconciliationLists.some(
      key => !Array.isArray(reconciliation[key])
        || reconciliation[key].some(id => typeof id !== 'string' || id.length === 0),
    )
  ) {
    errors.push('workload reconciliation is missing or malformed');
  }
  if (!Array.isArray(report.metrics) || report.metrics.length !== identity?.days) {
    errors.push('daily metric count does not match the run identity');
  } else {
    for (const [index, metric] of report.metrics.entries()) {
      if (
        !isObject(metric)
        || metric.day !== index + 1
        || !Number.isInteger(metric.eventCount)
        || metric.eventCount <= 0
        || !Number.isInteger(metric.eventFirstSeq)
        || !Number.isInteger(metric.eventLastSeq)
        || metric.eventLastSeq < metric.eventFirstSeq
        || metric.eventSequenceContinuous !== true
        || metric.eventIdsUnique !== true
      ) {
        errors.push(`daily metric ${index + 1} has malformed event continuity evidence`);
      }
      if (index > 0) {
        const previous = report.metrics[index - 1];
        if (
          Number.isInteger(previous?.eventLastSeq)
          && Number.isInteger(metric?.eventFirstSeq)
          && (
            metric.eventFirstSeq > previous.eventLastSeq + 1
            || metric.eventLastSeq < previous.eventLastSeq
          )
        ) {
          errors.push(`daily metric ${index + 1} does not connect to the prior event range`);
        }
      }
    }
    const attempted = report.metrics.reduce(
      (total, metric) => total + (metric.activitiesAttempted ?? 0),
      0,
    );
    if (attempted !== reconciliation?.attempted) {
      errors.push('daily attempted count does not match workload reconciliation');
    }
  }
  if (!Array.isArray(report.faultEvidence)) {
    errors.push('fault evidence array is missing');
  } else {
    const faultIds = new Set();
    for (const fault of report.faultEvidence) {
      if (!fault?.id || faultIds.has(fault.id)) errors.push(`invalid or duplicate fault ID: ${fault?.id}`);
      faultIds.add(fault?.id);
      if (!['passed', 'failed', 'not_evaluated'].includes(fault?.status)) {
        errors.push(`${fault?.id}: invalid fault status`);
      }
      if (
        !isObject(fault?.before)
        || !hasOnlyJsonValues(fault.before)
        || !isObject(fault?.fault)
        || !hasOnlyJsonValues(fault.fault)
        || !isObject(fault?.after)
        || !hasOnlyJsonValues(fault.after)
        || !Array.isArray(fault?.provenance)
        || fault.provenance.length === 0
        || fault.provenance.some(source => typeof source !== 'string' || source.length === 0)
      ) {
        errors.push(`${fault?.id}: malformed before/fault/after provenance`);
      }
      if (
        fault?.status === 'passed'
        && ('captureError' in fault.before || 'captureError' in fault.after)
      ) {
        errors.push(`${fault?.id}: passed fault contains a snapshot capture error`);
      }
      if (
        fault?.status !== 'passed'
        && (typeof fault?.failureReason !== 'string' || fault.failureReason.length === 0)
      ) {
        errors.push(`${fault?.id}: non-passing fault has no failure reason`);
      }
    }
  }

  const expectedFaultIds = identity?.configuration?.scheduledFaultIds ?? [];
  const actualFaultIds = report.faultEvidence?.map(fault => fault.id) ?? [];
  const missingFaultIds = expectedFaultIds.filter(id => !actualFaultIds.includes(id));
  const unexpectedFaultIds = actualFaultIds.filter(id => !expectedFaultIds.includes(id));
  if (missingFaultIds.length > 0 || unexpectedFaultIds.length > 0) {
    errors.push(
      `fault evidence does not match the scheduled matrix (missing=${missingFaultIds.join(',')}; unexpected=${unexpectedFaultIds.join(',')})`,
    );
  }

  const workloadCriterion = report.criteria?.find(
    criterion => criterion?.id === 'persisted-workload-reconciliation',
  );
  if (
    workloadCriterion?.status === 'passed'
    && (
      reconciliation?.accepted !== reconciliation?.attempted
      || reconciliation?.completed !== reconciliation?.attempted
      || reconciliation?.failed !== 0
      || reconciliation?.duplicate !== 0
      || reconciliation?.unresolved !== 0
      || reconciliationLists.some(key => reconciliation?.[key]?.length !== 0)
    )
  ) {
    errors.push('passed workload criterion conflicts with reconciliation evidence');
  }
  const faultCriterion = report.criteria?.find(
    criterion => criterion?.id === 'scheduled-fault-recovery',
  );
  if (
    faultCriterion?.status === 'passed'
    && report.faultEvidence?.some(fault => fault.status !== 'passed')
  ) {
    errors.push('passed fault criterion conflicts with non-passing fault evidence');
  }

  const jsonlLines = jsonlText.trimEnd().split('\n').filter(Boolean);
  const jsonl = [];
  for (const [index, line] of jsonlLines.entries()) {
    try {
      const record = JSON.parse(line);
      jsonl.push(record);
      if (line !== stableStringify(record)) {
        errors.push(`persona-soak.jsonl line ${index + 1} is not canonical JSON`);
      }
    } catch (error) {
      errors.push(`persona-soak.jsonl line ${index + 1} is malformed: ${error.message}`);
    }
  }
  const expectedJsonl = [
    {
      recordType: 'run',
      schemaVersion: report.schemaVersion,
      runIdentity: report.runIdentity,
    },
    ...(report.metrics ?? []).map(metric => ({ recordType: 'daily_metric', metric })),
    {
      recordType: 'workload_reconciliation',
      reconciliation: report.workloadReconciliation,
    },
    ...(report.faultEvidence ?? []).map(fault => ({ recordType: 'fault', fault })),
    ...(report.criteria ?? []).map(criterion => ({ recordType: 'criterion', criterion })),
  ];
  if (jsonl.length !== expectedJsonl.length) {
    errors.push('JSONL record count does not match the canonical JSON evidence');
  } else {
    for (const [index, expected] of expectedJsonl.entries()) {
      if (stableStringify(jsonl[index]) !== stableStringify(expected)) {
        errors.push(`persona-soak.jsonl record ${index + 1} differs from persona-soak.json`);
      }
    }
  }

  if (!markdown.includes(`Commit: ${expectedCommit}`)) {
    errors.push('Markdown report does not identify the exact commit');
  }
  if (identity?.runId && !markdown.includes(`Run ID: ${identity.runId}`)) {
    errors.push('Markdown report does not identify the run ID');
  }

  if (errors.length > 0) {
    throw new Error(`Persona soak artifact validation failed:\n- ${errors.join('\n- ')}`);
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const values = parseArguments(process.argv.slice(2));
  const directory = path.resolve(values.get('directory') ?? 'soak-artifacts');
  const expectedCommit = values.get('commit')
    ?? process.env.FLUJO_SOAK_COMMIT
    ?? process.env.GITHUB_SHA;
  const expectedMode = values.get('mode') ?? 'acceptance';
  if (!expectedCommit) throw new Error('Expected commit is required.');
  if (!['smoke', 'infrastructure', 'acceptance'].includes(expectedMode)) throw new Error('Mode must be smoke, infrastructure or acceptance.');
  await validatePersonaSoakArtifacts({ directory, expectedCommit, expectedMode });
  process.stdout.write(`Validated Persona soak evidence for ${expectedCommit} (${expectedMode}).\n`);
}
