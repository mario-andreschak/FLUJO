'use strict';
const assert = require('node:assert/strict');
const { hash } = require('./profile.cjs');
const ARCHIVE_REFUSALS = new Set(['MODEL_TURN_ARCHIVE_MEMORY_LIMIT', 'MODEL_TURN_ARCHIVE_MEMORY_BUSY']);
const TERMINAL_MARKER = 'deterministic_terminal_400';
const TERMINAL_CODE = 'qualification_terminal_400';
const RETRY_MARKER = 'deterministic_retry';
const completionMarker = (model, batch) => 'completed ' + model + ' batch ' + batch;

function assertSettledDiagnostics(d) {
  for (const [group, fields] of Object.entries({
    flow: ['activeRuns', 'reservedBytes', 'activeWorkspaces', 'workspaceActiveRuns', 'workspaceReservedBytes', 'workspaceConversations'],
    subflowPreparation: ['active', 'reservedBytes'], subflowOutput: ['active', 'reservedBytes'],
    archive: ['bytes', 'writers', 'quarantined'],
    archiveRead: ['activeReads', 'quarantinedReads', 'reservedJsonAllocationBytes', 'cleanupFailures'],
    cache: ['inFlightLoads'],
    publication: ['owners', 'writers', 'allocationBytes', 'retainedBytes', 'queuedWriters', 'chains', 'fences',
      'receipts', 'quarantinedWriterSlots', 'terminalWaiters'],
    ingress: ['active', 'parsing', 'reservedBytes'],
    allocation: ['run', 'preparation', 'output', 'ingress', 'publication', 'total'],
    streams: ['active', 'replayReads', 'workspaces', 'conversations'], gate: ['activeMutations'],
    sequence: ['scanActive', 'scanQuarantined', 'pendingAppendChains', 'pendingCommitConversations', 'pendingCommits'],
  })) for (const field of fields) assert.equal(d[group]?.[field], 0, group + '.' + field + ' did not settle');
  for (const field of ['sessions', 'cancellable', 'conversationLocks']) assert.equal(d[field], 0, field + ' did not settle');
  assert.equal(d.gate.blocked, false, 'Workspace gate remains blocked');
  // Rate keys expire lazily; retained quota/sequence registries are bounded, not cleared for a pass.
  for (const [field, cap] of [['keys', 'maxKeys'], ['keyBytes', 'maxKeyBytes']]) {
    assert(Number.isSafeInteger(d.rate?.[field]) && d.rate[field] >= 0);
    assert(Number.isSafeInteger(d.rate[cap]) && d.rate[cap] > 0 && d.rate[field] <= d.rate[cap], 'Rate registry exceeds ' + cap);
  }
  for (const field of ['capacityRefusals', 'rateRefusals']) assert.equal(d.rate[field], 0, 'Unexpected rate refusal');
  for (const [field, cap] of [['keys', 'maxKeys'], ['keyBytes', 'maxTotalKeyBytes']]) {
    assert(Number.isSafeInteger(d.sequence[field]) && d.sequence[field] >= 0);
    assert(Number.isSafeInteger(d.sequence[cap]) && d.sequence[field] <= d.sequence[cap], 'Sequence registry exceeds ' + cap);
  }
  assert.equal(d.sequence.rejectedNewKeys, 0, 'Workload exhausted sequence registry');
  assert.equal(d.sequence.scanRefusals, 0, 'Workload exhausted sequence scanner admission');
}

