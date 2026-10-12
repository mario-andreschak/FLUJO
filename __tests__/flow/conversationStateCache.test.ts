import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import {
  _resetConversationCacheForTests,
  coalesceLoad,
  enforceBounds,
  estimateStateBytes,
  getConversationCacheDiagnostics,
  markTerminal,
  noteRead,
  noteWrite,
} from '@/backend/execution/flow/conversationStateCache';
import type { SharedState } from '@/backend/execution/flow/types';
import { runWithWorkspace } from '@/utils/workspace';

const WORKSPACE = 'cache-payload-fixture';
const OTHER_WORKSPACE = 'cache-payload-fixture-other';
const CACHE_ENV = [
  'FLUJO_CONVERSATION_CACHE_TTL_MS',
  'FLUJO_CONVERSATION_CACHE_MAX_ENTRIES',
  'FLUJO_CONVERSATION_CACHE_MAX_BYTES',
] as const;

function state(id: string, overrides: Partial<SharedState> = {}): SharedState {
  return {
    conversationId: id, flowId: 'fixture-flow', status: 'completed',
    trackingInfo: { executionId: id, startTime: 1, nodeExecutionTracker: [] },
    messages: [], title: 'fixture', createdAt: 1, updatedAt: 1, ...overrides,
  };
}

