import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
const argumentDigest = text => digest(JSON.stringify(JSON.parse(text)));
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hashValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value, label) => {
  if (!identity(value)) throw new Error(`Invalid ${label} metadata.`);
  return value;
};
const optionalText = (value, label) => value === undefined ? undefined : text(value, label);
const counter = (value, label, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`Invalid ${label} metadata.`);
  return value;
};
const oneOf = (value, allowed, label) => {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`Invalid ${label} metadata.`);
  return value;
};
const roles = ['system', 'developer', 'user', 'assistant', 'tool', 'function'];
const eventTypes = new Set(['run:start', 'run:paused', 'run:awaiting_approval', 'run:awaiting_elicitation',
  'run:awaiting_question', 'run:done', 'recovery:checkpoint', 'recovery:transition', 'recovery:retry',
  'node:enter', 'node:exit', 'node:snapshot', 'node:changed-files', 'model:start', 'model:dispatch',
  'model:dispatch-result', 'model:delta', 'model:end', 'tool:call', 'tool:progress', 'tool:result',
  'handoff', 'usage', 'message', 'message:removed', 'subflow:start', 'subflow:done', 'resource:read',
  'resource:write', 'todo:update', 'breakpoint:hit', 'error']);
const contentBindingValid = value => value?.serialization === 'utf8-string-v1'
  && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
  && Number.isSafeInteger(value.bytes) && value.bytes >= 0;
const contentBinding = text => ({ serialization: 'utf8-string-v1', sha256: digest(text), bytes: Buffer.byteLength(text) });
const contentBindingsEqual = (left, right) => contentBindingValid(left) && contentBindingValid(right)
  && left.serialization === right.serialization && left.sha256 === right.sha256 && left.bytes === right.bytes;

/** Admit only the owned fixture's bounded primitives, before a receipt enters any report. */
export function projectFixtureReceipt(value, expectedDefinitionSha256, expectedVersion = '1.0.0') {
  if (!record(value) || !hashValid(expectedDefinitionSha256) || value.definitionSha256 !== expectedDefinitionSha256
    || value.fixtureVersion !== expectedVersion || !identity(value.runId)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.runId)) {
    throw new Error('Invalid selected fixture receipt identity.');
  }
  const toolCalls = counter(value.toolCalls, 'fixture tool count');
  const acceptedCalls = counter(value.acceptedCalls, 'fixture accepted count', toolCalls);
  if (!Array.isArray(value.recentCalls) || value.recentCalls.length !== Math.min(toolCalls, 64)) {
    throw new Error('Invalid fixture receipt window.');
  }
  const recentCalls = value.recentCalls.map((call, index) => {
    if (!record(call) || call.sequence !== toolCalls - value.recentCalls.length + index + 1
      || typeof call.toolName !== 'string' || !/^fixture_tool_(?:00[1-9]|0[1-9][0-9]|1[01][0-9]|12[0-8])$/.test(call.toolName)
      || !hashValid(call.argumentsSha256) || typeof call.accepted !== 'boolean') {
      throw new Error('Invalid fixture invocation receipt.');
    }
    return { sequence: call.sequence, toolName: call.toolName, argumentsSha256: call.argumentsSha256, accepted: call.accepted };
  });
  return { runId: value.runId, fixtureVersion: expectedVersion, definitionSha256: expectedDefinitionSha256,
    mode: oneOf(value.mode, ['normal', 'fail-second-page', 'cycle', 'empty', 'delay'], 'fixture mode'),
    delayMs: counter(value.delayMs, 'fixture delay', 30000), listRequests: counter(value.listRequests, 'fixture list count'),
    toolCalls, acceptedCalls, recentCalls };
}

export const projectConversationStatus = value => value === undefined ? undefined : oneOf(value,
  ['running', 'awaiting_tool_approval', 'paused_debug', 'completed', 'error', 'capped'], 'conversation status');

/** The selected fixture advertises exactly 128 ordered names; admit a page before accumulating it. */
export function projectFixtureToolPage(value, discoveredCount) {
  counter(discoveredCount, 'discovered tool count', 128);
  if (!record(value) || !Array.isArray(value.tools) || value.tools.length > 128 - discoveredCount) {
    throw new Error('Fixture discovery exceeds the selected tool count.');
  }
  const tools = value.tools.map((tool, index) => {
    const expected = `fixture_tool_${String(discoveredCount + index + 1).padStart(3, '0')}`;
    if (tool?.name !== expected) throw new Error('Unexpected selected fixture tool identity.');
    return expected;
  });
  return { tools, nextCursor: optionalText(value.nextCursor, 'fixture discovery cursor') };
}

