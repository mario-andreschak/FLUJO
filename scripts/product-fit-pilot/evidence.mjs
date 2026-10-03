// Offline operator records, never app telemetry or proof of independent assessment.
const DAY = 86_400_000;
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FAILURE_CODES = ['none', 'installation', 'prerequisite', 'authentication', 'quota',
  'discovery', 'tool-form', 'tool-call', 'model-binding', 'runtime', 'approval',
  'debugger', 'proxy', 'accessibility', 'unclear-next-step', 'other'];

export function emptyPilot() {
  return {
    schemaVersion: 1,
    protocolVersion: 'pilot-v1',
    evidenceMode: 'human-observations',
    rubric: { status: 'proposed', agreementSha256: null, targets: {
      users: 10, weeks: 8, workflows: 3, novices: 10, noviceSuccessRate: 0.8, firstRunSeconds: 900,
    } },
    startedAt: null,
    artifacts: [], workflows: [], participants: [], journeys: [], weeks: [], feedback: [],
  };
}

function requireValue(condition, path, rule) {
  if (!condition) throw new Error(`${path}: ${rule}`);
}

function object(value, fields, path) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), path, 'expected an object');
  // Never echo untrusted keys or values: a rejected field might contain a secret.
  requireValue(Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)),
    path, 'unexpected or missing fields');
}

function array(value, max, path) {
  requireValue(Array.isArray(value) && value.length <= max, path, `expected an array of at most ${max} records`);
}

function integer(value, min, max, path) {
  requireValue(Number.isSafeInteger(value) && value >= min && value <= max, path, `expected an integer from ${min} to ${max}`);
}

function choice(value, values, path) {
  requireValue(values.includes(value), path, 'unsupported value');
}

function boolean(value, path) {
  requireValue(typeof value === 'boolean', path, 'expected a boolean');
}

function digest(value, expression, path, nullable = false) {
  requireValue((nullable && value === null) || (typeof value === 'string' && expression.test(value)), path, 'invalid digest');
}

function timestamp(value, path, nullable = false) {
  if (nullable && value === null) return null;
  requireValue(typeof value === 'string' && TIME.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value, path, 'expected a real UTC ISO timestamp with milliseconds');
  return Date.parse(value);
}

function id(value, prefix, path) {
  requireValue(typeof value === 'string' && new RegExp(`^${prefix}[0-9]{3}$`).test(value), path, 'invalid pseudonymous identifier');
}

function index(records, prefix, path) {
  const result = new Map();
  records.forEach((record, i) => {
    id(record.id, prefix, `${path}[${i}].id`);
    requireValue(!result.has(record.id), `${path}[${i}]`, 'duplicate identifier');
    result.set(record.id, record);
  });
  return result;
}

