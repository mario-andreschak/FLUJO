'use strict';
const crypto = require('node:crypto');
const { PROFILE, hash } = require('./profile.cjs');
function history(id, characters) {
  // Materialized, distinct deterministic strings, not ropes or repeating blocks.
  const content = crypto.createHash('shake256', { outputLength: characters / 2 }).update(PROFILE.version + '/' + id).digest('hex');
  return { messages: [{ id: id + '-history', role: 'user', timestamp: 1, content }], sha256: hash(content) };
}
const node = (id, type, properties = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label: id, properties } });
function flow(model) {
  return { id: model, name: model, nodes: [node('start', 'start'), node('process', 'process', {
    boundModel: model, promptTemplate: 'Return a short completion.', compactionMode: 'off',
  })], edges: [{ id: 'start-process', source: 'start', target: 'process' }] };
}
function parentFlow() {
  return { id: 'parent', name: 'parent', nodes: [node('start', 'start'), node('subflow', 'subflow', {
    subflowId: 'child-0', concurrencyLimit: 4, persistConversation: true, outputMode: 'result',
    resultPresentation: 'separate', errorStrategy: 'collect-all', inputMode: 'full-history',
  })], edges: [{ id: 'start-subflow', source: 'start', target: 'subflow' }] };
}
function state(id, definition, messages, status = 'running') {
  return { conversationId: id, flowId: definition.id, flowSnapshot: definition, messages,
    status, title: 'Runtime memory qualification', createdAt: Date.now(), updatedAt: Date.now(),
    trackingInfo: { executionId: crypto.randomUUID(), startTime: Date.now(), nodeExecutionTracker: [] },
    variables: {}, debugMode: false };
}
function family(batch) {
  const prefix = 'memory-' + batch + '-' + crypto.randomUUID();
  const parentHistory = history(prefix + '-parent', PROFILE.parentCharacters);
  const parent = state(prefix + '-parent', parentFlow(), parentHistory.messages);
  parent.currentNodeId = 'subflow';
  const children = PROFILE.childCharacters.map((size, index) => {
    const id = prefix + '-child-' + index;
    const fixture = history(id, size);
    const child = state(id, flow('child-' + index), fixture.messages, index < 3 ? 'completed' : 'error');
    child.parentRunId = parent.conversationId; child.runDepth = 1;
    child.currentNodeId = 'process';
    if (index < 3) child.lastResponse = 'previously completed fixture lane';
    return { state: child, sha256: fixture.sha256 };
  });
  const invocation = { version: 1, id: prefix + '-invocation', parentConversationId: parent.conversationId,
    parentNodeId: 'subflow', parentRunId: parent.conversationId, status: 'running', depth: 1,
    showSteps: false, concurrencyLimit: 4, joinSeparator: '\n', errorStrategy: 'collect-all', resultPresentation: 'separate',
    createdAt: Date.now(), updatedAt: Date.now(), lanes: children.map(({ state: child }, index) => ({
      id: prefix + '-lane-' + index, laneId: prefix + '-lane-' + index, subflowId: child.flowId,
      conversationId: child.conversationId, index, count: 8,
      status: index < 3 ? 'completed' : index === 3 ? 'error' : 'pending', attempt: index < 4 ? 1 : 0,
      updatedAt: Date.now(), input: { messages: child.messages },
      ...(index < 3 ? { outputText: child.lastResponse } : {}),
    })) };
  parent.subflowInvocations = { [invocation.id]: invocation };
  parent.activeSubflowInvocationByNode = { subflow: invocation.id };
  parent.logicalRunId = prefix + '-logical-run';
  return { prefix, parent, children, invocation, parentSha256: parentHistory.sha256 };
}
module.exports = { history, flow, parentFlow, state, family };
