import { runWithWorkspace, getCurrentWorkspace } from '@/utils/workspace';
import {
  createSession,
  getDekFromSession,
  getServerDek,
  unlockServer,
} from '@/utils/encryption/session';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import {
  getFlowRunEventBus,
  type FlowRunEvent,
} from '@/backend/services/scheduler/flowRunEventBus';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import {
  forget,
  getConversationCacheDiagnostics,
  markTerminal,
  noteWrite,
} from '@/backend/execution/flow/conversationStateCache';
import type { SharedState } from '@/backend/execution/flow/types';
import { modelCache } from '@/backend/services/model/cache';
import type { NormalizedModel } from '@/shared/types/model/response';
import {
  _resetPoolForTests,
  acquireLease,
  getPoolDiagnostics,
} from '@/backend/services/mcp/mcpLeasePool';
import { _resetLifecycleForTests } from '@/backend/services/mcp/lifecycleCoordinator';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

const WORKSPACE_A = 'runtime-isolation-a';
const WORKSPACE_B = 'runtime-isolation-b';

const inWorkspace = <T>(workspace: string, fn: () => T): T =>
  runWithWorkspace(workspace, fn);

function completedState(conversationId: string): SharedState {
  return {
    conversationId,
    flowId: 'same-flow',
    messages: [],
    status: 'completed',
  } as unknown as SharedState;
}

function flowEvent(outputText: string): FlowRunEvent {
  return {
    flowId: 'same-flow',
    runId: 'same-run',
    conversationId: 'same-conversation',
    status: 'completed',
    outputText,
    firedBy: 'chat',
    chainDepth: 0,
    timestamp: new Date().toISOString(),
  };
}