function assertChildOutcome(index, lane, state, provider, dispatchCount) {
  const model = 'child-' + index;
  const count = provider.counts[model], outcome = provider.outcomes[model];
  assert(outcome, 'Missing provider outcome counters');
  assert.equal(count, outcome.success + outcome.retry429 + outcome.permanent400);
  if (index < 3) {
    assert.equal(count, 0, 'Completed fixture lane redispatched'); assert.equal(dispatchCount, 0);
    assert.equal(lane.status, 'completed'); assert.equal(state.status, 'completed');
    assert.equal(lane.outputText, 'previously completed fixture lane');
    return { model, kind: 'saved-completed-fixture', physicalRequests: 0 };
  }
  if (count === 0) {
    const code = state.lastResponse?.errorDetails?.code;
    assert.equal(state.status, 'error'); assert.equal(lane.status, 'error'); assert.equal(dispatchCount, 0);
    assert(ARCHIVE_REFUSALS.has(code), 'Missing child dispatch was not a typed pre-SDK archive refusal');
    assert.equal(typeof lane.error, 'string'); assert(lane.error.length > 0);
    return { model, kind: 'pre-sdk-archive-refusal', code, physicalRequests: 0 };
  }
  assert.equal(dispatchCount, 1, 'Each admitted child needs one logical SDK archive dispatch');
  if (index === 3) {
    assert.equal(count, 1); assert.deepEqual(outcome, { success: 0, retry429: 0, permanent400: 1,
      terminalMarker: TERMINAL_MARKER, retryMarker: '', completionMarker: '' });
    assert.equal(state.status, 'error'); assert.equal(lane.status, 'error');
    assert.equal(state.lastResponse?.errorDetails?.code, TERMINAL_CODE);
    assert(String(state.lastResponse?.error).includes(TERMINAL_MARKER), 'Permanent-400 marker missing from child error');
    assert(lane.error.includes(TERMINAL_MARKER), 'Permanent-400 marker missing from lane error');
    return { model, kind: 'permanent-400', marker: TERMINAL_MARKER, physicalRequests: count };
  }
  const marker = completionMarker(model, provider.batch);
  const retries = index === 4 ? 1 : 0;
  assert.equal(count, 1 + retries);
  assert.deepEqual(outcome, { success: 1, retry429: retries, permanent400: 0,
    terminalMarker: '', retryMarker: retries ? RETRY_MARKER : '', completionMarker: marker });
  assert.equal(state.status, 'completed'); assert.equal(lane.status, 'completed'); assert.equal(lane.outputText, marker);
  assert(state.messages.some(message => message.role === 'assistant' && message.content === marker),
    'Exact provider completion marker missing from child history');
  return { model, kind: retries ? 'sdk-retry-completed' : 'completed', marker, physicalRequests: count };
}

function foldIdentity(state, expected) {
  const invocation = state.subflowInvocations?.[expected.id];
  assert.equal(invocation?.status, 'folded'); assert(invocation.foldedAt > 0);
  assert.equal(invocation.resultPresentation, 'separate');
  const receipt = invocation.foldReceipt;
  assert.equal(receipt?.version, 1); assert.equal(receipt.id, expected.id + ':fold:v1');
  assert.equal(receipt.presentation, 'separate'); assert(receipt.continuedAt > 0, 'Continuation was not durably acknowledged');
  assert.equal(state.activeSubflowInvocationByNode?.[expected.parentNodeId], undefined);
  const ids = expected.lanes.map((_, index) => expected.id + ':fold:v1:separate:' + index);
  assert.deepEqual(receipt.messageIds, ids);
  const messages = state.messages.filter(message => message.id?.startsWith(expected.id + ':fold:v1:'));
  assert.deepEqual(messages.map(message => message.id), ids, 'Missing, duplicate or joined fold message');
  assert.deepEqual(invocation.lanes.map(lane => [lane.id, lane.conversationId, lane.subflowId]),
    expected.lanes.map(lane => [lane.id, lane.conversationId, lane.subflowId]));
  messages.forEach((message, index) => {
    assert.equal(message.role, 'assistant'); assert.equal(message.processNodeId, expected.parentNodeId);
    assert.equal(message.subflowResult?.conversationId, expected.lanes[index].conversationId);
    assert.equal(message.subflowResult?.subflowId, expected.lanes[index].subflowId);
    assert.equal(message.subflowResult?.laneIndex, index); assert.equal(message.subflowResult?.laneCount, ids.length);
    assert.equal(message.subflowResult?.status, invocation.lanes[index].status);
  });
  return { receipt: { ...receipt, messageIds: [...receipt.messageIds] }, foldedAt: invocation.foldedAt,
    messagesSha256: hash(JSON.stringify(messages)), effectsSha256: hash(JSON.stringify({ variables: state.variables,
      lastResponse: state.lastResponse, captureKvReceipt: invocation.captureKvReceipt })) };
}
module.exports = { assertSettledDiagnostics, assertChildOutcome, foldIdentity, ARCHIVE_REFUSALS,
  TERMINAL_MARKER, TERMINAL_CODE, RETRY_MARKER, completionMarker };
