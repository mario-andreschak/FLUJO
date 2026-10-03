#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_ROWS = 200;
const RESPONSE_BYTES = 2 * 1024 * 1024;
const identifiers = /^[A-Za-z0-9_-]{1,128}$/;
const workspaceNames = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const reservedWorkspaces = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const revisions = /^[a-f0-9]{40}$/;
const reasons = ['worker-not-ready', 'recovery-not-configured', 'no-local-provenance', 'invalid-provenance',
  'worker-authority-changed', 'generation-changed', 'definition-changed', 'not-opted-in', 'unsupported-plan',
  'paused', 'disabled', 'retired', 'unresolved-admission', 'already-accounted', 'eligible'];
const hints = ['timeout', 'rate-limit', 'bad-request', 'authentication', 'other'];
const alertCodes = ['enabled-plan-unarmed', 'unresolved-worker-admission', 'approval-index-needs-census',
  'shutdown-exit-unobserved', 'queue-pressure', 'rss-budget-reached', 'scheduler-not-started',
  'diagnostic-row-budget-reached', 'diagnostic-source-unavailable', ...hints.map(hint => `run-error-hint:${hint}`)];
const components = ['planned-executions', 'planned-execution-schema', 'run-history', 'run-history-schema',
  'pending-approval-index', 'approval-index-schema', 'rss-observation-budget'];