export function validatePilot(data, asOf, now = Date.now()) {
  const cutoff = timestamp(asOf, 'asOf');
  requireValue(cutoff <= now, 'asOf', 'future observations cannot count as elapsed evidence');
  object(data, ['schemaVersion', 'protocolVersion', 'evidenceMode', 'rubric', 'startedAt',
    'artifacts', 'workflows', 'participants', 'journeys', 'weeks', 'feedback'], 'pilot');
  requireValue(data.schemaVersion === 1 && data.protocolVersion === 'pilot-v1', 'pilot', 'unsupported protocol');
  choice(data.evidenceMode, ['human-observations', 'synthetic-fixture'], 'pilot.evidenceMode');
  object(data.rubric, ['status', 'agreementSha256', 'targets'], 'rubric');
  choice(data.rubric.status, ['proposed', 'agreed'], 'rubric.status');
  digest(data.rubric.agreementSha256, SHA, 'rubric.agreementSha256', data.rubric.status === 'proposed');
  object(data.rubric.targets, ['users', 'weeks', 'workflows', 'novices', 'noviceSuccessRate', 'firstRunSeconds'], 'targets');
  const targets = data.rubric.targets;
  for (const field of ['users', 'novices']) integer(targets[field], 1, 100, `targets.${field}`);
  integer(targets.weeks, 2, 52, 'targets.weeks');
  integer(targets.workflows, 1, 20, 'targets.workflows');
  integer(targets.firstRunSeconds, 1, 86_400, 'targets.firstRunSeconds');
  requireValue(typeof targets.noviceSuccessRate === 'number' && targets.noviceSuccessRate > 0 &&
    targets.noviceSuccessRate <= 1, 'targets.noviceSuccessRate', 'expected a rate greater than zero and at most one');
  const start = timestamp(data.startedAt, 'startedAt', true);
  requireValue(start === null || start <= cutoff, 'startedAt', 'pilot start is after the report cutoff');
  for (const [field, max] of Object.entries({ artifacts: 100, workflows: 20, participants: 100,
    journeys: 100, weeks: 5200, feedback: 1000 })) array(data[field], max, field);
  requireValue(start !== null || data.participants.length + data.journeys.length + data.weeks.length + data.feedback.length === 0,
    'startedAt', 'observations require a declared pilot start');
  requireValue(data.evidenceMode !== 'human-observations' || data.participants.length === 0 || data.rubric.status === 'agreed',
    'rubric', 'agree the rubric before human enrollment');

  data.artifacts.forEach((artifact, i) => {
    const path = `artifacts[${i}]`;
    object(artifact, ['id', 'kind', 'version', 'sourceCommit', 'sha256'], path);
    choice(artifact.kind, ['source', 'npm', 'image', 'installer'], `${path}.kind`);
    requireValue(typeof artifact.version === 'string' && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]{1,30})?$/.test(artifact.version),
      `${path}.version`, 'expected a bounded version');
    digest(artifact.sourceCommit, COMMIT, `${path}.sourceCommit`);
    digest(artifact.sha256, SHA, `${path}.sha256`);
  });
  const artifacts = index(data.artifacts, 'a', 'artifacts');
  const protocols = new Set();
  data.workflows.forEach((workflow, i) => {
    object(workflow, ['id', 'purpose', 'protocolSha256'], `workflows[${i}]`);
    choice(workflow.purpose, ['practice-fixture', 'normal-workflow'], `workflows[${i}].purpose`);
    digest(workflow.protocolSha256, SHA, `workflows[${i}].protocolSha256`);
    requireValue(!protocols.has(workflow.protocolSha256), `workflows[${i}]`, 'distinct workflows require distinct task protocols');
    protocols.add(workflow.protocolSha256);
  });
  const workflows = index(data.workflows, 'w', 'workflows');
  data.participants.forEach((participant, i) => {
    const path = `participants[${i}]`;
    object(participant, ['id', 'role', 'novice', 'enrolledAt', 'consent'], path);
    choice(participant.role, ['independent-human', 'maintainer', 'automated', 'promotional'], `${path}.role`);
    boolean(participant.novice, `${path}.novice`);
    const enrolled = timestamp(participant.enrolledAt, `${path}.enrolledAt`);
    requireValue(enrolled <= cutoff, path, 'enrollment is after the cutoff');
    object(participant.consent, ['version', 'collectedAt', 'collection', 'publication', 'withdrawnAt'], `${path}.consent`);
    requireValue(participant.consent.version === 'pilot-v1' && participant.consent.collection === true,
      `${path}.consent`, 'affirmative protocol consent is required');
    requireValue(timestamp(participant.consent.collectedAt, `${path}.consent.collectedAt`) <= enrolled,
      path, 'consent must precede enrollment');
    choice(participant.consent.publication, ['private-only', 'aggregate-only'], `${path}.consent.publication`);
    const withdrawn = timestamp(participant.consent.withdrawnAt, `${path}.consent.withdrawnAt`, true);
    requireValue(withdrawn === null || (withdrawn >= enrolled && withdrawn <= cutoff), path, 'invalid withdrawal time');
  });
  const participants = index(data.participants, 'p', 'participants');
  const participantFor = (record, path, observed) => {
    id(record.participantId, 'p', `${path}.participantId`);
    const participant = participants.get(record.participantId);
    requireValue(participant !== undefined, path, 'unknown participant');
    requireValue(participant.consent.withdrawnAt === null, path, 'remove withdrawn participant observations');
    requireValue(observed >= start && observed >= Date.parse(participant.enrolledAt) && observed <= cutoff,
      path, 'observation outside consented pilot window');
    return participant;
  };
  const artifactFor = (record, path) => {
    id(record.artifactId, 'a', `${path}.artifactId`);
    requireValue(artifacts.has(record.artifactId), path, 'unknown artifact');
  };

  const journeyParticipants = new Set();
  const journeyReceipts = new Set();
  data.journeys.forEach((journey, i) => {
    const path = `journeys[${i}]`;
    object(journey, ['participantId', 'artifactId', 'startedAt', 'endedAt', 'provisioningSeconds',
      'coaching', 'coding', 'status', 'mcpToolCompleted', 'modelReplyCompleted', 'receiptSha256', 'dropOff', 'failureCode'], path);
    const began = timestamp(journey.startedAt, `${path}.startedAt`);
    const ended = timestamp(journey.endedAt, `${path}.endedAt`);
    participantFor(journey, path, began);
    requireValue(ended >= began && ended <= cutoff, path, 'invalid journey interval');
    requireValue(!journeyParticipants.has(journey.participantId), path, 'record the first attempt once; do not replace failures with retries');
    journeyParticipants.add(journey.participantId);
    artifactFor(journey, path);
    integer(journey.provisioningSeconds, 0, Math.floor((ended - began) / 1000), `${path}.provisioningSeconds`);
    for (const field of ['coaching', 'coding', 'mcpToolCompleted', 'modelReplyCompleted']) boolean(journey[field], `${path}.${field}`);
    choice(journey.status, ['completed', 'failed', 'abandoned', 'provisioning-blocked'], `${path}.status`);
    choice(journey.dropOff, ['none', 'install', 'model', 'connect', 'inspect', 'tool-test', 'agent', 'approval', 'debugger', 'proxy'], `${path}.dropOff`);
    choice(journey.failureCode, FAILURE_CODES, `${path}.failureCode`);
    digest(journey.receiptSha256, SHA, `${path}.receiptSha256`, journey.status !== 'completed');
    if (journey.receiptSha256 !== null) {
      requireValue(!journeyReceipts.has(journey.receiptSha256), path, 'independent first attempts require distinct receipts');
      journeyReceipts.add(journey.receiptSha256);
    }
    requireValue(journey.status !== 'completed' || (journey.mcpToolCompleted && journey.modelReplyCompleted &&
      journey.dropOff === 'none' && journey.failureCode === 'none'), path, 'completion requires an actual model reply and MCP tool result');
    requireValue(journey.status === 'completed' || (journey.dropOff !== 'none' && journey.failureCode !== 'none'),
      path, 'record the failure or abandonment boundary');
  });

  const participantWeeks = new Set();
  const taskReceipts = new Set();
  data.weeks.forEach((week, i) => {
    const path = `weeks[${i}]`;
    object(week, ['participantId', 'week', 'reportedAt', 'tasks'], path);
    const reported = timestamp(week.reportedAt, `${path}.reportedAt`);
    participantFor(week, path, reported);
    integer(week.week, 1, targets.weeks, `${path}.week`);
    const began = start + (week.week - 1) * 7 * DAY;
    const ended = began + 7 * DAY;
    requireValue(reported >= ended, path, 'weekly reports cover a completed week');
    const key = `${week.participantId}:${week.week}`;
    requireValue(!participantWeeks.has(key), path, 'duplicate participant-week');
    participantWeeks.add(key);
    array(week.tasks, 100, `${path}.tasks`);
    week.tasks.forEach((task, j) => {
      const taskPath = `${path}.tasks[${j}]`;
      object(task, ['workflowId', 'artifactId', 'completedAt', 'outcome', 'mcpUsed', 'receiptSha256',
        'benefit', 'interventions', 'failureCode'], taskPath);
      const completed = timestamp(task.completedAt, `${taskPath}.completedAt`);
      participantFor(week, taskPath, completed);
      requireValue(completed >= began && completed < ended && completed <= reported, taskPath, 'task outside its reported week');
      id(task.workflowId, 'w', `${taskPath}.workflowId`);
      requireValue(workflows.has(task.workflowId), taskPath, 'unknown task protocol');
      artifactFor(task, taskPath);
      choice(task.outcome, ['completed', 'failed'], `${taskPath}.outcome`);
      boolean(task.mcpUsed, `${taskPath}.mcpUsed`);
      choice(task.benefit, ['none', 'unmeasured', 'time-saved', 'better-control', 'connection-reuse'], `${taskPath}.benefit`);
      integer(task.interventions, 0, 100, `${taskPath}.interventions`);
      choice(task.failureCode, FAILURE_CODES, `${taskPath}.failureCode`);
      digest(task.receiptSha256, SHA, `${taskPath}.receiptSha256`, task.outcome !== 'completed');
      requireValue((task.outcome === 'completed') === (task.failureCode === 'none'), taskPath, 'outcome and failure code disagree');
      requireValue(task.outcome === 'completed' || ['none', 'unmeasured'].includes(task.benefit), taskPath, 'failed tasks cannot claim benefit');
      if (task.receiptSha256 !== null) {
        requireValue(!taskReceipts.has(task.receiptSha256), taskPath, 'a task receipt cannot count twice');
        taskReceipts.add(task.receiptSha256);
      }
    });
  });

  data.feedback.forEach((feedback, i) => {
    const path = `feedback[${i}]`;
    object(feedback, ['id', 'participantId', 'reportedAt', 'category', 'severity', 'failureCode',
      'issueNumber', 'fixCommit', 'confirmedArtifactId', 'confirmedAt', 'confirmationSha256'], path);
    const reported = timestamp(feedback.reportedAt, `${path}.reportedAt`);
    participantFor(feedback, path, reported);
    choice(feedback.category, ['onboarding', 'runtime', 'tools', 'approval', 'debugger', 'proxy', 'accessibility'], `${path}.category`);
    choice(feedback.severity, ['minor', 'severe'], `${path}.severity`);
    choice(feedback.failureCode, FAILURE_CODES.slice(1), `${path}.failureCode`);
    if (feedback.issueNumber !== null) integer(feedback.issueNumber, 1, 1_000_000, `${path}.issueNumber`);
    digest(feedback.fixCommit, COMMIT, `${path}.fixCommit`, true);
    digest(feedback.confirmationSha256, SHA, `${path}.confirmationSha256`, true);
    const confirmedAt = timestamp(feedback.confirmedAt, `${path}.confirmedAt`, true);
    const confirmed = feedback.confirmedArtifactId !== null;
    requireValue(confirmed === (feedback.confirmationSha256 !== null) && confirmed === (confirmedAt !== null),
      path, 'confirmation needs artifact, time and receipt');
    requireValue(!confirmed || (feedback.issueNumber !== null && feedback.fixCommit !== null), path, 'confirmation needs the tracked fix');
    if (confirmed) {
      requireValue(confirmedAt >= reported && confirmedAt <= cutoff, path, 'confirmation outside the reported observation window');
      id(feedback.confirmedArtifactId, 'a', `${path}.confirmedArtifactId`);
      requireValue(artifacts.has(feedback.confirmedArtifactId), path, 'unknown confirmation artifact');
      requireValue(artifacts.get(feedback.confirmedArtifactId).sourceCommit === feedback.fixCommit,
        path, 'confirmation artifact must bind to the recorded fixed candidate revision');
    }
  });
  index(data.feedback, 'f', 'feedback');
  return data;
}