/** Count retained projections across every response, not just a single bounded JSON body. */
export function createProjectionBudget(maximumBytes = 16 * 1024 * 1024) {
  counter(maximumBytes, 'projection byte limit');
  let retainedBytes = 0;
  return {
    admit(value) {
      const serialized = JSON.stringify(value, null, 2);
      if (typeof serialized !== 'string') throw new Error('Invalid retained projection.');
      const bytes = Buffer.byteLength(serialized);
      if (bytes > maximumBytes - retainedBytes) throw new Error('Retained projections exceed their aggregate byte budget.');
      retainedBytes += bytes;
      return value;
    },
    usedBytes: () => retainedBytes,
    maximumBytes,
  };
}

export function serializeEvidenceReport(value, maximumBytes = 32 * 1024 * 1024) {
  counter(maximumBytes, 'report byte limit');
  const serialized = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > maximumBytes) throw new Error('Evidence report exceeds its output byte budget.');
  return serialized;
}

export function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use the owner-selected explicit HTTP loopback origin.');
  }
  return url.origin;
}

/** The owner supplies authentication through fetchImpl; this module transfers no credentials. */
export function ownerRequest(baseURL, workspace, fetchImpl = fetch) {
  const origin = loopbackOrigin(baseURL);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workspace)) throw new Error('Invalid workspace.');
  return async (route, { signal } = {}) => {
    if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Expected a same-instance route.');
    const url = new URL(route, origin);
    if (url.origin !== origin) throw new Error('Unexpected request origin.');
    url.searchParams.set('workspace', workspace);
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal });
    if (!response.ok) throw new Error(`Owner candidate GET ${url.pathname} returned ${response.status}.`);
    return response;
  };
}

