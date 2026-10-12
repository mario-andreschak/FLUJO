import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const copyId = 'copied-smoke-plan';
const cron = '*/5 * * * * *';

/** Snapshot input only: this enabled row must never acquire worker-local provenance. */
export function copiedRecoveryPlan(flowId) {
  return { id: copyId, generationId: 'copied-smoke-generation', name: 'Copied fixture', enabled: true, flowId,
    prompt: 'Synthetic copied schedule must not execute.', overlapStrategy: 'skip', startRestriction: 'singleton',
    trigger: { type: 'schedule', cron, catchUp: true }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

/** Select a later ordinary cron result; catch-up, arming and old history are insufficient. */
export function completedTickAfterCatchup(history, { generationId, catchupRunId, priorRunIds = new Set(), observedAt }) {
  assert.ok(Array.isArray(history), 'Recurring history must be an array.');
  const baseline = Date.parse(observedAt);
  assert.ok(identifier.test(generationId) && identifier.test(catchupRunId) && Number.isFinite(baseline), 'Invalid recurrence observation identity.');
  return history.find(run => {
    if (!run || typeof run !== 'object' || !identifier.test(run.runId ?? '') || run.runId === catchupRunId
        || priorRunIds.has(run.runId) || run.executionGenerationId !== generationId || run.status !== 'completed'
        || run.triggerSummary !== 'Schedule' || typeof run.firedAt !== 'string' || typeof run.finishedAt !== 'string') return false;
    const firedAt = Date.parse(run.firedAt); const finishedAt = Date.parse(run.finishedAt);
    return Number.isFinite(firedAt) && firedAt >= baseline && Number.isFinite(finishedAt) && finishedAt >= firedAt;
  });
}

/** Preserve completed witnesses on rejection without copying raw errors or response bodies. */
export async function captureWorkerRecoveryAttempt(options, { run = exerciseWorkerRecovery, record = () => {} } = {}) {
  const attempt = { schemaVersion: 1, scenario: 'worker-local-recurring-recovery-attempt',
    startedAt: new Date().toISOString(), outcome: 'running', observations: [],
    qualification: 'stage-witnesses-only; artifact-and-operator-acceptance-not-established' };
  try {
    const result = await run({ ...options, onObservation: observation => {
      attempt.observations.push(structuredClone(observation));
      options.onObservation?.(structuredClone(observation));
    } });
    attempt.outcome = 'passed';
    return result;
  } catch (error) {
    attempt.outcome = 'failed';
    throw error;
  } finally {
    attempt.completedAt = new Date().toISOString();
    record(structuredClone(attempt));
  }
}

export async function boundedJson(response) {
  assert.ok(response.body, 'Acceptance response body missing.');
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      assert.ok(length <= 2 * 1024 * 1024, 'Acceptance response exceeded byte budget.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Reuses the actual worker startup/engine/provider from smoke-cloud-worker; no second recovery implementation. */
export async function exerciseWorkerRecovery({ baseUrl, workspace, controlToken, flowId, restart, providerCount,
  setProviderMode, readPrivateRecord, observationRoute = 'scheduler',
  observeMs = 11_000, offlineMs = 11_000, timeoutMs = 45_000, pause = delay, onObservation = () => {}, signal }) {
  const url = new URL(baseUrl);
  assert.equal(url.protocol, 'http:', 'Acceptance fixture must use loopback HTTP.');
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname), 'Acceptance fixture must use literal loopback.');
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Unsafe fixture origin.');
  assert.ok(identifier.test(workspace) && identifier.test(flowId), 'Unsafe fixture identifiers.');
  assert.ok(['operations', 'scheduler'].includes(observationRoute), 'Unknown acceptance observation contract.');
  const observations = [];
  const observe = observation => { observations.push(observation); onObservation(structuredClone(observation)); };
  const pauseFor = milliseconds => pause(milliseconds, undefined, signal ? { signal } : undefined);
  async function request(endpoint, { method = 'GET', body, expected = 200 } = {}) {
    signal?.throwIfAborted();
    const target = new URL(endpoint, url); target.searchParams.set('workspace', workspace);
    const response = await fetch(target, { method, redirect: 'error',
      signal: signal ? AbortSignal.any([AbortSignal.timeout(10_000), signal]) : AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${controlToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, expected, `Acceptance ${method} ${target.pathname} returned an unexpected status.`);
    return boundedJson(response);
  }
  const snapshot = async () => {
    if (observationRoute === 'operations') return request('/api/operations/status');
    // Explicit compatibility profile, never an automatic fallback. The ordinary
    // list may reconcile signed terminal observations; it is not read-only diagnostics.
    const status = await request('/api/worker/status');
    const info = await request('/api/snapshot/info');
    const list = await request('/api/planned-executions');
    assert.ok(Array.isArray(list.executions) && list.executions.length <= 200, 'Fixture scheduler census exceeded its budget.');
    return { complete: true, workspace: status.workspace, worker: { state: status.state }, identity: info.workerCompatibility,
      schedules: list.executions.map(entry => ({ id: entry.execution.id, armed: entry.status.armed,
        recovery: entry.status.workerRecovery ? { ...entry.status.workerRecovery,
          pendingRunId: entry.status.workerRecovery.pending?.runId } : undefined })) };
  };
  const find = (sample, id) => {
    const plan = sample.schedules?.find(candidate => candidate.id === id);
    assert.ok(plan, 'Expected fixture plan missing from diagnostic sample.');
    return plan;
  };
  async function waitFor(check, message) {
    const deadline = performance.now() + timeoutMs;
    do { signal?.throwIfAborted(); const result = await check(); if (result) return result; await pauseFor(250); }
    while (performance.now() < deadline);
    throw new Error(message);
  }
  async function listEntry(id) {
    const list = await request('/api/planned-executions');
    const entry = list.executions?.find(candidate => candidate.execution.id === id);
    assert.ok(entry?.execution.generationId && entry.status.workerRecovery?.definitionSha256, 'Recovery enrollment identity unavailable.');
    return entry;
  }
  async function enrollment(id, enabled, expectedGenerationId) {
    const entry = await listEntry(id);
    return request(`/api/planned-executions/${id}/worker-recovery`, { method: 'POST', expected: expectedGenerationId ? 409 : 200,
      body: { enabled, expectedGenerationId: expectedGenerationId ?? entry.execution.generationId,
        expectedDefinitionSha256: entry.status.workerRecovery.definitionSha256 } });
  }
  async function create(label) {
    const created = await request('/api/planned-executions', { method: 'POST', expected: 201, body: {
      name: label, enabled: true, flowId, prompt: 'Synthetic recurring acceptance probe.', overlapStrategy: 'skip',
      startRestriction: 'singleton', trigger: { type: 'schedule', cron, catchUp: true },
    } });
    assert.ok(identifier.test(created.execution?.id) && identifier.test(created.execution?.generationId), 'Local creation identity unavailable.');
    return created.execution;
  }
  const runs = async id => (await request(`/api/planned-executions/${id}/runs`)).runs;
  const initialCalls = providerCount();
  let sample = await snapshot();
  assert.equal(sample.workspace, workspace); assert.equal(sample.worker?.state, 'ready');
  assert.equal(sample.complete, true, 'Acceptance requires a complete diagnostic sample.');
  assert.equal(find(sample, copyId).armed, false);
  assert.equal(find(sample, copyId).recovery?.reason, 'no-local-provenance');
  const completedPlan = await create('Completed local fixture');
  assert.equal(find(await snapshot(), completedPlan.id).recovery?.reason, 'not-opted-in');
  await pauseFor(observeMs);
  assert.equal(providerCount(), initialCalls, 'Copied/unopted-in schedules dispatched the provider.');
  observe({ check: 'copied-and-unenrolled-suppression', providerDispatches: 0, observedMs: observeMs });

  await enrollment(completedPlan.id, true);
  const firstCompleted = await waitFor(async () => (await runs(completedPlan.id)).find(run => run.status === 'completed'),
    'Enrolled local cron did not produce an actual completed engine run.');
  assert.equal(firstCompleted.executionGenerationId, completedPlan.generationId);
  assert.ok(providerCount() > initialCalls, 'Completed run did not reach the loopback provider.');
  const oldRunIds = new Set((await runs(completedPlan.id)).map(run => run.runId));
  await restart({ crash: true, offlineMs });
  const catchupRun = await waitFor(async () => (await runs(completedPlan.id)).find(run => !oldRunIds.has(run.runId) && run.status === 'completed'
    && run.triggerSummary?.includes('missed while FLUJO was closed')), 'Same-worker restart did not complete its bounded catch-up.');
  assert.equal(catchupRun.executionGenerationId, completedPlan.generationId);
  const catchupObservedAt = new Date().toISOString();
  const dispatchesAtCatchup = providerCount();
  const resumedTick = await waitFor(async () => completedTickAfterCatchup(await runs(completedPlan.id), {
    generationId: completedPlan.generationId, catchupRunId: catchupRun.runId, priorRunIds: oldRunIds, observedAt: catchupObservedAt,
  }), 'Ordinary cron recurrence did not complete after the observed startup catch-up.');
  assert.ok(providerCount() > dispatchesAtCatchup, 'Resumed cron result did not reach the provider after catch-up observation.');
  await enrollment(completedPlan.id, false);
  const afterRestart = await waitFor(async () => {
    const history = await runs(completedPlan.id);
    return history.every(run => run.status !== 'running' && run.status !== 'queued') ? history : undefined;
  }, 'Successful fixture retained a nonterminal engine run after enrollment was disabled.');
  const catchups = afterRestart.filter(run => !oldRunIds.has(run.runId) && run.triggerSummary?.includes('missed while FLUJO was closed'));
  assert.equal(catchups.length, 1, 'Restart produced multiple catch-up admissions.');
  assert.equal(new Set(afterRestart.map(run => run.runId)).size, afterRestart.length, 'Duplicate run identity in indexed history.');
  assert.equal(afterRestart.find(run => run.runId === firstCompleted.runId)?.status, 'completed', 'Original completed result lost.');
  assert.equal(providerCount() - initialCalls, afterRestart.filter(run => run.status === 'completed').length,
    'Successful fixture provider dispatches disagree with recorded completed runs.');
  assert.equal(find(await snapshot(), copyId).armed, false);
  observe({ check: 'actual-local-tick-and-same-worker-catchup', generationId: completedPlan.generationId,
    originalRunId: firstCompleted.runId, catchupRunId: catchups[0].runId, catchupAdmissions: catchups.length,
    catchupObservedAt, resumedOrdinaryTickRunId: resumedTick.runId, resumedOrdinaryTickFiredAt: resumedTick.firedAt,
    resumedOrdinaryTickFinishedAt: resumedTick.finishedAt,
    completedEngineRuns: afterRestart.filter(run => run.status === 'completed').length,
    note: 'Additional ordinary ticks, if present, are retained; completed engine outcomes are distinct from external/descendant exit.' });

  const pendingPlan = await create('Interrupted local fixture');
  setProviderMode('hold');
  const beforeInterrupted = providerCount();
  await enrollment(pendingPlan.id, true);
  await waitFor(async () => providerCount() > beforeInterrupted, 'Pending local cron never entered the loopback provider.');
  sample = await snapshot();
  const pendingRunId = find(sample, pendingPlan.id).recovery?.pendingRunId;
  assert.ok(identifier.test(pendingRunId ?? ''), 'Entered run had no retained admission identity.');
  const privateBefore = await readPrivateRecord(pendingPlan.id);
  const enteredDispatches = providerCount() - beforeInterrupted;
  await restart({ crash: true, offlineMs });
  setProviderMode('success');
  const callsAfterCrash = providerCount();
  assert.equal(callsAfterCrash, beforeInterrupted + enteredDispatches, 'Worker startup replayed the interrupted dispatch.');
  await pauseFor(observeMs);
  sample = await snapshot();
  assert.equal(find(sample, pendingPlan.id).armed, false);
  assert.equal(find(sample, pendingPlan.id).recovery?.reason, 'unresolved-admission');
  assert.equal(find(sample, pendingPlan.id).recovery?.pendingRunId, pendingRunId);
  assert.equal(providerCount(), callsAfterCrash, 'Restart replayed an interrupted provider dispatch.');
  assert.equal(digest(await readPrivateRecord(pendingPlan.id)), digest(privateBefore), 'Diagnostic/restart changed retained admission.');
  await enrollment(pendingPlan.id, true, 'stale-generation');
  for (let attempt = 0; attempt < 2; attempt++) await request('/api/planned-executions/reconcile', { method: 'POST' });
  await pauseFor(observeMs);
  assert.equal(providerCount(), callsAfterCrash, 'Repeated reconciliation/stale enrollment bypassed unresolved work.');
  assert.equal(find(await snapshot(), copyId).armed, false);
  observe({ check: 'interrupted-dispatch-retained-without-replay', generationId: pendingPlan.generationId,
    pendingRunId, receivedProviderDispatches: enteredDispatches, replacementDispatches: 0,
    privateRecordSha256: digest(privateBefore), observedMs: observeMs * 2,
    outcome: 'uncertain-provider-dispatch; no successful-effect or process-exit claim' });

  await restart({ crash: true, epoch: 2 });
  await pauseFor(observeMs);
  sample = await snapshot();
  assert.equal(find(sample, pendingPlan.id).recovery?.reason, 'worker-authority-changed');
  assert.equal(find(sample, pendingPlan.id).armed, false);
  assert.equal(providerCount(), callsAfterCrash, 'Changed worker epoch admitted replacement work.');
  assert.equal(digest(await readPrivateRecord(pendingPlan.id)), digest(privateBefore));
  assert.equal(find(sample, copyId).armed, false);
  observe({ check: 'changed-epoch-fences-private-admission', changedEpoch: 2, replacementDispatches: 0,
    observedMs: observeMs, retainedPrivateRecordSha256: digest(privateBefore) });

  return { schemaVersion: 1, scenario: 'worker-local-recurring-recovery', observedAt: new Date().toISOString(),
    runtimeIdentitySelfReport: sample.identity, workspace, cron, observationContract: observationRoute === 'operations'
      ? 'read-only-operations-sample' : 'ordinary-scheduler-list-can-reconcile', observations,
    provider: { kind: 'loopback-synthetic', totalReceivedDispatches: providerCount() - initialCalls, originalPaidProviderCalls: 0 },
    limits: ['Engine/HTTP/cron behavior only; installed artifact identity requires independent source/build/image evidence.',
      'No human operator/independent review; no exactly-once remote effects; no descendant or isolated-container removal proof.',
      'Held provider dispatch remains uncertain and retained; this fixture never force-clears its admission.',
      'Auth expiry, provider timeout/429/400, disk full, migration/upgrade/rollback are separate acceptance cases.'] };
}