export function summarizePilot(data, asOf, now = Date.now()) {
  validatePilot(data, asOf, now);
  const { targets } = data.rubric;
  const start = data.startedAt === null ? null : Date.parse(data.startedAt);
  const completeWeeks = start === null ? 0 : Math.min(targets.weeks, Math.floor((Date.parse(asOf) - start) / (7 * DAY)));
  const cohort = data.participants.filter(p => p.role === 'independent-human' && Date.parse(p.enrolledAt) <= start);
  const novices = cohort.filter(p => p.novice);
  const cohortIds = new Set(cohort.map(p => p.id));
  const installed = new Set(data.artifacts.filter(a => a.kind !== 'source').map(a => a.id));
  const normalWorkflows = new Set(data.workflows.filter(w => w.purpose === 'normal-workflow').map(w => w.id));
  const qualifyingTask = task => task.outcome === 'completed' && task.mcpUsed && installed.has(task.artifactId) &&
    normalWorkflows.has(task.workflowId);
  const reports = data.weeks.filter(w => w.week <= completeWeeks && cohortIds.has(w.participantId));
  const weekly = Array.from({ length: completeWeeks }, (_, i) => {
    const records = reports.filter(w => w.week === i + 1);
    return { week: i + 1, enrolled: cohort.length, reported: records.length,
      missing: cohort.length - records.length, active: records.filter(w => w.tasks.some(qualifyingTask)).length,
      inactive: records.filter(w => !w.tasks.some(qualifyingTask)).length };
  });
  const retained = cohort.filter(p => completeWeeks > 0 && weekly.every(w =>
    reports.some(r => r.participantId === p.id && r.week === w.week && r.tasks.some(qualifyingTask)))).length;
  const recurring = data.workflows.filter(workflow => workflow.purpose === 'normal-workflow' && cohort.some(p => {
    const observedWeeks = new Set(reports.filter(r => r.participantId === p.id && r.tasks.some(t =>
      t.workflowId === workflow.id && qualifyingTask(t) && !['none', 'unmeasured'].includes(t.benefit))).map(r => r.week));
    return observedWeeks.size >= 2;
  })).length;
  const journeys = novices.map(p => data.journeys.find(j => j.participantId === p.id)).filter(Boolean);
  const successful = journey => journey.status === 'completed' && !journey.coaching && !journey.coding &&
    installed.has(journey.artifactId) && (Date.parse(journey.endedAt) - Date.parse(journey.startedAt)) / 1000 -
      journey.provisioningSeconds <= targets.firstRunSeconds;
  const noviceSuccesses = journeys.filter(successful).length;
  const severe = data.feedback.filter(f => f.severity === 'severe');
  const unresolvedSevere = severe.filter(f => !installed.has(f.confirmedArtifactId)).length;
  const tasks = reports.flatMap(r => r.tasks);
  const numeric = {
    weeklyAdoption: completeWeeks === targets.weeks && retained >= targets.users,
    recurringWorkflows: recurring >= targets.workflows,
    noviceFirstRun: novices.length >= targets.novices && noviceSuccesses / novices.length >= targets.noviceSuccessRate,
    severeFailuresConfirmed: unresolvedSevere === 0,
  };
  const gate = condition => data.evidenceMode === 'synthetic-fixture' ? 'fixture-only' :
    data.rubric.status !== 'agreed' ? 'pending-agreement' : condition ? 'recorded-target-met' : 'pending-evidence';
  return {
    schemaVersion: 1, protocolVersion: data.protocolVersion, evidenceMode: data.evidenceMode, asOf,
    rubricStatus: data.rubric.status, targets, completeWeeks, artifacts: data.artifacts,
    cohort: { enrolled: cohort.length, excluded: data.participants.length - cohort.length,
      withdrawn: cohort.filter(p => p.consent.withdrawnAt !== null).length, retainedThroughCompleteWeeks: retained },
    weekly,
    workflows: { defined: data.workflows.length, recurringWithRecordedBenefit: recurring },
    novices: { enrolled: novices.length, observed: journeys.length, missing: novices.length - journeys.length,
      successfulWithinTarget: noviceSuccesses, failedOrAbandoned: journeys.filter(j => j.status !== 'completed').length,
      coached: journeys.filter(j => j.coaching).length, coded: journeys.filter(j => j.coding).length,
      provisioningBlocked: journeys.filter(j => j.status === 'provisioning-blocked').length,
      provisioningSeconds: journeys.reduce((sum, j) => sum + j.provisioningSeconds, 0),
      productSeconds: journeys.map(j => (Date.parse(j.endedAt) - Date.parse(j.startedAt)) / 1000 - j.provisioningSeconds),
      dropOffs: Object.fromEntries(['install', 'model', 'connect', 'inspect', 'tool-test', 'agent', 'approval', 'debugger', 'proxy']
        .map(boundary => [boundary, journeys.filter(j => j.dropOff === boundary).length])),
      failureCodes: Object.fromEntries(FAILURE_CODES.slice(1).map(code => [code, journeys.filter(j => j.failureCode === code).length])) },
    tasks: { attempted: tasks.length, completed: tasks.filter(t => t.outcome === 'completed').length,
      failed: tasks.filter(t => t.outcome === 'failed').length,
      sourceOnly: tasks.filter(t => !installed.has(t.artifactId)).length,
      practice: tasks.filter(t => !normalWorkflows.has(t.workflowId)).length,
      interventions: tasks.reduce((sum, t) => sum + t.interventions, 0) },
    feedback: { severe: severe.length, unresolvedSevere },
    gates: Object.fromEntries(Object.entries(numeric).map(([name, condition]) => [name, gate(condition)])),
    externalReassessment: 'required',
    evidenceLimit: 'Operator-entered records and digest references require independent review of genuine retained evidence.',
  };
}