function register(value: SharedState): void {
  FlowExecutor.conversationStates.set(value.conversationId!, value);
  noteWrite(value.conversationId!, value);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('conversation cache retained-payload accounting', () => {
  let previousEnv: Array<string | undefined>;
  beforeEach(() => {
    previousEnv = CACHE_ENV.map(key => process.env[key]);
    for (const key of CACHE_ENV) delete process.env[key];
    for (const workspace of [WORKSPACE, OTHER_WORKSPACE]) {
      runWithWorkspace(workspace, () => FlowExecutor.conversationStates.clear());
    }
    _resetConversationCacheForTests();
  });
  afterEach(() => {
    for (let index = 0; index < CACHE_ENV.length; index++) {
      const previous = previousEnv[index];
      if (previous === undefined) delete process.env[CACHE_ENV[index]];
      else process.env[CACHE_ENV[index]] = previous;
    }
    for (const workspace of [WORKSPACE, OTHER_WORKSPACE]) {
      runWithWorkspace(workspace, () => FlowExecutor.conversationStates.clear());
    }
    _resetConversationCacheForTests();
    jest.restoreAllMocks();
  });

  it('counts media, tool arguments, subflow outputs and debug wire snapshots without serializing them', () => {
    const media = 'A'.repeat(2_000_000);
    const argumentsJson = 'B'.repeat(300_000);
    const childOutput = 'C'.repeat(400_000);
    const debugWire = 'D'.repeat(500_000);
    const value = state('payloads', {
      messages: [{ role: 'assistant', content: null, media: [{ type: 'image', data: media }],
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'fixture', arguments: argumentsJson } }] }],
      subflowInvocations: { folded: { status: 'folded', lanes: [{ outputText: childOutput }] } },
      executionTrace: [{ modelInputs: [{ sdkRequest: { prompt: debugWire } }] }],
    } as unknown as Partial<SharedState>);
    const serialize = jest.spyOn(JSON, 'stringify');
    expect(estimateStateBytes(value)).toBeGreaterThanOrEqual(
      2 * (media.length + argumentsJson.length + childOutput.length + debugWire.length),
    );
    expect(serialize).not.toHaveBeenCalled();
    expect(value.messages[0].media?.[0].data).toBe(media);
  });

  it('counts aliases and cycles once, including the full shared binary backing store', () => {
    const backing = new ArrayBuffer(1024 * 1024);
    const shared = { payload: 'X'.repeat(10_000), binary: new Uint8Array(backing, 0, 16) };
    const value = state('aliases', { lastResponse: { first: shared, second: shared } });
    value.lastResponse = { first: shared, second: shared, self: value };
    const estimate = estimateStateBytes(value);
    expect(estimate).toBeGreaterThanOrEqual(backing.byteLength + shared.payload.length * 2);
    expect(estimate).toBeLessThan(backing.byteLength + shared.payload.length * 2 + 10_000);
  });

  it('does not invoke getters/toJSON or traverse runtime capability/client graphs', () => {
    const get = jest.fn(() => { throw new Error('getter must not run'); });
    const toJSON = jest.fn(() => { throw new Error('toJSON must not run'); });
    const opaque = { transcript: 'X'.repeat(2_000_000) };
    const value = state('runtime', { lastResponse: { toJSON } });
    Object.defineProperty(value.lastResponse, 'computed', { enumerable: true, get });
    Object.assign(value, { executionAuthority: opaque, executionExtensionContext: opaque, mcpContext: opaque });
    expect(estimateStateBytes(value)).toBeLessThan(10_000);
    expect(get).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('saturates an excessively broad graph without walking all its values', () => {
    const value = state('cardinality', { lastResponse: { values: new Array(100_001).fill('x') } });
    expect(estimateStateBytes(value)).toBe(Number.MAX_SAFE_INTEGER);
    runWithWorkspace(WORKSPACE, () => {
      register(value);
      expect(getConversationCacheDiagnostics().saturatedEstimateEntries).toBe(1);
    });
  });

  it('refreshes existing writes and invalidates eligibility until the new state is persisted', async () => {
    await runWithWorkspace(WORKSPACE, async () => {
      const value = state('growing');
      register(value);
      await markTerminal('growing', value, async () => undefined);
      const before = getConversationCacheDiagnostics();
      value.messages.push({ id: 'growth', timestamp: 1, role: 'user', content: 'X'.repeat(300_000) });
      noteWrite('growing', value);
      const after = getConversationCacheDiagnostics();
      expect(after.estimatedBytes - before.estimatedBytes).toBeGreaterThanOrEqual(600_000);
      expect(after.evictableEntries).toBe(0);
      process.env.FLUJO_CONVERSATION_CACHE_MAX_BYTES = '1000';
      expect(enforceBounds()).toBe(0);
      expect(FlowExecutor.conversationStates.get('growing')).toBe(value);
      await markTerminal('growing', value, async () => undefined);
      expect(FlowExecutor.conversationStates.has('growing')).toBe(false);
    });
  });

  it('refreshes unregistered in-place growth but protects it until a new persistence succeeds', async () => {
    await runWithWorkspace(WORKSPACE, async () => {
      const value = state('media');
      register(value);
      await markTerminal('media', value, async () => undefined);
      value.messages.push({ id: 'media', timestamp: 1, role: 'assistant', content: null, media: [{ type: 'image', data: 'A'.repeat(1_000_000) }] });
      process.env.FLUJO_CONVERSATION_CACHE_MAX_BYTES = '1000000';
      expect(enforceBounds()).toBe(0);
      expect(getConversationCacheDiagnostics().protectedEstimatedBytes).toBeGreaterThan(2_000_000);
      expect(FlowExecutor.conversationStates.get('media')).toBe(value);
      await markTerminal('media', value, async () => undefined);
      expect(FlowExecutor.conversationStates.has('media')).toBe(false);
    });
  });

  it('evicts persisted media that exceeds the byte budget without altering canonical history', async () => {
    await runWithWorkspace(WORKSPACE, async () => {
      const value = state('media', {
        messages: [{ id: 'media', timestamp: 1, role: 'assistant', content: null, media: [{ type: 'image', data: 'A'.repeat(1_000_000) }] }],
      });
      register(value);
      const persist = jest.fn(async () => undefined);
      await markTerminal('media', value, persist);
      process.env.FLUJO_CONVERSATION_CACHE_MAX_BYTES = '1000000';
      expect(enforceBounds()).toBe(1);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(FlowExecutor.conversationStates.has('media')).toBe(false);
      expect(value.messages[0].media?.[0].data?.length).toBe(1_000_000);
    });
  });

  it('rejects an unregistered payload change during a pending persistence', async () => {
    await runWithWorkspace(WORKSPACE, async () => {
      const value = state('pending-growth');
      register(value);
      const pending = deferred();
      const marking = markTerminal('pending-growth', value, () => pending.promise);
      value.variables = { newPayload: 'X'.repeat(100_000) };
      pending.resolve();
      await marking;
      process.env.FLUJO_CONVERSATION_CACHE_MAX_BYTES = '1000';
      expect(enforceBounds()).toBe(0);
      expect(FlowExecutor.conversationStates.get('pending-growth')).toBe(value);
    });
  });

  it.each(['running', 'paused_debug', 'awaiting_tool_approval', undefined] as const)(
    'reports pressure while preserving a %s state and evicting only persisted terminal data', async status => {
      await runWithWorkspace(WORKSPACE, async () => {
        const protectedState = state('protected', { status, messages: [{ id: 'protected', timestamp: 1, role: 'user', content: 'X'.repeat(100_000) }] });
        const terminal = state('terminal');
        register(protectedState);
        register(terminal);
        await markTerminal('terminal', terminal, async () => undefined);
        const persist = jest.fn(async () => undefined);
        await markTerminal('protected', protectedState, persist);
        process.env.FLUJO_CONVERSATION_CACHE_MAX_BYTES = '1000';
        expect(enforceBounds()).toBe(1);
        expect(persist).not.toHaveBeenCalled();
        expect(FlowExecutor.conversationStates.get('protected')).toBe(protectedState);
        expect(getConversationCacheDiagnostics()).toMatchObject({ entries: 1, protectedEntries: 1, evictableEntries: 0 });
        expect(getConversationCacheDiagnostics().overBudgetBytes).toBeGreaterThan(0);
      });
    },
  );

  it.each([
    { recovery: { owner: { processId: 'fixture' } } },
    { pendingToolCalls: [{ id: 'pending' }] },
    { debugPendingAction: { action: 'continue', phase: 'after-model' } },
    { debugPendingToolCalls: [{ id: 'pending-debug' }] },
    { subflowInvocations: { pending: { status: 'blocked' } } },
  ])('preserves unresolved ownership even under a stale terminal status (%j)', async pending => {
    await runWithWorkspace(WORKSPACE, async () => {
      const value = state('pending', pending as unknown as Partial<SharedState>);
      register(value);
      process.env.FLUJO_CONVERSATION_CACHE_MAX_BYTES = '1000';
      const persist = jest.fn(async () => undefined);
      await markTerminal('pending', value, persist);
      expect(enforceBounds()).toBe(0);
      expect(persist).not.toHaveBeenCalled();
      expect(FlowExecutor.conversationStates.get('pending')).toBe(value);
    });
  });

  it('counts resumed protected bytes accurately when selecting remaining terminal candidates', async () => {
    await runWithWorkspace(WORKSPACE, async () => {
      const resumed = state('resumed', { messages: [{ id: 'resumed', timestamp: 1, role: 'user', content: 'R'.repeat(80_000) }] });
      const terminal = state('terminal', { messages: [{ id: 'terminal', timestamp: 1, role: 'user', content: 'T'.repeat(40_000) }] });
      register(resumed);
      await markTerminal('resumed', resumed, async () => undefined);
      register(terminal);
      await markTerminal('terminal', terminal, async () => undefined);
      resumed.status = 'running'; // Direct legacy map mutation, without noteWrite.
      process.env.FLUJO_CONVERSATION_CACHE_MAX_BYTES = '100000';
      expect(enforceBounds()).toBe(1);
      expect(FlowExecutor.conversationStates.get('resumed')).toBe(resumed);
      expect(FlowExecutor.conversationStates.has('terminal')).toBe(false);
      expect(getConversationCacheDiagnostics().protectedEstimatedBytes).toBeGreaterThan(160_000);
    });
  });

  it('does not let a stale persistence completion authorize eviction of a replacement state', async () => {
    await runWithWorkspace(WORKSPACE, async () => {
      const original = state('race');
      register(original);
      const pending = deferred();
      const marking = markTerminal('race', original, () => pending.promise);
      const replacement = state('race');
      register(replacement);
      pending.resolve();
      await marking;
      process.env.FLUJO_CONVERSATION_CACHE_MAX_BYTES = '1000';
      expect(enforceBounds()).toBe(0);
      expect(FlowExecutor.conversationStates.get('race')).toBe(replacement);
      expect(getConversationCacheDiagnostics().evictableEntries).toBe(0);
    });
  });

  it('does not let an older successful persist override a newer failed write of the same object', async () => {
    await runWithWorkspace(WORKSPACE, async () => {
      const value = state('race');
      register(value);
      const pending = deferred();
      const older = markTerminal('race', value, () => pending.promise);
      value.variables = { changed: 'not durably saved' };
      noteWrite('race', value);
      await markTerminal('race', value, async () => { throw new Error('fixture disk failure'); });
      pending.resolve();
      await older;
      process.env.FLUJO_CONVERSATION_CACHE_MAX_BYTES = '1000';
      expect(enforceBounds()).toBe(0);
      expect(getConversationCacheDiagnostics()).toMatchObject({ persistFailures: 1, evictableEntries: 0 });
      expect(FlowExecutor.conversationStates.get('race')).toBe(value);
    });
  });

  it('revokes eligibility for a direct map replacement that has no persistence receipt', async () => {
    await runWithWorkspace(WORKSPACE, async () => {
      const original = state('replacement');
      register(original);
      await markTerminal('replacement', original, async () => undefined);
      const replacement = state('replacement');
      FlowExecutor.conversationStates.set('replacement', replacement);
      process.env.FLUJO_CONVERSATION_CACHE_MAX_BYTES = '1000';
      expect(enforceBounds()).toBe(0);
      expect(FlowExecutor.conversationStates.get('replacement')).toBe(replacement);
    });
  });

  it('preserves terminal-only LRU/TTL behavior and isolates same-id payload budgets by workspace', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const first = state('same');
    const sibling = state('same');
    await runWithWorkspace(WORKSPACE, async () => {
      register(first);
      await markTerminal('same', first, async () => undefined);
    });
    await runWithWorkspace(OTHER_WORKSPACE, async () => {
      register(sibling);
      await markTerminal('same', sibling, async () => undefined);
    });
    await runWithWorkspace(WORKSPACE, async () => {
      now.mockReturnValue(10_001);
      const second = state('newer');
      register(second);
      await markTerminal('newer', second, async () => undefined);
      now.mockReturnValue(10_002);
      noteRead('same', true);
      now.mockReturnValue(10_003);
      const third = state('newest');
      register(third);
      process.env.FLUJO_CONVERSATION_CACHE_MAX_ENTRIES = '2';
      await markTerminal('newest', third, async () => undefined);
      expect(FlowExecutor.conversationStates.has('same')).toBe(true);
      expect(FlowExecutor.conversationStates.has('newer')).toBe(false);
      process.env.FLUJO_CONVERSATION_CACHE_TTL_MS = '10';
      now.mockReturnValue(10_020);
      expect(enforceBounds()).toBe(2);
    });
    expect(runWithWorkspace(OTHER_WORKSPACE, () => FlowExecutor.conversationStates.get('same'))).toBe(sibling);
    expect(runWithWorkspace(OTHER_WORKSPACE, () => getConversationCacheDiagnostics().entries)).toBe(1);
  });

  it('coalesces concurrent reloads after eviction and keeps the canonical payload intact', async () => {
    await runWithWorkspace(WORKSPACE, async () => {
      const durable = state('reload', { messages: [{ id: 'canonical', timestamp: 1, role: 'user', content: 'canonical history' }] });
      register(durable);
      process.env.FLUJO_CONVERSATION_CACHE_MAX_BYTES = '1000';
      await markTerminal('reload', durable, async () => undefined);
      expect(FlowExecutor.conversationStates.has('reload')).toBe(false);
      const pending = deferred();
      const loader = jest.fn(async () => { await pending.promise; register(durable); return durable; });
      const first = coalesceLoad('reload', loader);
      const second = coalesceLoad('reload', loader);
      expect(second).toBe(first);
      pending.resolve();
      expect(await first).toBe(durable);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(durable.messages[0].content).toBe('canonical history');
      expect(getConversationCacheDiagnostics()).toMatchObject({ reloads: 1, coalescedLoads: 1, inFlightLoads: 0 });
    });
  });
});
