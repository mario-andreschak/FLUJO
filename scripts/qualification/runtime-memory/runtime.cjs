'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { PerformanceObserver, monitorEventLoopDelay } = require('node:perf_hooks');
const { PROFILE, profileSha256, harnessDigest, hash, readJson, sourceManifestHash } = require('./profile.cjs');
const { BoundedJsonl, directoryBytes, DrainWindows } = require('./evidence.cjs');
const { allocationWindowLabel, BatchAllocationSampler } = require('./inspector-evidence.cjs');
const { family, flow, history } = require('./fixtures.cjs');
const { assertSettledDiagnostics, assertChildOutcome, foldIdentity, TERMINAL_CODE, TERMINAL_MARKER, RETRY_MARKER } = require('./checks.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main(output) {
  const contract = readJson(path.join(output, 'contract.json'));
  assert.equal(contract.profileSha256, profileSha256);
  assert.equal(contract.harnessSha256, harnessDigest());
  assert(!process.execArgv.some(arg => /expose-gc|max-old-space-size/.test(arg)) && !process.env.NODE_OPTIONS,
    'No forced-GC or heap overrides');
  process.env.FLUJO_DATA_DIR = path.join(output, 'data');
  if (process.platform === 'linux') {
    assert.equal(fs.realpathSync(output), output, 'Linux dataset path must not redirect');
    assert.equal(fs.statfsSync(output).type, 0xef53, 'Linux workload requires ext4');
    assert.equal(contract.datasetFilesystem?.path, output);
    const directory = fs.statSync(output);
    assert.equal(directory.dev, contract.datasetFilesystem.device);
    assert.equal(directory.ino, contract.datasetFilesystem.inode);
  }
  delete process.env.FLUJO_PARENT_DATA_DIR;
  process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  const provider = readJson(path.join(output, 'provider-ready.json'));
  const providerUrl = new URL(provider.origin);
  assert.equal(providerUrl.hostname, '127.0.0.1');
  require('./network-guard.cjs').installLoopbackGuard(Number(providerUrl.port));
  const loader = require('./source-loader.cjs').installSourceLoader(contract.root, contract.dependencies);
  const load = loader.load;
  await load('backend/services/workspace/migration.ts').migrateWorkspaceLayout();
  const secure = load('utils/encryption/secure.ts');
  const password = 'disposable-runtime-memory-v1';
  assert(await secure.initializeEncryption(password)); assert(await secure.authenticate(password));
  const encrypted = await load('backend/services/model/encryption.ts').encryptApiKey(contract.token);
  const storage = load('utils/storage/backend.ts');
  const names = require('./provider.cjs').MODEL_NAMES;
  await storage.saveItem('models', names.map(name => ({ id: name, name, displayName: name,
    provider: 'openai', adapter: 'openai', ApiKey: encrypted, baseUrl: provider.origin + '/v1',
    inputModalities: ['text'], outputModalities: ['text'] })));
  const { flowService } = load('backend/services/flow/index.ts');
  for (const name of names) assert.equal((await flowService.saveFlow(flow(name))).success, true);
  const { runFlow } = load('backend/execution/flow/runFlow.ts');
  const { FlowExecutor } = load('backend/execution/flow/FlowExecutor.ts');
  const cache = load('backend/execution/flow/conversationStateCache.ts');
  const logs = load('backend/execution/flow/conversationLog.ts');
  const archive = load('backend/execution/flow/modelTurnArchive.ts');
  const archiveBudget = load('backend/execution/flow/modelTurnArchiveWriteBudget.ts');
  const archiveRead = load('backend/execution/flow/modelTurnArchiveReadBudget.ts');
  const admission = load('backend/execution/flow/runAdmission.ts');
  // The qualification base must include the separately delivered preparation fix.
  const subflowBudget = load('backend/execution/flow/subflowPreparationBudget.ts');
  const subflowOutput = load('backend/execution/flow/subflowOutputBudget.ts');
  const publication = load('backend/execution/flow/conversationPublication.ts');
  const ingress = load('utils/http/chatIngress.ts');
  const rate = load('utils/http/chatRateLimit.ts');
  const allocation = load('backend/execution/flow/allocationReservations.ts');
  assert.equal(typeof logs.getConversationSequenceDiagnostics, 'function', 'Integrated sequence diagnostics are required');
  const { SubflowNode } = load('backend/execution/flow/nodes/SubflowNode.ts');
  const subflowRecovery = load('backend/execution/flow/subflowRecovery.ts');
  const session = load('backend/execution/flow/sessionManagement.ts');
  const gate = load('backend/services/workspace/workspaceMutationGate.ts');
  const { executionEventBus: bus } = load('backend/execution/flow/engine/ExecutionEventBus.ts');
  const streams = load('backend/execution/flow/engine/executionStream.ts');
  const { persistConversationState: persist } = load('backend/execution/flow/persistConversationState.ts');
  const records = new BoundedJsonl(path.join(output, 'runtime-samples.jsonl'));
  const phases = new BoundedJsonl(path.join(output, 'batches.jsonl'));
  const windows = new DrainWindows();
  const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
  let gcCount = 0, gcDurationMs = 0, phase = 'initialized', batch = 0, started = performance.now(), epoch = 'warmup';
  let peakRss = 0, fatal, timer, completed = false;
  const observer = new PerformanceObserver(list => { for (const event of list.getEntries()) { gcCount++; gcDurationMs += event.duration; } });
  observer.observe({ entryTypes: ['gc'] });
  const eventCounts = Object.create(null);
  const dispatches = new Map();
  const unsubscribe = bus.subscribeGlobal(({ event }) => {
    assert(Object.keys(eventCounts).length < 128 || Object.hasOwn(eventCounts, event.type));
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    if (event.type === 'model:dispatch') {
      const key = event.conversationId + '/' + event.turn.id;
      assert(dispatches.size < 64 || dispatches.has(key), 'Per-batch dispatch receipt cap exceeded');
      dispatches.set(key, { conversationId: event.conversationId, id: event.turn.id });
    }
  });
  const batches = []; // At most 192 fixed-size receipts, never state/messages/events.
  const parked = new Map(); // Exactly three small ownership controls, only during warmup.
  async function providerControl(action, method = 'GET') {
    const response = await fetch(provider.origin + '/control/' + action, { method,
      headers: { authorization: 'Bearer ' + contract.token }, signal: AbortSignal.timeout(10_000) });
    assert(response.ok, 'Loopback control failed: ' + action);
    return action === 'release' ? response.text() : response.json();
  }
  function diagnostics() {
    let cancellable = 0;
    for (const registry of globalThis.__flujoCancellableRuns?.values() ?? []) cancellable += registry.size;
    return { flow: admission.getFlowRunAdmissionDiagnostics(), cache: cache.getConversationCacheDiagnostics(),
      archive: archiveBudget.getArchiveWritePressure(), archiveRead: archiveRead.getModelTurnArchiveReadDiagnostics(),
      streams: streams.executionStreamAdmission.diagnostics(), replay: bus.getReplayPressure(),
      channels: bus.getConversationReplayPressure(), gate: gate.workspaceMutationStatus('default-workspace'),
      subflowPreparation: subflowBudget.getSubflowPreparationDiagnostics(),
      subflowOutput: subflowOutput.getSubflowOutputDiagnostics(), sequence: logs.getConversationSequenceDiagnostics(),
      publication: publication.getConversationPublicationDiagnostics(), ingress: ingress.getChatIngressDiagnostics(),
      rate: rate.getChatRateDiagnostics(), allocation: allocation.getAllocationReservationSnapshot(),
      sessions: session.activeSessionCoordinatorCount(), cancellable,
      conversationLocks: globalThis.__flujoConversationExecutionLocks?.size ?? 0,
    };
  }
  function sample() {
    const memory = process.memoryUsage(); peakRss = Math.max(peakRss, memory.rss);
    const resourceUsage = process.resourceUsage();
    peakRss = Math.max(peakRss, resourceUsage.maxRSS * 1024);
    assert(memory.rss <= PROFILE.budgets.appRss, 'Application RSS exceeds 1 GiB');
    assert(peakRss <= PROFILE.budgets.appRss, 'Application high-water RSS exceeds 1 GiB');
    records.write({ epoch, elapsedMs: performance.now() - started, batch, phase, ...memory, cpu: process.cpuUsage(),
      maxRssBytes: resourceUsage.maxRSS * 1024,
      gcCount, gcDurationMs, eventLoop: { maxMs: loop.max / 1e6, p99Ms: loop.percentile(99) / 1e6 },
      activeResources: process.getActiveResourcesInfo().reduce((counts, kind) => { counts[kind] = (counts[kind] ?? 0) + 1; return counts; }, {}),
      diagnostics: diagnostics(), events: { ...eventCounts } });
    loop.reset(); return memory;
  }
  function assertDrained() {
    const d = diagnostics();
    assertSettledDiagnostics(d);
    for (const [id, owner] of parked) assert.equal(FlowExecutor.conversationStates.get(id), owner.state, 'Parked owner identity changed');
    assert.equal(d.cache.protectedEntries, parked.size, 'Only the exact parked controls may retain live/recovery ownership');
  }
  async function beginInspectorWindow() {
    const Inspector = require('node:inspector');
    const connection = new Inspector.Session(); connection.connect();
    const post = (method, params = {}) => new Promise((resolve, reject) => connection.post(method, params,
      (error, value) => error ? reject(error) : resolve(value)));
    try {
      await post('HeapProfiler.startSampling', { samplingInterval: PROFILE.inspectorInterval,
        includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    } catch (error) { connection.disconnect(); throw error; }
    const startedAtMs = performance.now();
    const done = (async () => {
      try {
        await delay(PROFILE.inspectorWindowMs);
        const { profile } = await post('HeapProfiler.stopSampling');
        const endedAtMs = performance.now();
        // Save a bounded summary, not the entire inspector graph/sample array.
        let nodes = 0, totalSelfSize = 0; const top = [];
        function visit(node, depth) {
          assert(++nodes <= 100_000 && depth <= 512, 'Inspector profile exceeds traversal allowance');
          totalSelfSize += node.selfSize;
          if (node.selfSize) { top.push({ bytes: node.selfSize, functionName: node.callFrame.functionName.slice(0, 160),
            url: node.callFrame.url.slice(0, 300), line: node.callFrame.lineNumber });
            top.sort((a, b) => b.bytes - a.bytes); if (top.length > 100) top.pop(); }
          for (const child of node.children ?? []) visit(child, depth + 1);
        }
        visit(profile.head, 0);
        return { endedAtMs, summary: { nodes, totalSelfSize, top,
          samplingInterval: PROFILE.inspectorInterval, windowMs: PROFILE.inspectorWindowMs } };
      } finally { connection.disconnect(); }
    })();
    return { startedAtMs, done };
  }
  const inspectorReceipts = [];
  const allocationSampler = new BatchAllocationSampler(beginInspectorWindow, record => {
    const bytes = JSON.stringify(record);
    assert(Buffer.byteLength(bytes) <= PROFILE.maxInspectorBytes, 'Inspector summary exceeds fixed allowance');
    fs.writeFileSync(path.join(output, 'inspector-' + record.label + '.json'), bytes, { flag: 'wx' });
    const compact = { ...record }; delete compact.top;
    inspectorReceipts.push({ ...compact, evidenceSha256: hash(bytes) });
  }, () => performance.now());
  async function terminal(id, state) {
    await logs.flushConversationLog(id);
    assert(['completed', 'error', 'capped'].includes(state.status), 'Nonterminal state cannot be drained');
    // Real cache API: seeded completed fixture lanes also need a persistence receipt.
    FlowExecutor.conversationStates.set(id, state);
    await cache.markTerminal(id, state, () => persist('conversations/' + id, state));
  }
  async function createParkedOwners() {
    const prefix = 'parked-' + crypto.randomUUID();
    const debug = await runFlow({ flowId: 'pause-control', conversationId: prefix + '-debug',
      prompt: 'fixed debugger owner', source: 'api', debug: true, userTurn: true });
    assert.equal(debug.status, 'paused_debug');
    const approval = await runFlow({ flowId: 'approval-control', conversationId: prefix + '-approval',
      prompt: 'fixed approval owner', source: 'api', requireApproval: true, onApprovalRequired: 'pause' });
    assert.equal(approval.status, 'awaiting_tool_approval'); assert.equal(approval.sharedState.pendingToolCalls.length, 1);
    const effect = await runFlow({ flowId: 'effect-control', conversationId: prefix + '-effect',
      prompt: 'fixed unknown effect owner', source: 'api' });
    assert.equal(effect.status, 'completed');
    const checkpoints = load('backend/execution/flow/recoveryCheckpoint.ts');
    const effectCall = [{ id: 'local-effect-control', type: 'function', function: { name: 'qualification_local_write', arguments: '{}' } }];
    const effectKey = 'conversations/' + effect.conversationId;
    await checkpoints.commitToolCheckpoint(effectKey, effect.sharedState, effectCall, 'before');
    // Controlled local effect with withheld acknowledgement, not a claimed remote MCP fault.
    const effectFile = path.join(process.env.FLUJO_DATA_DIR, 'qualification-local-effect.txt');
    const effectBytes = 'known local effect ' + prefix;
    await fs.promises.writeFile(effectFile, effectBytes, { flag: 'wx' });
    await checkpoints.commitToolCheckpoint(effectKey, effect.sharedState, effectCall, 'unknown');
    for (const [kind, result] of [['debug', debug], ['approval', approval], ['effect', effect]]) {
      const owner = { kind, state: result.sharedState, historySha256: hash(JSON.stringify(result.sharedState.messages)),
        ...(kind === 'effect' ? { effectFile, effectBytes, effectCall } : {}) };
      parked.set(result.conversationId, owner);
    }
    assert.equal(effect.sharedState.recovery.currentCheckpoint.effectStatus, 'unknown');
    assertDrained();
  }
  async function verifyParkedOwners() {
    cache.enforceBounds();
    for (const [id, owner] of parked) {
      assert.equal(FlowExecutor.conversationStates.get(id), owner.state);
      assert.equal(hash(JSON.stringify(owner.state.messages)), owner.historySha256);
      const stored = await storage.loadItem('conversations/' + id);
      assert.equal(hash(JSON.stringify(stored.messages)), owner.historySha256);
      if (owner.kind === 'effect') assert.equal(stored.recovery.currentCheckpoint.effectStatus, 'unknown');
      else assert.equal(stored.status, owner.kind === 'debug' ? 'paused_debug' : 'awaiting_tool_approval');
    }
    assertDrained();
  }
  async function resolveParkedOwners() {
    for (const [id, owner] of parked) {
      if (owner.kind === 'approval') {
        const decision = await load('backend/execution/flow/resumeAfterApproval.ts').applyApprovalDecision(
          owner.state, owner.state.pendingToolCalls[0].id, 'reject');
        assert.equal(decision.outcome, 'ready');
        await logs.appendRawForState(owner.state, decision.appendedMessages.map(message => ({ type: 'message', message })));
        await persist('conversations/' + id, owner.state);
      }
      if (owner.kind === 'effect') {
        assert.equal(await fs.promises.readFile(owner.effectFile, 'utf8'), owner.effectBytes);
        const checkpoints = load('backend/execution/flow/recoveryCheckpoint.ts');
        await checkpoints.commitToolCheckpoint('conversations/' + id, owner.state, owner.effectCall, 'completed');
        await checkpoints.commitRecoveryTransition('conversations/' + id, owner.state, 'completed',
          { manualActionRequired: false, sideEffectWarning: '' });
      }
      let result;
      for (let step = 0; step < 8; step++) {
        result = await runFlow({ flowId: owner.state.flowId, conversationId: id, source: 'api',
          ...(owner.kind === 'debug' ? { debug: true, continueDebug: true } : {}) });
        if (result.status !== 'paused_debug') break;
      }
      assert.equal(result.status, 'completed');
      parked.delete(id); await terminal(id, result.sharedState);
    }
    assertDrained();
  }
  async function controls(prefix) {
    phase = 'live-paused-sse-controls';
    const liveId = prefix + '-live';
    const live = runFlow({ flowId: 'live-control', conversationId: liveId, prompt: 'bounded live owner control', source: 'api' });
    let liveSettled = false;
    void live.then(() => { liveSettled = true; }, () => { liveSettled = true; });
    // An attached rejection handler avoids an unhandled rejection while observing ownership.
    live.catch(() => {});
    const waitUntil = performance.now() + 20_000;
    while (!(await providerControl('status')).counts['live-control']) {
      assert(performance.now() < waitUntil, 'Live request never reached loopback SDK boundary'); await delay(50);
    }
    const liveState = FlowExecutor.conversationStates.get(liveId); assert(liveState);
    async function assertLiveHeld() {
      const status = await providerControl('status');
      assert.equal(status.active, 1); assert.equal(status.held, 1); assert.equal(status.counts['live-control'], 1);
      assert.equal(status.outcomes['live-control'].success, 0);
      assert.equal(liveSettled, false); assert.equal(liveState.status, 'running');
      assert.equal(FlowExecutor.conversationStates.get(liveId), liveState);
    }
    await assertLiveHeld();
    cache.enforceBounds(); assert.equal(FlowExecutor.conversationStates.get(liveId), liveState, 'Live owner was evicted');
    assert.equal(streams.executionStreamAdmission.diagnostics().active, 0);
    const sessions = [];
    for (let index = 0; index < 3; index++) {
      const abort = new AbortController();
      const release = streams.executionStreamAdmission.reserve(liveId); assert(release);
      let streamSession;
      const subscription = { deliveries: 0, cleanups: 0 };
      const body = streams.createExecutionStream(abort.signal, release, () => ({ nextSeq: bus.currentSeq(liveId) }), current => {
        streamSession = current;
        const unsubscribe = bus.subscribe(liveId, event => { subscription.deliveries++; current.send(event, event.seq); });
        current.onCleanup(() => { unsubscribe(); subscription.cleanups++; });
      });
      sessions.push({ abort, body, subscription, get session() { return streamSession; } });
    }
    assert.equal(streams.executionStreamAdmission.diagnostics().active, 3);
    sessions[2].abort.abort(new Error('qualification disconnected subscriber'));
    assert.equal(sessions[2].session.closed, true); assert.equal(sessions[2].subscription.cleanups, 1);
    assert.equal(streams.executionStreamAdmission.diagnostics().active, 2);
    const disconnectedDeliveries = sessions[2].subscription.deliveries;
    await assertLiveHeld();
    // A real byte-backed SSE consumer reads; a second deliberately never reads.
    const reader = sessions[0].body.getReader(); let liveBytes = 0;
    const consuming = (async () => { for (;;) { const chunk = await reader.read(); if (chunk.done) break; liveBytes += chunk.value.length; } })();
    for (let index = 0; index < 160; index++) {
      bus.emit(liveId, { type: 'model:delta', delta: 'x'.repeat(16 * 1024) });
      await new Promise(resolve => setImmediate(resolve));
    }
    assert(sessions[1].session.closed, 'Unread SSE queue did not release slow consumer');
    assert.equal(sessions[1].subscription.cleanups, 1);
    assert.equal(sessions[0].session.closed, false);
    assert.equal(streams.executionStreamAdmission.diagnostics().active, 1);
    const slowDeliveries = sessions[1].subscription.deliveries;
    bus.emit(liveId, { type: 'model:delta', delta: 'subscription-release-witness' });
    assert.equal(sessions[1].subscription.deliveries, slowDeliveries);
    assert.equal(sessions[2].subscription.deliveries, disconnectedDeliveries);
    await assertLiveHeld();
    await providerControl('release');
    const liveResult = await live; assert.equal(liveResult.status, 'completed');
    for (const item of sessions) item.abort.abort();
    await consuming; reader.releaseLock();
    for (const item of sessions.slice(1)) await item.body.cancel();
    for (const item of sessions) assert.equal(item.subscription.cleanups, 1);
    assert.equal(streams.executionStreamAdmission.diagnostics().active, 0);
    assert(liveBytes > 0); await terminal(liveId, liveResult.sharedState);
    const pausedId = prefix + '-paused';
    let paused = await runFlow({ flowId: 'pause-control', conversationId: pausedId, prompt: 'pause control', source: 'api', debug: true });
    assert.equal(paused.status, 'paused_debug');
    cache.enforceBounds(); assert.equal(FlowExecutor.conversationStates.get(pausedId), paused.sharedState, 'Paused owner was evicted');
    for (let step = 0; step < 8 && paused.status === 'paused_debug'; step++) {
      paused = await runFlow({ flowId: 'pause-control', conversationId: pausedId, source: 'api', debug: true, continueDebug: true });
    }
    assert.equal(paused.status, 'completed'); await terminal(pausedId, paused.sharedState);
    const beforeRetry = (await providerControl('status')).counts['retry-control'];
    const retry = await runFlow({ flowId: 'retry-control', conversationId: prefix + '-retry', prompt: 'retry control', source: 'api' });
    assert.equal(retry.status, 'completed');
    assert.equal((await providerControl('status')).counts['retry-control'] - beforeRetry, 2, 'Default SDK retry did not make two physical requests');
    assert.equal((await providerControl('status')).outcomes['retry-control'].retryMarker, RETRY_MARKER);
    await terminal(retry.conversationId, retry.sharedState);
    const retryId = prefix + '-explicit-retry';
    const retryHistory = history(retryId, 1024);
    const first = await runFlow({ flowId: 'retry-resume', conversationId: retryId, messages: retryHistory.messages, source: 'api' });
    assert.equal(first.status, 'error');
    assert.equal(first.error?.details?.code, TERMINAL_CODE); assert(first.error.message.includes(TERMINAL_MARKER));
    assert.equal((await providerControl('status')).counts['retry-resume'], 1, 'Permanent 400 retried without an explicit resume');
    const firstDispatches = [...dispatches.values()].filter(item => item.conversationId === retryId).map(item => item.id);
    assert.equal(firstDispatches.length, 1);
    const retryMedia = Buffer.alloc(64 * 1024, 0x37);
    const retryMediaEntry = await archive.archiveModelDispatch({ conversationId: retryId, nodeId: 'process', modelId: 'retry-resume',
      modelName: 'retry-resume', adapter: 'offline', operation: 'explicit-retry-media-control', attempt: 1,
      canonicalMessages: retryHistory.messages, genericWire: [], sdkRequest: { image: 'data:image/png;base64,' + retryMedia.toString('base64') } });
    const mediaBeforeRetry = await archive.readModelTurnSnapshot(retryId, retryMediaEntry.id);
    assert.equal(mediaBeforeRetry.media.length, 1);
    const resumed = await runFlow({ flowId: 'retry-resume', conversationId: retryId, source: 'api', processNodeId: 'process' });
    assert.equal(resumed.status, 'completed');
    assert.equal((await providerControl('status')).counts['retry-resume'], 2);
    assert.equal(hash(resumed.sharedState.messages.find(item => item.id === retryHistory.messages[0].id).content), retryHistory.sha256);
    const afterDispatches = [...dispatches.values()].filter(item => item.conversationId === retryId).map(item => item.id);
    assert.equal(afterDispatches.length, 2); assert.equal(new Set(afterDispatches).size, 2);
    assert(afterDispatches.includes(firstDispatches[0]));
    const mediaAfterRetry = await archive.readModelTurnMedia(retryId, retryMediaEntry.id, mediaBeforeRetry.media[0].id);
    assert(mediaAfterRetry.bytes.equals(retryMedia), 'Explicit retry changed earlier archived media');
    await terminal(retryId, resumed.sharedState);
    const beforeRefusal = (await providerControl('status')).totalRequests;
    const oversized = history(prefix + '-refusal', 7_000_000);
    const refusal = await load('backend/execution/flow/handlers/ModelHandler.ts').ModelHandler.generateCompletion(
      'parent', '', oversized.messages, undefined, { archiveModelTurns: true, canonicalMessages: oversized.messages,
        conversationId: prefix + '-refusal', nodeId: 'process', runId: prefix + '-refusal' });
    assert.equal(refusal.success, false); assert.match(refusal.error?.code ?? '', /^MODEL_TURN_ARCHIVE_MEMORY_(LIMIT|BUSY)$/);
    assert.equal((await providerControl('status')).totalRequests, beforeRefusal, 'Refused archive reached SDK transport');
    return { liveBytes, slowConsumerReleased: true, disconnectedOwnerPreserved: true, pausedOwnerPreserved: true,
      physicallyHeldThroughDisconnects: true, subscriptionCleanupCounts: sessions.map(item => item.subscription.cleanups),
      sdkPhysicalRequests: 2, explicitRetryDispatches: afterDispatches, explicitRetryMediaSha256: hash(retryMedia),
      refusalBeforePhysicalDispatch: refusal.error.code };
  }
  async function verifyFoldReplay(state, expected) {
    const identity = foldIdentity(state, expected);
    // Reload the actual committed snapshot. Re-deliver stale success and failure
    // to production post(); this is a durable late-result replay, not a simulated process crash.
    const restored = await subflowRecovery.readPersistedSubflowParent(state.conversationId);
    assert(restored); assert.notEqual(restored, state);
    assert.deepEqual(foldIdentity(restored, expected), identity);
    const before = (await providerControl('status')).totalRequests;
    const node = new SubflowNode();
    const prep = { invocationId: expected.id, nodeId: expected.parentNodeId, resultPresentation: 'separate' };
    for (const stale of [{ success: true, outputText: 'must-not-replace-committed-fold' },
      { success: false, error: 'must-not-replace-committed-error' }]) {
      assert.equal(await node.post(prep, stale, restored, { id: expected.parentNodeId }), identity.receipt.action);
      assert.deepEqual(foldIdentity(restored, expected), identity);
    }
    const durable = await subflowRecovery.readPersistedSubflowParent(state.conversationId);
    assert.deepEqual(foldIdentity(durable, expected), identity);
    assert.equal((await providerControl('status')).totalRequests, before, 'Fold replay redispatched a child');
    return { ...identity, staleResultsReplayed: 2, providerRequestsAdded: 0 };
  }
  async function runBatch(number, inspectorLabel) {
    const beforeDisk = await directoryBytes(process.env.FLUJO_DATA_DIR); const batchStart = performance.now();
    dispatches.clear(); // Harness scalar receipts only; never runtime maps/modules or retained event objects.
    await providerControl('next-batch', 'POST');
    const run = () => runBatchWork(number, beforeDisk, batchStart);
    // Start allocation capture after inventory/control I/O, immediately before materializing history.
    return inspectorLabel ? allocationSampler.run(inspectorLabel, epoch, number, run) : run();
  }
  async function runBatchWork(number, beforeDisk, batchStart) {
    const prepared = family(number); const all = [prepared.parent, ...prepared.children.map(child => child.state)];
    const expected = new Map(all.map((state, index) => [state.conversationId,
      { id: state.messages[0].id, sha256: index === 0 ? prepared.parentSha256 : prepared.children[index - 1].sha256 }]));
    phase = 'seed-durable-family';
    // Fixtures are explicit restored histories, not a claim that synthetic prior runs occurred.
    for (const state of all) { await persist('conversations/' + state.conversationId, state); FlowExecutor.conversationStates.set(state.conversationId, state); }
    phase = 'parent-model-boundary';
    const parentBoundary = await runFlow({ flowId: 'parent', conversationId: prepared.prefix + '-parent-model',
      messages: prepared.parent.messages, source: 'api' });
    if (parentBoundary.status === 'error') assert.match(parentBoundary.error?.details?.code ?? '', /^MODEL_TURN_ARCHIVE_MEMORY_(LIMIT|BUSY)$/);
    else assert.equal(parentBoundary.status, 'completed');
    await terminal(parentBoundary.conversationId, parentBoundary.sharedState);
    phase = 'real-subflow-prep-exec-post';
    const result = await runFlow({ flowDefinition: prepared.parent.flowSnapshot, conversationId: prepared.parent.conversationId,
      source: 'api', processNodeId: 'subflow' });
    assert.equal(result.status, 'completed', 'Parent did not terminate after real Subflow post');
    const invocation = result.sharedState.subflowInvocations[prepared.invocation.id];
    assert.equal(invocation.status, 'folded'); assert(invocation.foldedAt);
    assert(invocation.lanes.every(lane => ['completed', 'error'].includes(lane.status)));
    const foldReplay = await verifyFoldReplay(result.sharedState, prepared.invocation);
    const providerReceipt = await providerControl('status');
    assert(providerReceipt.peakActive <= 4); assert.equal(providerReceipt.active, 0);
    assert.equal(providerReceipt.rejected, 0, 'Provider concurrency rejection is not a workload success');
    const childOutcomes = [];
    phase = 'terminal-durability';
    for (const original of all) {
      const id = original.conversationId;
      const current = FlowExecutor.conversationStates.get(id) ?? await storage.loadItem('conversations/' + id);
      assert(current); assert(['completed', 'error', 'capped'].includes(current.status));
      const childIndex = prepared.children.findIndex(child => child.state.conversationId === id);
      if (childIndex >= 0) childOutcomes.push(assertChildOutcome(childIndex, invocation.lanes[childIndex], current,
        providerReceipt, [...dispatches.values()].filter(item => item.conversationId === id).length));
      assert.equal(hash(current.messages.find(message => message.id === expected.get(id).id)?.content ?? ''), expected.get(id).sha256,
        'Canonical fixture history changed');
      await terminal(id, current);
      const stored = await storage.loadItem('conversations/' + id);
      assert.equal(stored.status, current.status);
      assert.equal(hash(stored.messages.find(message => message.id === expected.get(id).id)?.content ?? ''), expected.get(id).sha256);
    }
    phase = 'archive-media-roundtrip';
    const media = Buffer.alloc(64 * 1024, 0x52);
    const mediaId = prepared.prefix + '-media';
    const entry = await archive.archiveModelDispatch({ conversationId: mediaId, nodeId: 'process', modelId: 'parent', modelName: 'parent',
      adapter: 'offline', operation: 'qualification-media', attempt: 1, canonicalMessages: prepared.parent.messages,
      genericWire: [], sdkRequest: { image: 'data:image/png;base64,' + media.toString('base64') } });
    const snapshot = await archive.readModelTurnSnapshot(mediaId, entry.id);
    assert.equal(snapshot.media.length, 1);
    const restored = await archive.readModelTurnMedia(mediaId, entry.id, snapshot.media[0].id);
    assert(restored.bytes.equals(media));
    assert.equal(hash(snapshot.canonicalMessages[0].content), prepared.parentSha256);
    const ownership = await controls(prepared.prefix);
    phase = 'verify-actual-sdk-archives';
    let witnessedArchives = 0;
    for (const dispatch of dispatches.values()) {
      const saved = await archive.readModelTurnSnapshot(dispatch.conversationId, dispatch.id);
      assert(saved?.sdkRequest, 'Actual SDK dispatch archive is absent');
      const witness = expected.get(dispatch.conversationId);
      if (witness) {
        assert.equal(hash(saved.canonicalMessages.find(message => message.id === witness.id)?.content ?? ''), witness.sha256);
      }
      witnessedArchives++;
    }
    assert(witnessedArchives >= 3, 'Pilot did not exercise actual SDK archive dispatch boundaries');
    phase = 'batch-draining';
    for (const state of all) await logs.flushConversationLog(state.conversationId);
    await new Promise(resolve => setImmediate(resolve)); cache.enforceBounds();
    assertDrained();
    const afterDisk = await directoryBytes(process.env.FLUJO_DATA_DIR);
    return { number, elapsedMs: performance.now() - batchStart, diskBytesAdded: afterDisk.bytes - beforeDisk.bytes,
      diskFilesAdded: afterDisk.files - beforeDisk.files, parentStatus: result.status, invocationStatus: invocation.status,
      laneStatuses: invocation.lanes.map(lane => lane.status), childOutcomes, foldReplay, provider: providerReceipt, ownership,
      fixtureHash: hash(JSON.stringify([...expected.values()])), mediaBytes: media.length, witnessedArchives };
  }
  try {
    // Fixed one process/catalogue. Warmup and parked-owner TTL checks precede measurement.
    started = performance.now();
    timer = setInterval(() => { try { sample(); } catch (error) { fatal ??= error; } }, PROFILE.sampleMs);
    sample();
    await createParkedOwners();
    const parkedAt = performance.now();
    for (let warmup = 0; warmup < PROFILE.warmupBatches; warmup++) {
      const number = -warmup - 1;
      const label = allocationWindowLabel({ epoch: 'warmup', number });
      const receipt = await runBatch(number, label);
      phases.write({ epoch: 'warmup', ...receipt });
      await verifyParkedOwners();
    }
    phase = 'parked-real-ttl';
    while (performance.now() - parkedAt < PROFILE.parkedHoldMs) {
      if (fatal) throw fatal; await verifyParkedOwners(); await delay(10_000);
    }
    await verifyParkedOwners();
    phases.write({ epoch: 'warmup', parkedOwners: parked.size, heldMs: performance.now() - parkedAt, passed: true });
    await resolveParkedOwners();
    epoch = 'measurement'; started = performance.now();
    let baselineInspector = false;
    const duration = contract.mode === 'pilot' ? PROFILE.pilotBatches * contract.cadenceMs : PROFILE.enduranceMs;
    for (let next = 0; next < duration; next += contract.cadenceMs) {
      while (performance.now() - started < next) { if (fatal) throw fatal; await delay(Math.min(1000, next - (performance.now() - started))); }
      if (fatal) throw fatal;
      if (fs.existsSync(path.join(output, 'stop-runtime'))) throw new Error('Supervisor requested stop');
      batch++;
      const deadline = setTimeout(() => { fs.writeFileSync(path.join(output, 'runtime-timeout.json'), JSON.stringify({ batch, phase })); process.exit(2); }, PROFILE.batchDeadlineMs);
      try {
        const label = allocationWindowLabel({ mode: contract.mode, epoch, number: batch,
          elapsedMs: performance.now() - started, scheduledMs: next, durationMs: duration,
          cadenceMs: contract.cadenceMs, baselineTaken: baselineInspector, baselineStartMs: PROFILE.baselineStartMs });
        if (label === 'hour-two') baselineInspector = true;
        const receipt = await runBatch(batch, label);
        phases.write(receipt);
        // Full identities/outcomes stay in bounded batches.jsonl. Keep the final
        // plan receipt below its 1 MiB reader limit even for 192 batches.
        batches.push({ number: receipt.number, elapsedMs: receipt.elapsedMs, diskBytesAdded: receipt.diskBytesAdded,
          diskFilesAdded: receipt.diskFilesAdded, evidenceSha256: hash(JSON.stringify(receipt)) });
      }
      finally { clearTimeout(deadline); }
      // runBatch's state graph is now out of scope before any low-water observation.
      await new Promise(resolve => setImmediate(resolve)); phase = 'drained';
      windows.add(performance.now() - started, sample());
      const free = await fs.promises.statfs(output);
      assert(free.bavail * free.bsize >= PROFILE.budgets.minimumFreeBytes, 'Free disk fell below 20 GiB');
    }
    while (performance.now() - started < duration) { if (fatal) throw fatal; await delay(1000); }
    const measuredElapsedMs = performance.now() - started;
    phase = 'final-natural-ttl-drain';
    assert.deepEqual(inspectorReceipts.map(receipt => receipt.label), ['warmup', 'hour-two', 'final']);
    const drainStart = performance.now();
    while (performance.now() - drainStart < PROFILE.drainMs) {
      if (fatal) throw fatal;
      cache.enforceBounds(); assertDrained(); await delay(1000);
    }
    cache.enforceBounds(); assertDrained();
    if (fatal) throw fatal;
    assert.equal(cache.getConversationCacheDiagnostics().entries, 0, 'Natural terminal TTL did not evict all states');
    if (contract.mode === 'endurance') assert(measuredElapsedMs >= PROFILE.enduranceMs);
    const source = loader.verify();
    if (contract.source) assert.equal(sourceManifestHash(source), sourceManifestHash(contract.source),
      'Endurance loaded source differs from the two successful pilots');
    assert.equal(contract.harnessSha256, harnessDigest(), 'Harness changed during qualification');
    fs.writeFileSync(path.join(output, 'runtime-receipt.json'), JSON.stringify({ version: PROFILE.version, profileSha256,
      sourceHead: contract.sourceHead, harnessSha256: contract.harnessSha256, mode: contract.mode, completed: true, measuredElapsedMs,
      datasetFilesystem: contract.datasetFilesystem,
      drainElapsedMs: performance.now() - drainStart, batches, inspectorWindows: inspectorReceipts, peakRss, diagnostics: diagnostics(),
      growth: windows.result(contract.mode === 'endurance'), disk: await directoryBytes(process.env.FLUJO_DATA_DIR),
      source, events: eventCounts, node: process.version, platform: process.platform, execArgv: process.execArgv,
      limitations: ['Synthetic materialized ASCII history lengths, not original transcript/tokenizer counts.',
        'Source-loaded runtime; not packaged application, Next HTTP routes, or paid-provider qualification.',
        'SSE controls use the real stream/bus primitives with a deliberately unread body; no browser/network-stack claim.',
        'Drained low-water growth is a no-forced-GC proxy, not proof of retained-object reachability.'],
    }, null, 2), { flag: 'wx' });
    completed = true;
  } finally {
    clearInterval(timer); unsubscribe(); observer.disconnect(); loop.disable(); records.close(); phases.close();
    fs.writeFileSync(path.join(output, 'runtime-settled.json'), JSON.stringify({ completed, phase, batch, diagnostics: diagnostics() }), { flag: 'wx' });
  }
}
if (require.main === module) main(process.argv[2]).catch(error => { console.error(error.stack); process.exitCode = 1; });
