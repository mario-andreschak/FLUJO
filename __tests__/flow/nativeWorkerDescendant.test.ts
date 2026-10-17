import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Flow } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { SharedState, SubflowInvocation } from '@/backend/execution/flow/types';
import type { FlowRunInput } from '@/backend/execution/flow/runFlow';

const model = { id: 'worker-child-model', name: 'gpt-6-luna', displayName: 'Offline Worker child',
  provider: 'codex', adapter: 'codex-cli', ApiKey: '', maxTurns: 3, reasoningEffort: 'medium' } as Model;
jest.mock('@/backend/services/model', () => ({ modelService: {
  getModel: async (id: string) => id === model.id ? model : null,
  loadModels: async () => [model],
} }));
// Qualification is the only native executable/provider edge replaced here.
// Source persistence, lineage, journal, reservations and born-child probes run normally.
jest.mock('@/backend/services/model/adapters/codexNativeQualification', () => {
  const profile = Object.freeze({ verifiedCliVersion: 'offline-fixture', verifiedCliPath: process.execPath,
    verifiedCliSha256: 'fixture', verifiedModelCatalogPath: 'fixture', verifiedModelCatalogSha256: 'fixture' });
  return { qualifyNativeCodex: async () => profile, assertNativeCodexQualification: (value: unknown) => {
    if (value !== profile) throw new Error('Offline qualification capability mismatch');
  } };
});

import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { archiveModelDispatch, readNativeModelTurnSnapshot } from '@/backend/execution/flow/modelTurnArchive';
import { bindExecutionExtensionRun, createExecutionExtensionContext, installExecutionExtensionContext,
  prepareExecutionSubflowInput, registerExecutionExtension, runWithExecutionInput,
  type ExecutionExtensionAdapter, type ExecutionNativeWorkerRoot } from '@/backend/execution/extensions';
import { createWorkerNativeOriginalHost, nativeOriginalSourceReader } from '@/backend/execution/flow/handlers/nativeOriginalHost';
import { createNativeInvocationSession } from '@/backend/execution/flow/handlers/nativeInvocationSession';
import { readNativeOriginLineage, NativeLineageHeldError } from '@/backend/execution/flow/handlers/nativeOriginLineage';
import { saveNativeSessionOrigin } from '@/backend/execution/flow/handlers/nativeSavedOrigin';
import { saveNativeSessionPayload } from '@/backend/execution/flow/handlers/nativeSessionPayload';
import { nativeDigest, nativeToolInventoryDigest } from '@/backend/execution/flow/handlers/nativeToolBroker';
import { holdNativeInvocation, nativeInvocationStatus, NativeInvocationHeldError,
  prepareNativeInvocation, submitNativeInvocation } from '@/backend/execution/flow/handlers/nativeToolJournal';