export class OperationsInspectError extends Error {
  constructor(code, httpStatus) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
const invalid = () => { throw new OperationsInspectError('invalid-metadata'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : invalid();
const boolean = value => typeof value === 'boolean' ? value : invalid();
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : invalid();
const oneOf = (value, choices) => choices.includes(value) ? value : invalid();
const id = value => typeof value === 'string' && identifiers.test(value) ? value : invalid();
const optionalId = value => value === undefined ? undefined : id(value);
const rows = (value, maximum = MAX_ROWS) => Array.isArray(value) && value.length <= maximum ? value : invalid();

export function validateBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new OperationsInspectError('invalid-base-url'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') throw new OperationsInspectError('invalid-base-url');
  return url;
}

/** Re-project every field: a hostile or older endpoint cannot smuggle raw errors/secrets into the report. */
export function projectSnapshot(input) {
  const source = object(input);
  if (source.schemaVersion !== 1 || source.observation !== 'non-atomic-diagnostic-sample' || source.rowLimit !== MAX_ROWS) invalid();
  if (typeof source.workspace !== 'string' || !workspaceNames.test(source.workspace) || reservedWorkspaces.test(source.workspace)) invalid();
  if (typeof source.collectedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(source.collectedAt)
      || !Number.isFinite(Date.parse(source.collectedAt))) invalid();
  const identity = object(source.identity);
  if (typeof identity.applicationVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,64})?$/.test(identity.applicationVersion)) invalid();
  const revision = identity.revision;
  if (revision !== undefined && (typeof revision !== 'string' || !revisions.test(revision))) invalid();
  const actor = object(source.actor);
  const kind = oneOf(actor.kind, ['owner', 'worker-control']);
  const scope = object(source.scope);
  const worker = object(source.worker);
  const scheduler = object(source.scheduler);
  const queue = object(scheduler.queue);
  const memory = object(source.memory);
  return {
    schemaVersion: 1, collectedAt: source.collectedAt, workspace: source.workspace,
    observation: 'non-atomic-diagnostic-sample', complete: boolean(source.complete), truncated: boolean(source.truncated), rowLimit: MAX_ROWS,
    identity: { applicationVersion: identity.applicationVersion, snapshotFormatVersion: count(identity.snapshotFormatVersion),
      layoutVersion: count(identity.layoutVersion), workerProtocolVersion: count(identity.workerProtocolVersion), ...(revision ? { revision } : {}) },
    actor: kind === 'owner' ? { kind, ownerId: id(actor.ownerId), credentialId: id(actor.credentialId) } : { kind },
    scope: {
      schedulerAndActiveRuns: oneOf(scope.schedulerAndActiveRuns, ['this-process-and-workspace']),
      approvalAndHistory: oneOf(scope.approvalAndHistory, ['unverified-durable-index']),
      processExit: oneOf(scope.processExit, ['matching-runtime-generation-receipt']),
    },
    probes: rows(source.probes, 800).map(raw => {
      const probe = object(raw);
      return { component: oneOf(probe.component, components), state: oneOf(probe.state, ['observed', 'absent', 'unavailable']),
        ...(probe.reason === undefined ? {} : { reason: oneOf(probe.reason, ['unsafe-path', 'budget-exceeded', 'invalid-json', 'unavailable', 'invalid-schema', 'invalid-config']) }) };
    }),
    worker: { mode: oneOf(worker.mode, ['local', 'worker']), state: oneOf(worker.state, ['not-started', 'restoring', 'locked', 'installing', 'ready', 'error']) },
    scheduler: { started: boolean(scheduler.started), pausedAtLastReconcile: boolean(scheduler.pausedAtLastReconcile),
      pausedInStoredConfig: scheduler.pausedInStoredConfig === null ? null : boolean(scheduler.pausedInStoredConfig),
      armedTriggers: count(scheduler.armedTriggers), runningRuns: count(scheduler.runningRuns),
      queue: { overlap: count(queue.overlap), exclusiveWaiting: count(queue.exclusiveWaiting), maxOverlapDepth: count(queue.maxOverlapDepth),
        blockedByExclusive: count(queue.blockedByExclusive), capPerQueue: count(queue.capPerQueue) } },
    schedules: rows(source.schedules).map(raw => {
      const plan = object(raw);
      const result = { id: id(plan.id), generationId: optionalId(plan.generationId), enabled: boolean(plan.enabled), armed: boolean(plan.armed),
        runningInThisProcess: boolean(plan.runningInThisProcess), ...(plan.errorHint === undefined ? {} : { errorHint: oneOf(plan.errorHint, hints) }) };
      if (plan.recovery !== undefined) {
        const recovery = object(plan.recovery);
        result.recovery = { state: oneOf(recovery.state, ['suppressed', 'pending-local-recovery', 'armed', 'rejected']),
          reason: oneOf(recovery.reason, reasons), eligible: boolean(recovery.eligible), pendingRunId: optionalId(recovery.pendingRunId) };
      }
      if (plan.indexedLastRun !== undefined) {
        const run = object(plan.indexedLastRun);
        result.indexedLastRun = { runId: optionalId(run.runId), generationId: optionalId(run.generationId),
          status: oneOf(run.status, ['completed', 'error', 'skipped', 'needs_approval', 'running', 'queued', 'unknown']) };
      }
      return result;
    }),
    indexedApprovals: rows(source.indexedApprovals).map(raw => {
      const approval = object(raw);
      return { approvalId: optionalId(approval.approvalId), conversationId: optionalId(approval.conversationId),
        executionId: optionalId(approval.executionId), runId: optionalId(approval.runId) };
    }),
    activeRuns: rows(source.activeRuns).map(raw => {
      const run = object(raw);
      return { conversationId: optionalId(run.conversationId), flowId: optionalId(run.flowId), executionId: optionalId(run.executionId),
        status: oneOf(run.status, ['running', 'awaiting_tool_approval', 'paused_debug']) };
    }),
    processes: rows(source.processes).map(raw => {
      const runtime = object(raw); const shutdown = object(runtime.shutdown);
      const result = { runtimeId: optionalId(runtime.runtimeId), generation: count(runtime.generation),
        state: oneOf(runtime.state, ['cold', 'starting', 'warm', 'stopping', 'error']), leases: count(runtime.leases), pins: count(runtime.pins),
        shutdown: { exitOutcome: oneOf(shutdown.exitOutcome, ['unknown', 'observed_exit', 'not_applicable']) } };
      if (shutdown.processOwnership !== undefined) {
        result.shutdown = { ...result.shutdown, processOwnership: oneOf(shutdown.processOwnership, ['owned', 'external', 'unknown']),
          forced: boolean(shutdown.forced), errorClassification: oneOf(shutdown.errorClassification, ['none', 'close_failed', 'exit_unobserved']),
          generation: count(shutdown.generation), runtimeId: optionalId(shutdown.runtimeId) };
      }
      return result;
    }),
    memory: { rssBytes: count(memory.rssBytes), heapUsedBytes: count(memory.heapUsedBytes), heapTotalBytes: count(memory.heapTotalBytes),
      ...(memory.configuredRssBudgetBytes === undefined ? {} : { configuredRssBudgetBytes: count(memory.configuredRssBudgetBytes) }) },
    alerts: rows(source.alerts, 800).map(raw => {
      const alert = object(raw);
      return { code: oneOf(alert.code, alertCodes), severity: oneOf(alert.severity, ['info', 'warning']), resourceId: optionalId(alert.resourceId) };
    }),
  };
}

async function readResponse(response, maximum) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new OperationsInspectError('response-budget-exceeded');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw new OperationsInspectError('invalid-metadata');
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new OperationsInspectError('response-budget-exceeded');
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
    catch { throw new OperationsInspectError('invalid-metadata'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function inspectOperations({ baseUrl, workspace, expectedRevision, token, timeoutMs = 10_000, maxResponseBytes = RESPONSE_BYTES }) {
  const url = validateBaseUrl(baseUrl);
  if (!workspaceNames.test(workspace ?? '') || reservedWorkspaces.test(workspace ?? '') || !revisions.test(expectedRevision ?? '')
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > RESPONSE_BYTES) throw new OperationsInspectError('invalid-arguments');
  if (typeof token !== 'string' || !token || token.length > 4096 || /[\x00-\x20\x7f]/.test(token)) throw new OperationsInspectError('missing-or-invalid-token');
  url.pathname = '/api/operations/status'; url.searchParams.set('workspace', workspace);
  let response;
  try {
    response = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (response.status >= 300 && response.status < 400) throw new OperationsInspectError('redirect-refused');
    if (response.status !== 200) throw new OperationsInspectError('http-refused', response.status);
    const snapshot = projectSnapshot(await readResponse(response, maxResponseBytes));
    if (snapshot.workspace !== workspace) throw new OperationsInspectError('workspace-mismatch');
    const revisionMatch = snapshot.identity.revision === expectedRevision;
    const partial = !snapshot.complete || snapshot.truncated || snapshot.probes.some(probe => probe.state === 'unavailable');
    const attention = partial || !revisionMatch || snapshot.alerts.some(alert => alert.severity === 'warning');
    return { exitCode: attention ? 2 : 0, report: { schemaVersion: 1, tool: 'flujo-operations-inspect', expectedRevision,
      checks: { request: 'authenticated-get-only', revision: revisionMatch ? 'self-report-matches' : snapshot.identity.revision ? 'self-report-mismatch' : 'self-report-missing',
        artifactDigest: 'not-verified', observation: partial ? 'partial' : 'complete-sample', requiresAttention: attention }, snapshot } };
  } catch (error) {
    if (error instanceof OperationsInspectError) throw error;
    throw new OperationsInspectError(['TimeoutError', 'AbortError'].includes(error?.name) ? 'request-timeout' : 'request-unavailable');
  } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
}

export function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!['--base-url', '--workspace', '--expected-revision', '--report'].includes(key) || !value || value.startsWith('--') || key in values) {
      throw new OperationsInspectError('invalid-arguments');
    }
    values[key] = value;
  }
  if (!values['--base-url'] || !values['--workspace'] || !values['--expected-revision']
      || (values['--report'] && !path.isAbsolute(values['--report']))) throw new OperationsInspectError('invalid-arguments');
  return { baseUrl: values['--base-url'], workspace: values['--workspace'], expectedRevision: values['--expected-revision'], reportPath: values['--report'] };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node scripts/operations-inspect.mjs --base-url https://host --workspace default-workspace --expected-revision <40 lowercase hex> [--report <absolute new file>]\nRead bearer from FLUJO_OPERATIONS_TOKEN. GET only; exits 0 complete sample, 2 attention/partial/revision mismatch, 1 refused/unavailable. Artifact digest and deployment acceptance require independent evidence.\n');
    return 0;
  }
  try {
    const options = parseArguments(args);
    const { exitCode, report } = await inspectOperations({ ...options, token: process.env.FLUJO_OPERATIONS_TOKEN });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.reportPath) {
      const handle = await fs.open(options.reportPath, 'wx', 0o600);
      try { await handle.writeFile(serialized); } finally { await handle.close(); }
      process.stdout.write(`${JSON.stringify({ tool: report.tool, checks: report.checks, reportWritten: true })}\n`);
    } else process.stdout.write(serialized);
    return exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ tool: 'flujo-operations-inspect', error: error instanceof OperationsInspectError ? error.code : 'report-unavailable',
      ...(error instanceof OperationsInspectError && error.httpStatus ? { httpStatus: error.httpStatus } : {}) })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