export async function boundedJson(response, maximumBytes = 2 * 1024 * 1024) {
  if (!response.body) throw new Error('Response has no body.');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) throw new Error('Observer JSON response exceeds its limit.');
      chunks.push(Buffer.from(next.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Retain correlation and hashes, never model text, raw tool arguments or SDK request objects. */
export function projectEvent(event, conversationId) {
  if (!record(event) || !identity(conversationId) || event.conversationId !== conversationId
    || !Number.isSafeInteger(event.seq) || event.seq < 0 || !eventTypes.has(event.type)
    || !Number.isFinite(event.timestamp) || event.timestamp < 0) {
    throw new Error('Execution event has an invalid conversation identity or sequence.');
  }
  const row = { seq: event.seq, timestamp: event.timestamp, type: event.type,
    depth: counter(event.depth === undefined ? 0 : event.depth, 'event depth') };
  if (event.type === 'run:start') row.flowId = text(event.flowId, 'flow identity');
  if (event.type === 'run:done') row.status = oneOf(event.status, ['completed', 'error', 'capped'], 'run status');
  if (event.type === 'run:paused') {
    row.reason = oneOf(event.reason, ['debug', 'breakpoint'], 'pause reason');
    if (event.phase !== undefined) row.phase = oneOf(event.phase, ['before-node', 'after-node', 'before-model',
      'after-model', 'before-tool', 'after-tool', 'before-handoff', 'after-handoff'], 'pause phase');
  }
  if (event.type === 'run:awaiting_approval') {
    if (!Array.isArray(event.pendingToolCalls) || event.pendingToolCalls.length > 10000) {
      throw new Error('Invalid pending tool-call metadata.');
    }
    row.pendingToolCallIds = event.pendingToolCalls.map(call => text(call?.id, 'pending tool identity'));
  }
  if (event.type === 'model:dispatch') {
    if (event.turn?.conversationId !== conversationId || !identity(event.turn?.id)) {
      throw new Error('Model dispatch belongs to another conversation.');
    }
    row.dispatchId = event.turn.id; row.modelId = text(event.turn.modelId, 'model identity');
    row.adapter = text(event.turn.adapter, 'model adapter');
  }
  if (event.type === 'model:dispatch-result') {
    row.dispatchId = text(event.dispatchId, 'dispatch identity');
    row.outcome = oneOf(event.outcome, ['completed', 'error', 'cancelled'], 'dispatch outcome');
  }
  if (event.type === 'tool:call' || event.type === 'tool:result') {
    row.toolCallId = text(event.toolCallId, 'tool-call identity'); row.name = text(event.name, 'tool name');
    if (event.type === 'tool:call') {
      if (event.args !== undefined && typeof event.args !== 'string') throw new Error('Invalid tool argument representation.');
      row.argumentsSha256 = argumentDigest(event.args ?? '{}');
    }
    else {
      if (event.result !== undefined && typeof event.result !== 'string') throw new Error('Invalid tool preview representation.');
      if (event.isError !== undefined && typeof event.isError !== 'boolean') throw new Error('Invalid tool error metadata.');
      row.isError = event.isError === true; row.resultSha256 = digest(event.result ?? '');
      row.resultBytes = Buffer.byteLength(event.result ?? '');
      // This hash is emitted over the full tool-message string, not its display preview.
      if (event.resultContentBinding !== undefined) {
        if (!contentBindingValid(event.resultContentBinding)) throw new Error('Invalid runtime tool-result content binding.');
        const { serialization, sha256, bytes } = event.resultContentBinding;
        row.resultContentBinding = { serialization, sha256, bytes };
      }
    }
  }
  if (event.type === 'message') {
    if (!record(event.message)) throw new Error('Invalid message metadata.');
    row.messageId = optionalText(event.message.id, 'message identity'); row.role = oneOf(event.message.role, roles, 'message role');
    const content = event.message?.content;
    if (content !== undefined && content !== null && typeof content !== 'string' && !Array.isArray(content)) {
      throw new Error('Invalid message content representation.');
    }
    if (Array.isArray(content) && content.some(part => !record(part)
      || (part.type === 'text' && typeof part.text !== 'string'))) throw new Error('Invalid message text representation.');
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(part => part.type === 'text').map(part => part.text ?? '').join('') : '';
    row.textBytes = Buffer.byteLength(text); row.textSha256 = digest(text);
    if (event.message.tool_calls !== undefined && !Array.isArray(event.message.tool_calls)) throw new Error('Invalid message tool-call metadata.');
    row.hasToolCalls = (event.message.tool_calls?.length ?? 0) > 0;
  }
  return row;
}

/** Observe an already-created UI conversation; starting/resuming/approving runs stays with its owner. */
export async function collectLiveEvents(response, conversationId, { onEvent = () => {}, maximumBytes = 16 * 1024 * 1024 } = {}) {
  if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
    throw new Error('Expected the candidate execution SSE stream.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const rows = [];
  let pending = '';
  let receivedBytes = 0;
  let lastSeq = -1;
  let done = false;
  const drain = () => {
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      if (Buffer.byteLength(data) > 256 * 1024) throw new Error('Execution event exceeds 256 KiB.');
      const row = projectEvent(JSON.parse(data), conversationId);
      if (row.seq <= lastSeq) throw new Error('Execution stream repeated or reordered an event.');
      if (rows.length >= 10000) throw new Error('Execution stream exceeds 10000 events.');
      lastSeq = row.seq; rows.push(row); onEvent(row);
      if (row.type === 'run:done' && row.depth === 0) { done = true; break; }
    }
    if (Buffer.byteLength(pending) > 256 * 1024) throw new Error('Unterminated SSE frame exceeds 256 KiB.');
  };
  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) { pending += decoder.decode(); drain(); break; }
      receivedBytes += next.value.byteLength;
      if (receivedBytes > maximumBytes) throw new Error('Execution stream exceeds its byte budget.');
      pending += decoder.decode(next.value, { stream: true }); drain();
    }
    if (!done) throw new Error('Execution stream ended before a terminal top-level run.');
    return rows;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function projectModelInput(snapshot, conversationId, dispatchId) {
  if (!record(snapshot) || !identity(conversationId) || !identity(dispatchId)
    || snapshot.entry?.id !== dispatchId || snapshot.entry?.conversationId !== conversationId
    || !Array.isArray(snapshot.genericWire)) throw new Error('Model input archive identity mismatch.');
  return { dispatchId, modelId: text(snapshot.entry.modelId, 'archived model identity'),
    adapter: text(snapshot.entry.adapter, 'archived model adapter'),
    wireToolResults: snapshot.genericWire.filter(message => message?.role === 'tool').map(message => ({
      toolCallId: text(message.tool_call_id, 'archived tool-call identity'),
      // No JSON reparsing, object serialization or text-array concatenation: the
      // producer contract is the exact UTF-8 string actually stored in the message.
      ...(typeof message.content === 'string' ? { contentBinding: contentBinding(message.content) }
        : { unsupportedContentRepresentation: true }),
    })) };
}

export function evaluateLiveJourney({ events, modelInputs, fixtureBefore, fixtureAfter, flowId, modelId, toolName,
  fixtureToolName = toolName }) {
  const top = events.filter(event => event.depth === 0);
  const starts = top.filter(event => event.type === 'run:start');
  const terminal = top.findLast(event => event.type === 'run:done');
  const calls = top.filter(event => event.type === 'tool:call' && event.name === toolName);
  const dispatches = top.filter(event => event.type === 'model:dispatch' && event.modelId === modelId);
  const completed = new Set(top.filter(event => event.type === 'model:dispatch-result' && event.outcome === 'completed')
    .map(event => event.dispatchId));
  const receipts = fixtureAfter.recentCalls?.filter(receipt => receipt.sequence > fixtureBefore.toolCalls) ?? [];
  const unmatchedReceipts = [...receipts];
  const matched = calls.filter(call => {
    const index = unmatchedReceipts.findIndex(receipt => receipt.accepted === true
      && receipt.toolName === fixtureToolName && receipt.argumentsSha256 === call.argumentsSha256);
    if (index < 0) return false;
    unmatchedReceipts.splice(index, 1); return true;
  });
  const consumed = matched.filter(call => {
    const results = top.filter(event => event.type === 'tool:result' && event.toolCallId === call.toolCallId
      && event.name === call.name && event.seq > call.seq);
    if (results.length !== 1) return false;
    const result = results[0];
    return !result.isError && result.resultBytes > 0 && contentBindingValid(result.resultContentBinding)
      && result.resultContentBinding.bytes > 0
      && dispatches.some(dispatch => dispatch.seq > result.seq && completed.has(dispatch.dispatchId)
      && modelInputs.some(input => {
        const tools = input.wireToolResults.filter(tool => tool.toolCallId === call.toolCallId);
        return input.dispatchId === dispatch.dispatchId && input.modelId === modelId
          && input.adapter === dispatch.adapter && tools.length === 1
          && contentBindingsEqual(result.resultContentBinding, tools[0].contentBinding);
      })
      && top.some(event => event.type === 'message' && event.role === 'assistant' && !event.hasToolCalls
        && event.textBytes > 0 && event.seq > dispatch.seq));
  });
  const checks = {
    intendedFlow: starts.length > 0 && starts.every(event => event.flowId === flowId),
    completedRun: terminal?.status === 'completed',
    intendedModelDispatchCompleted: dispatches.some(dispatch => completed.has(dispatch.dispatchId)),
    sameFixtureRun: fixtureBefore.runId === fixtureAfter.runId && fixtureBefore.definitionSha256 === fixtureAfter.definitionSha256,
    allNewFixtureCallsAccepted: receipts.length === fixtureAfter.toolCalls - fixtureBefore.toolCalls
      && receipts.length > 0 && receipts.every(receipt => receipt.accepted === true)
      && fixtureAfter.acceptedCalls - fixtureBefore.acceptedCalls === receipts.length,
    fixtureSequenceContinuous: receipts.every((receipt, index) => receipt.sequence === fixtureBefore.toolCalls + index + 1),
    runtimeCallIdsUnique: new Set(calls.map(call => call.toolCallId)).size === calls.length,
    allExpectedCallsCorrelated: calls.length > 0 && matched.length === calls.length && receipts.length === calls.length,
    toolResultInLaterModelInput: calls.length > 0 && consumed.length === calls.length,
    approvalBoundaryObserved: matched.some(call => top.some(event => event.type === 'run:awaiting_approval'
      && event.seq < call.seq && event.pendingToolCallIds.includes(call.toolCallId))),
    debuggerBoundaryObserved: top.some(event => event.type === 'run:paused'
      && ['debug', 'breakpoint'].includes(event.reason)),
  };
  return { checks, componentPassed: Object.values(checks).every(Boolean),
    correlatedToolCallIds: matched.map(call => call.toolCallId), modelInputToolCallIds: consumed.map(call => call.toolCallId),
    limits: ['Exact runtime/archive UTF-8 content binding does not authenticate a real provider or prove semantic consumption.',
      'Missing producer bindings, changed/compacted/redacted content and unsupported wire representations remain incomplete.',
      'Approval/debugger runtime boundaries do not prove UI interaction, approving human identity or accessibility.',
      'Artifact/source binding, fresh UI setup, model test, upgrades, other profiles/features and human reassessment remain separate.'],
    fullFeatureAcceptance: false, gradeAwarded: false };
}