import { startOwnedCodexAppServer } from '@/backend/services/model/adapters/codexAppServerProcess';
import { loadCollectionItem, saveCollectionItem } from '@/utils/storage/backend';
import { getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';

async function withWorkerClaim(task: (input: {
  parent: SharedState; child: SharedState; invocation: SubflowInvocation;
  input: FlowRunInput; root: ExecutionNativeWorkerRoot; signal: AbortSignal;
}) => Promise<void>) {
  // The shared Jest setup owns the isolated installation root and its teardown.
  await runWithWorkspace(`native-worker-descendant-${process.pid}`, async () => {
    const controller = new AbortController();
    const childFlow: Flow = { id: 'worker-child-flow', name: 'Worker child', edges: [], nodes: [{
      id: 'worker-child-process', position: { x: 0, y: 0 },
      data: { label: 'Child', type: 'process', properties: { boundModel: model.id, maxTurns: 3 } },
    }] };
    const parentFlow: Flow = { id: 'worker-parent-flow', name: 'Worker parent', edges: [], nodes: [{
      id: 'worker-parent-subflow', position: { x: 0, y: 0 },
      data: { label: 'Attached child', type: 'subflow', properties: { subflowId: childFlow.id } },
    }] };
    const now = Date.now();
    const invocation: SubflowInvocation = { version: 1, id: 'worker-attached-visit',
      parentConversationId: 'worker-parent-conversation', parentRunId: 'worker-parent-conversation',
      parentNodeId: 'worker-parent-subflow', status: 'running', depth: 1, showSteps: true,
      concurrencyLimit: 1, joinSeparator: '\n', errorStrategy: 'fail-fast', createdAt: now, updatedAt: now,
      lanes: [{ id: 'worker-attached-lane', index: 0, count: 1, conversationId: 'worker-child-conversation',
        subflowId: childFlow.id, status: 'running', attempt: 1, updatedAt: now }],
    };
    const parent = { conversationId: invocation.parentConversationId, logicalRunId: 'worker-parent-logical',
      title: 'Offline Worker parent', trackingInfo: { executionId: 'worker-parent-logical', startTime: now, nodeExecutionTracker: [] },
      flowId: parentFlow.id, flowSnapshot: parentFlow, currentNodeId: invocation.parentNodeId,
      source: 'api', status: 'running', runDepth: 0, isCancelled: false, messages: [],
      createdAt: now, updatedAt: now, subflowInvocations: { [invocation.id]: invocation } } as SharedState;
    const lane = { invocationId: invocation.id, laneId: invocation.lanes[0].id,
      parentNodeId: invocation.parentNodeId, conversationId: invocation.lanes[0].conversationId, laneIndex: 0 };
    const child = { conversationId: lane.conversationId, logicalRunId: 'worker-child-logical',
      title: 'Offline Worker child', trackingInfo: { executionId: 'worker-child-logical', startTime: now, nodeExecutionTracker: [] },
      flowId: childFlow.id, flowSnapshot: childFlow, currentNodeId: 'worker-child-process',
      source: 'subflow', status: 'running', runDepth: 1, messages: [], createdAt: now, updatedAt: now,
      parentRunId: parent.conversationId, parentConversationId: parent.conversationId,
      parentLogicalRunId: parent.logicalRunId, rootConversationId: parent.conversationId, subflowLane: lane } as SharedState;
    const root: ExecutionNativeWorkerRoot = { version: 1, workerId: 'offline-worker', goalId: 'offline-goal',
      fleetRunId: 'offline-fleet-run', rootConversationId: parent.conversationId!, logicalRunId: parent.logicalRunId!,
      workspace: `native-worker-descendant-${process.pid}`, targetDigest: 'a'.repeat(64),
      flowDigest: nativeDigest(parentFlow), leaseEpoch: 'offline-worker-lease', modelId: model.id,
      modelDigest: nativeDigest({ id: model.id, name: model.name, adapter: model.adapter, provider: model.provider,
        maxTurns: model.maxTurns, temperature: model.temperature, reasoningEffort: model.reasoningEffort,
        fallbackPolicy: model.fallbackPolicy }) };
    const parentScope = Object.freeze({});
    const childScope = Object.freeze({});
    const runs = new Map<object, { conversationId: string; runId: string }>();
    const assertCurrent = async (scope: object, expected?: { conversationId?: string; runId?: string }) => {
      controller.signal.throwIfAborted();
      const run = runs.get(scope);
      if (!run || expected?.conversationId !== undefined && expected.conversationId !== run.conversationId
        || expected?.runId !== undefined && expected.runId !== run.runId) throw new Error('Offline Worker scope mismatch');
    };
    const adapter: ExecutionExtensionAdapter = {
      isProtectedServer: () => false, assertServerConfig: () => {}, assertRun: assertCurrent,
      async bindRun(scope, conversationId, runId) {
        const state = scope === parentScope ? parent : scope === childScope ? child : undefined;
        if (!state || conversationId !== state.conversationId || runId !== state.logicalRunId) throw new Error('Offline Worker bind refused');
        runs.set(scope, { conversationId, runId });
      },
      signal: () => controller.signal,
      async commit(scope, mutation) { await assertCurrent(scope); const result = await mutation(); await assertCurrent(scope); return result; },
      protectedServer: () => 'offline-worker-tools', authorizeHandoffs: () => {},
      assertModelTool: async scope => assertCurrent(scope),
      assertDispatch: async scope => { if (!scope) throw new Error('Missing Worker scope'); await assertCurrent(scope); },
      normalizeArguments: (_scope, _tool, args) => args, requestMeta: async () => ({}),
      validateResult: (_scope, _tool, result) => result,
      async prepareSubflow(scope, input) {
        await assertCurrent(scope);
        if (scope !== parentScope || input.parentRunId !== parent.conversationId || input.depth !== 1
          || input.conversationId !== child.conversationId || input.flowId !== childFlow.id
          || nativeDigest(input.lane) !== nativeDigest(lane)) throw new Error('Offline attached child refused');
        return childScope;
      },
      async nativeWorkerRoot(scope) {
        await assertCurrent(scope);
        if (scope !== parentScope) throw new Error('A child cannot acquire root admission');
        return structuredClone(root);
      },
      async nativeWorkerDescendant(scope) {
        await assertCurrent(scope);
        if (scope !== childScope) throw new Error('A parent cannot acquire child admission');
        // Controller admission stays current during disk-only Source drift.
        return { root: structuredClone(root), parentNodeId: invocation.parentNodeId,
          flowDigest: nativeDigest(childFlow), modelId: model.id, modelDigest: root.modelDigest };
      },
    };
    const restore = registerExecutionExtension(adapter);
    try {
      const parentContext = createExecutionExtensionContext(adapter, parentScope);
      await bindExecutionExtensionRun(parentContext, parent.conversationId!, parent.logicalRunId!);
      installExecutionExtensionContext(parent, parentContext);
      FlowExecutor.conversationStates.set(parent.conversationId!, parent);
      await saveCollectionItem('conversations', parent.conversationId!, parent);
      await runWithExecutionInput({ executionExtensionContext: parentContext, conversationId: parent.conversationId,
        runId: parent.logicalRunId }, async () => {
        const input = await prepareExecutionSubflowInput({ source: 'subflow', prompt: 'Offline attached child',
          mode: 'conversation', depth: 1, flowId: childFlow.id, conversationId: child.conversationId,
          parentRunId: parent.conversationId, lane });
        expect(input?.executionExtensionContext).toBeDefined();
        expect(input!.executionExtensionContext).not.toBe(parentContext);
        await bindExecutionExtensionRun(input!.executionExtensionContext!, child.conversationId!, child.logicalRunId!);
        installExecutionExtensionContext(child, input!.executionExtensionContext!);
        FlowExecutor.conversationStates.set(child.conversationId!, child);
        await saveCollectionItem('conversations', child.conversationId!, child);
        await runWithExecutionInput({ ...input!, runId: child.logicalRunId },
          () => task({ parent, child, invocation, input: input!, root, signal: controller.signal }));
      });
    } finally {
      controller.abort();
      FlowExecutor.conversationStates.delete(child.conversationId!);
      FlowExecutor.conversationStates.delete(parent.conversationId!);
      restore();
    }
  });
}

test('a persisted attached Worker child loses live Source proof after a disk-only folded parent and keeps its Original held', async () => {
  await withWorkerClaim(async ({ parent, child, invocation, input, root, signal }) => {
    const host = await createWorkerNativeOriginalHost({ context: input.executionExtensionContext!,
      conversationId: child.conversationId, runId: child.logicalRunId,
      nodeId: child.currentNodeId, modelId: model.id });
    expect(host).toBeDefined();
    const inventoryDigest = nativeToolInventoryDigest([], {});
    const request = { model: model.name, input: [{ type: 'text', text: 'Offline child admission' }] };
    const receipt = await prepareNativeInvocation({ conversationId: child.conversationId!, runId: child.logicalRunId!,
      nodeId: child.currentNodeId!, modelId: model.id, leaseEpoch: root.leaseEpoch,
      inventoryDigest, inputDigest: nativeDigest(request), attemptOrdinal: 1 });
    await archiveModelDispatch({ id: receipt.invocationId, conversationId: child.conversationId!,
      runId: child.logicalRunId, nodeId: child.currentNodeId!, modelId: model.id, modelName: model.name,
      adapter: 'codex-cli', operation: 'runStreamed', attempt: 1, canonicalMessages: [], genericWire: [],
      sdkRequest: request, durableContext: { executionExtensionContext: input.executionExtensionContext } });
    const archive = await readNativeModelTurnSnapshot(child.conversationId!, receipt.invocationId, root.workspace, signal);
    const submitted = await submitNativeInvocation(receipt);
    const lineage = await readNativeOriginLineage({ receipt: submitted, authority: host!.broker, root: host!.session.root, signal });
    expect(lineage).toMatchObject({ rootConversationId: parent.conversationId, originConversationId: child.conversationId,
      rootLogicalRunId: parent.logicalRunId, originLogicalRunId: child.logicalRunId,
      edges: [{ kind: 'attached-lane', parentNodeId: invocation.parentNodeId,
        parentConversationId: parent.conversationId, childConversationId: child.conversationId }] });
    expect(lineage.edges).toHaveLength(1);
    const payloadRef = await saveNativeSessionPayload({ invocationId: receipt.invocationId,
      archive: { sdkRequest: archive.sdkRequest, genericWire: archive.genericWire, media: archive.media },
      inventory: { tools: [], bindings: {}, syntheticNames: [] } });
    const original = createNativeInvocationSession({ receipt: submitted, lineage,
      archive: { dispatchId: receipt.invocationId, archiveVersion: archive.version, adapter: 'codex-cli',
        operation: archive.entry.operation, sanitizedSdkRequestDigest: nativeDigest(archive.sdkRequest),
        sanitizedGenericWireDigest: nativeDigest(archive.genericWire), mediaCount: archive.media.length },
      inventory: { digest: inventoryDigest, toolCount: 0 }, payloadRef }, signal, () => {});
    await saveNativeSessionOrigin(original.session.descriptor);
    await host!.session.publish(original.session);
    await host!.process.assertTurnBudget(3);
    let transport: Awaited<ReturnType<typeof startOwnedCodexAppServer>> | undefined;
    try {
      transport = await startOwnedCodexAppServer({ executable: process.execPath,
        args: ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'],
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
          && /^(path|systemroot|windir|comspec|pathext)$/i.test(key))), NODE_ENV: 'production' },
        cwd: getWorkspaceDataDir(), owner: host!.process, register: value => host!.process.register(value),
        signal, onNotification: () => {} });
      await host!.session.acknowledgeLive(original.session);
      await expect(host!.process.assertOutputCurrent()).resolves.toBeUndefined();
      const source = nativeOriginalSourceReader(host!.process);
      const descriptor = original.session.descriptor;
      expect(await source.readOrigin(receipt.invocationId)).toEqual(descriptor);
      const owner = { invocationId: receipt.invocationId, workerId: lineage.workerId, goalId: lineage.goalId,
        fleetRunId: lineage.fleetRunId, rootConversationId: lineage.rootConversationId, workspace: root.workspace,
        conversationId: child.conversationId, logicalRunId: child.logicalRunId, nodeId: child.currentNodeId,
        generation: `source-${nativeDigest([lineage.installationId, root.leaseEpoch])}` };
      const generation = Object.freeze({ fixture: 'attached-worker-host' });
      const retained = await source.retainLive(original.session, owner, generation);
      expect(await source.probeLive(retained.handle, owner, generation)).toBe(retained.handle);

      const savedParent = structuredClone((await loadCollectionItem<SharedState | undefined>(
        'conversations', parent.conversationId!, undefined))!);
      savedParent.subflowInvocations![invocation.id].status = 'folded';
      await saveCollectionItem('conversations', parent.conversationId!, savedParent);
      expect(parent.subflowInvocations![invocation.id].status).toBe('running');
      await expect(host!.process.assertOutputCurrent()).rejects.toBeInstanceOf(NativeLineageHeldError);
      expect(await source.probeLive(retained.handle, owner, generation)).toBeNull();
      await expect(source.retainLive(original.session, owner, generation)).rejects.toBeInstanceOf(NativeLineageHeldError);

      await holdNativeInvocation(submitted);
      original.settle({ state: 'held' });
      await transport.stop();
      await host!.process.waitForExit();
      await expect(host!.process.releaseAfterTerminal()).rejects.toThrow('held');
      expect(await nativeInvocationStatus(receipt.invocationId, receipt.owner)).toMatchObject({ state: 'unknown' });
      await expect(prepareNativeInvocation({ ...receipt.owner, attemptOrdinal: 2 })).rejects.toBeInstanceOf(NativeInvocationHeldError);
      const ledgerDirectory = path.join(getWorkspaceDataDir(), 'db', 'native-session-origins', 'worker-host-ledger');
      const files = (await fs.readdir(ledgerDirectory)).filter(file => file.endsWith('.json'));
      expect(files).toHaveLength(1);
      const ledger = JSON.parse(await fs.readFile(path.join(ledgerDirectory, files[0]), 'utf8'));
      expect(ledger).toMatchObject({ version: 2, kind: 'worker', workerId: root.workerId,
        reservations: [{ invocationId: receipt.invocationId, state: 'exited', exit: { code: 0, signal: null },
          owner: { conversationId: child.conversationId, runId: child.logicalRunId },
          codexBudget: { scope: 'outer-turn', admittedTurns: 1, maxTurns: 3 } }] });
      expect(ledger.reservations).toHaveLength(1);
      expect(ledger.reservations[0].sdkOutcome).toBeUndefined();
      expect(ledger.reservations[0].sdkUsage).toBeUndefined();
    } finally { await transport?.stop(); }
  });
});