export function publicSummary(data, report) {
  // An opt-out applies to the entire export, avoiding a filtered success denominator.
  const publicationAllowed = data.participants.every(p => p.consent.publication === 'aggregate-only');
  const safeCounts = values => publicationAllowed && values.every(n => n === 0 || n >= 5);
  const cohortVisible = safeCounts([report.cohort.enrolled, report.cohort.excluded, report.cohort.withdrawn,
    report.cohort.retainedThroughCompleteWeeks, report.cohort.enrolled - report.cohort.retainedThroughCompleteWeeks]);
  const novicesVisible = safeCounts([report.novices.enrolled, report.novices.successfulWithinTarget,
    report.novices.enrolled - report.novices.successfulWithinTarget]);
  return {
    schemaVersion: 1, protocolVersion: report.protocolVersion, evidenceMode: report.evidenceMode,
    asOf: report.asOf.slice(0, 10), rubricStatus: report.rubricStatus, completeWeeks: report.completeWeeks,
    publication: publicationAllowed ? 'aggregate-only-small-cells-suppressed' : 'withheld-by-consent',
    cohort: cohortVisible ? report.cohort : null,
    novices: novicesVisible ? { enrolled: report.novices.enrolled, successfulWithinTarget: report.novices.successfulWithinTarget } : null,
    gates: publicationAllowed && report.cohort.enrolled >= 5 ? {
      weeklyAdoption: cohortVisible ? report.gates.weeklyAdoption : 'suppressed',
      noviceFirstRun: novicesVisible ? report.gates.noviceFirstRun : 'suppressed',
      recurringWorkflows: 'private-review-required', severeFailuresConfirmed: 'private-review-required',
    } : null,
    externalReassessment: report.externalReassessment, evidenceLimit: report.evidenceLimit,
  };
}