describe('workspace runtime isolation', () => {
  it('binds encryption sessions and server DEKs to the issuing workspace', async () => {
    const [tokenA, tokenB] = await Promise.all([
      inWorkspace(WORKSPACE_A, async () => {
        unlockServer('dek-a');
        await Promise.resolve();
        return createSession('session-dek-a');
      }),
      inWorkspace(WORKSPACE_B, async () => {
        unlockServer('dek-b');
        await Promise.resolve();
        return createSession('session-dek-b');
      }),
    ]);

    const [viewA, viewB] = await Promise.all([
      inWorkspace(WORKSPACE_A, async () => ({
        serverDek: getServerDek(),
        own: getDekFromSession(tokenA),
        sibling: getDekFromSession(tokenB),
      })),
      inWorkspace(WORKSPACE_B, async () => ({
        serverDek: getServerDek(),
        own: getDekFromSession(tokenB),
        sibling: getDekFromSession(tokenA),
      })),
    ]);

    expect(viewA).toEqual({ serverDek: 'dek-a', own: 'session-dek-a', sibling: null });
    expect(viewB).toEqual({ serverDek: 'dek-b', own: 'session-dek-b', sibling: null });
  });

  it('partitions conversation channels and the all-conversations firehose', async () => {
    const conversationId = `same-conversation-${crypto.randomUUID()}`;
    const perConversationA: string[] = [];
    const perConversationB: string[] = [];
    const globalA: string[] = [];
    const globalB: string[] = [];

    const [channelA, channelB] = await Promise.all([
      inWorkspace(WORKSPACE_A, async () => {
        const unsubscribe = executionEventBus.subscribe(conversationId, (event) => {
          perConversationA.push((event as unknown as { flowId: string }).flowId);
        });
        const unsubscribeGlobal = executionEventBus.subscribeGlobal(({ event }) => {
          globalA.push((event as unknown as { flowId: string }).flowId);
        });
        return { emit: executionEventBus.emitterFor(conversationId), unsubscribe, unsubscribeGlobal };
      }),
      inWorkspace(WORKSPACE_B, async () => {
        const unsubscribe = executionEventBus.subscribe(conversationId, (event) => {
          perConversationB.push((event as unknown as { flowId: string }).flowId);
        });
        const unsubscribeGlobal = executionEventBus.subscribeGlobal(({ event }) => {
          globalB.push((event as unknown as { flowId: string }).flowId);
        });
        return { emit: executionEventBus.emitterFor(conversationId), unsubscribe, unsubscribeGlobal };
      }),
    ]);

    // Invoke after both workspace contexts have returned. emitterFor() must
    // retain its captured workspace rather than falling back to default.
    await Promise.all([
      Promise.resolve().then(() => channelA.emit({ type: 'run:start', flowId: 'flow-a' } as never)),
      Promise.resolve().then(() => channelB.emit({ type: 'run:start', flowId: 'flow-b' } as never)),
    ]);

    expect(perConversationA).toEqual(['flow-a']);
    expect(perConversationB).toEqual(['flow-b']);
    expect(globalA).toEqual(['flow-a']);
    expect(globalB).toEqual(['flow-b']);
    channelA.unsubscribe();
    channelA.unsubscribeGlobal();
    channelB.unsubscribe();
    channelB.unsubscribeGlobal();
  });

  it('keeps automation events and listener callback context workspace-local', async () => {
    const seenA: Array<{ output?: string; workspace: string }> = [];
    const seenB: Array<{ output?: string; workspace: string }> = [];

    const [automationA, automationB] = await Promise.all([
      inWorkspace(WORKSPACE_A, async () => {
        const bus = getFlowRunEventBus();
        const unsubscribe = bus.subscribe((event) => seenA.push({
          output: event.kind === 'signal' ? event.payload : event.outputText,
          workspace: getCurrentWorkspace(),
        }));
        return { bus, unsubscribe };
      }),
      inWorkspace(WORKSPACE_B, async () => {
        const bus = getFlowRunEventBus();
        const unsubscribe = bus.subscribe((event) => seenB.push({
          output: event.kind === 'signal' ? event.payload : event.outputText,
          workspace: getCurrentWorkspace(),
        }));
        return { bus, unsubscribe };
      }),
    ]);

    expect(automationA.bus).not.toBe(automationB.bus);
    // Publishing through captured bus references outside either ALS context also
    // proves listeners were explicitly rebound when subscribed.
    await Promise.all([
      Promise.resolve().then(() => automationA.bus.publish(flowEvent('from-a'))),
      Promise.resolve().then(() => automationB.bus.publish(flowEvent('from-b'))),
    ]);

    expect(seenA).toEqual([{ output: 'from-a', workspace: WORKSPACE_A }]);
    expect(seenB).toEqual([{ output: 'from-b', workspace: WORKSPACE_B }]);
    automationA.unsubscribe();
    automationB.unsubscribe();
  });

  it('applies conversation-cache eviction only inside the active workspace', async () => {
    const priorMaxEntries = process.env.FLUJO_CONVERSATION_CACHE_MAX_ENTRIES;
    process.env.FLUJO_CONVERSATION_CACHE_MAX_ENTRIES = '1';
    const sharedId = `same-cache-id-${crypto.randomUUID()}`;
    const extraId = `extra-cache-id-${crypto.randomUUID()}`;
    const stateA = completedState(sharedId);
    const stateB = completedState(sharedId);

    try {
      await Promise.all([
        inWorkspace(WORKSPACE_A, async () => {
          FlowExecutor.conversationStates.set(sharedId, stateA);
          noteWrite(sharedId, stateA);
          await markTerminal(sharedId, stateA, async () => undefined);
        }),
        inWorkspace(WORKSPACE_B, async () => {
          FlowExecutor.conversationStates.set(sharedId, stateB);
          noteWrite(sharedId, stateB);
          await markTerminal(sharedId, stateB, async () => undefined);
        }),
      ]);

      await inWorkspace(WORKSPACE_A, async () => {
        const extra = completedState(extraId);
        FlowExecutor.conversationStates.set(extraId, extra);
        noteWrite(extraId, extra);
        await markTerminal(extraId, extra, async () => undefined);
      });

      expect(inWorkspace(WORKSPACE_A, () => FlowExecutor.conversationStates.has(sharedId))).toBe(false);
      expect(inWorkspace(WORKSPACE_B, () => FlowExecutor.conversationStates.get(sharedId))).toBe(stateB);
      expect(inWorkspace(WORKSPACE_A, () => getConversationCacheDiagnostics().entries)).toBe(1);
      expect(inWorkspace(WORKSPACE_B, () => getConversationCacheDiagnostics().entries)).toBe(1);
    } finally {
      if (priorMaxEntries === undefined) delete process.env.FLUJO_CONVERSATION_CACHE_MAX_ENTRIES;
      else process.env.FLUJO_CONVERSATION_CACHE_MAX_ENTRIES = priorMaxEntries;
      inWorkspace(WORKSPACE_A, () => {
        forget(sharedId);
        forget(extraId);
        FlowExecutor.conversationStates.clear();
      });
      inWorkspace(WORKSPACE_B, () => {
        forget(sharedId);
        FlowExecutor.conversationStates.clear();
      });
    }
  });

  it('isolates provider model caches with identical provider URLs and cleanup', async () => {
    const baseUrl = 'https://same-provider.example/v1';
    const modelA = { id: 'model-a' } as NormalizedModel;
    const modelB = { id: 'model-b' } as NormalizedModel;

    await Promise.all([
      inWorkspace(WORKSPACE_A, async () => modelCache.set(baseUrl, [modelA])),
      inWorkspace(WORKSPACE_B, async () => modelCache.set(baseUrl, [modelB])),
    ]);

    expect(inWorkspace(WORKSPACE_A, () => modelCache.get(baseUrl))).toEqual([modelA]);
    expect(inWorkspace(WORKSPACE_B, () => modelCache.get(baseUrl))).toEqual([modelB]);

    inWorkspace(WORKSPACE_A, () => modelCache.clearAll());
    expect(inWorkspace(WORKSPACE_A, () => modelCache.get(baseUrl))).toBeNull();
    expect(inWorkspace(WORKSPACE_B, () => modelCache.get(baseUrl))).toEqual([modelB]);
    inWorkspace(WORKSPACE_B, () => modelCache.clearAll());
  });

  it('keeps MCP pool counters inside the workspace that acquired the lease', async () => {
    const client = {} as Client;
    const backend = {
      getClient: () => client,
      connectServer: async () => ({ success: true }),
      disconnectServer: async () => ({ success: true }),
      isServerDisabled: async () => false,
    };

    try {
      const acquired = await inWorkspace(WORKSPACE_A, () => acquireLease(backend, 'same-server'));
      expect(acquired.success).toBe(true);
      acquired.lease?.release();

      expect(inWorkspace(WORKSPACE_A, () => getPoolDiagnostics().acquires)).toBe(1);
      expect(inWorkspace(WORKSPACE_B, () => getPoolDiagnostics().acquires)).toBe(0);
    } finally {
      inWorkspace(WORKSPACE_A, _resetPoolForTests);
      inWorkspace(WORKSPACE_B, _resetPoolForTests);
      _resetLifecycleForTests();
    }
  });
});
