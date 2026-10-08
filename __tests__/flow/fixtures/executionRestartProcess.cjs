'use strict';
// #571 source-process witness. The loader supplies only catalogue/key fixtures;
// orchestration, graph nodes, SDK, storage, recovery and archive code are real.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const ts = require('typescript');
const instanceId = require('node:crypto').randomUUID();
const repository = process.cwd();
const [phase, conversationId, baseUrl] = process.argv.slice(2);
assert.ok(['pause', 'resume'].includes(phase));
assert.ok(/^process-ordering-[a-f0-9-]{36}$/.test(conversationId));
assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
assert.ok(process.send, 'Fixture requires its parent-owned IPC channel.');
const observations = [];
const record = operation => observations.push(operation);
const report = value => new Promise((resolve, reject) => process.send({ ...value, instanceId, pid: process.pid, parentPid: process.ppid }, error => error ? reject(error) : resolve()));
const definition = {
  id: conversationId, name: 'Source restart fixture',
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'start', type: 'start', properties: {} } },
    { id: 'process', type: 'process', position: { x: 0, y: 0 }, data: { label: 'process', type: 'process', properties: { boundModel: 'restart-model' } } },
  ],
  edges: [{ id: 'start-process', source: 'start', target: 'process', data: { edgeType: 'standard' } }],
};
const catalogue = {
  flow: { flowService: { getFlow: async () => definition, loadFlows: async () => [definition] } },
  model: { modelService: {
    getModel: async id => ({ id, name: 'restart-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl }),
    loadModels: async () => [{ id: 'restart-model', name: 'restart-fixture' }],
    resolveAndDecryptApiKey: async () => 'loopback-fixture-key',
  } },
};
const originalLoad = Module._load;
const originalResolve = Module._resolveFilename;
// Match the existing Persona source-process loader and Jest's explicit mapping
// for this installed import-only dependency; the actual library still executes.
const dependencyRoot = path.dirname(path.dirname(require.resolve('typescript/package.json')));
const stdioOAuthDist = path.join(dependencyRoot, 'mcp-stdio-oauth/dist');
const stdioOAuthSubpaths = new Map([
  ['mcp-stdio-oauth/client', path.join(stdioOAuthDist, 'client/index.js')],
  ['mcp-stdio-oauth/client/transport', path.join(stdioOAuthDist, 'client/transport.js')],
  ['mcp-stdio-oauth/protocol', path.join(stdioOAuthDist, 'protocol/index.js')],
]);
function sourcePath(request, parent) {
  if (request.startsWith('@/')) return path.join(repository, 'src', request.slice(2));
  if (request.startsWith('.')) return path.resolve(path.dirname(parent.filename), request);
  if (path.isAbsolute(request)) return request;
  return '';
}
Module._load = function loadWithCatalogueFixture(request, parent, isMain) {
  const requested = sourcePath(request, parent).replaceAll('\\', '/').replace(/\.(?:ts|js)$/, '').replace(/\/index$/, '');
  for (const name of ['flow', 'model']) {
    if (requested === path.join(repository, 'src/backend/services', name).replaceAll('\\', '/')) return catalogue[name];
  }
  return originalLoad.call(this, request, parent, isMain);
};
Module._resolveFilename = function resolveSourceAlias(request, parent, isMain, options) {
  if (stdioOAuthSubpaths.has(request)) request = stdioOAuthSubpaths.get(request);
  else if (request.startsWith('@/')) request = path.join(repository, 'src', request.slice(2));
  return originalResolve.call(this, request, parent, isMain, options);
};
const originalJavaScriptLoader = require.extensions['.js'];
require.extensions['.js'] = (module, filename) => {
  if (!filename.startsWith(stdioOAuthDist + path.sep)) return originalJavaScriptLoader(module, filename);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: {
    allowJs: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  module._compile(output, filename);
};
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  module._compile(output, filename);
};
const fromSource = file => require(path.join(repository, 'src', file));
const journal = fromSource('backend/execution/flow/conversationLog.ts');
const persistence = fromSource('backend/execution/flow/persistConversationState.ts');
const persist = persistence.persistConversationState;
persistence.persistConversationState = async (...args) => {
  const state = args[1];
  if (state.recovery?.currentCheckpoint) {
    const events = await journal.readConversationLog(conversationId);
    assert.ok(events.some(event => event.type === 'recovery:checkpoint' && event.checkpoint.id === state.recovery.currentCheckpoint.id),
      'Snapshot would precede its durable checkpoint journal entry.');
    record(`durable-checkpoint:${state.recovery.currentCheckpoint.phase}`);
  }
  await persist(...args);
  record(`snapshot:${state.recovery?.classification}`);
};
const archive = fromSource('backend/execution/flow/modelTurnArchive.ts');
const archiveDispatch = archive.archiveModelDispatch;
archive.archiveModelDispatch = async (...args) => {
  const entry = await archiveDispatch(...args);
  record('archive:dispatch');
  return entry;
};
const archiveOutcome = archive.updateModelDispatchOutcome;
archive.updateModelDispatchOutcome = async (...args) => {
  await archiveOutcome(...args);
  record(`archive-outcome:${args[2]}`);
};
const { executionEventBus } = fromSource('backend/execution/flow/engine/ExecutionEventBus.ts');
const unsubscribe = executionEventBus.subscribeGlobal(({ event }) => {
  if (event.conversationId !== conversationId) return;
  if (event.type === 'recovery:transition') record(`event:recovery:${event.recovery.classification}`);
  else if (event.type === 'recovery:checkpoint') record(`event:checkpoint:${event.checkpoint.phase}`);
  else record(`event:${event.type}`);
});
const { runFlow } = fromSource('backend/execution/flow/runFlow.ts');
const { loadItem } = fromSource('utils/storage/backend.ts');
const { mcpService } = fromSource('backend/services/mcp/index.ts');
const input = { conversationId, flowDefinition: definition, source: 'api', mode: 'conversation',
  executionAuthority: { signal: new AbortController().signal, assertCurrent: async () => record('authority:current') } };
(async () => {
  if (phase === 'pause') {
    const initial = await runFlow({ ...input, prompt: 'Test restart ordering.', debug: true, userTurn: true });
    assert.equal(initial.status, 'paused_debug');
    await runFlow({ ...input, prompt: undefined, userTurn: false });
    const paused = await runFlow({ ...input, prompt: undefined, userTurn: false });
    assert.equal(paused.status, 'paused_debug');
    assert.equal(paused.sharedState.debugPendingAction.action, 'FINAL_RESPONSE');
    await journal.flushConversationLog(conversationId);
    const snapshot = await loadItem(`conversations/${conversationId}`, undefined);
    assert.equal(snapshot.debugPendingAction.action, 'FINAL_RESPONSE');
    assert.equal(snapshot.recovery.classification, 'paused');
    assert.equal(snapshot.executionAuthority, undefined);
    await report({ kind: 'paused', status: paused.status, runId: paused.runId,
      attemptId: snapshot.recovery.attemptId, observations });
    setInterval(() => {}, 1000);
    return;
  }
  const stored = await loadItem(`conversations/${conversationId}`, undefined);
  assert.equal(stored.debugPendingAction.action, 'FINAL_RESPONSE');
  record('restart:read-saved-action');
  const result = await runFlow({ ...input, prompt: undefined, userTurn: false });
  assert.equal(result.status, 'completed');
  await journal.flushConversationLog(conversationId);
  const snapshot = await loadItem(`conversations/${conversationId}`, undefined);
  assert.equal(snapshot.recovery.classification, 'completed');
  assert.equal(snapshot.debugPendingAction, undefined);
  const teardown = await mcpService.disconnectAll('execution-restart-fixture');
  assert.equal(teardown.failed.length, 0);
  assert.equal(teardown.shutdownReceipts.length, 0, 'This fixture must not launch an MCP process.');
  unsubscribe();
  await report({ kind: 'completed', status: result.status, runId: result.runId, attemptId: snapshot.recovery.attemptId,
    outputText: result.outputText, observations });
  process.disconnect();
})().catch(async error => {
  process.stderr.write(String(error.stack || error) + '\n');
  await report({ kind: 'failed', error: String(error), observations }).catch(() => {});
  process.exit(1);
});
