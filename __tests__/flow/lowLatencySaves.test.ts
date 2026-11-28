/**
 * #1408: only step boundaries without tool
 * effects and a successful end of a run wait for the next full save. Every
 * checkpoint around a tool that may change something is saved at once.
 */
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  appendRawForState: jest.fn(async () => undefined),
  flushConversationLog: jest.fn(async () => undefined),
}));
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async () => undefined),
}));

import { appendRawForState, flushConversationLog } from '@/backend/execution/flow/conversationLog';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import {
  commitRecoveryCheckpoint,
  commitRecoveryTransition,
  commitToolCheckpoint,
  initializeRecovery,
} from '@/backend/execution/flow/recoveryCheckpoint';
import type { SharedState } from '@/backend/execution/flow/types';
import type { StorageKey } from '@/shared/types/storage';

const key = 'conversations/conversation-1' as StorageKey;
const saves = persistConversationState as jest.Mock;
const flushes = flushConversationLog as jest.Mock;
const appends = appendRawForState as jest.Mock;

function state(overrides: Partial<SharedState> = {}): SharedState {
  const shared: SharedState = {
    trackingInfo: { executionId: 'exec', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId: 'conversation-1',
    status: 'running',
    title: 'Conversation',
    createdAt: 1,
    updatedAt: 1,
    currentNodeId: 'process',
    toolNameMap: {
      write: { server: 'server', tool: 'write', annotations: { readOnlyHint: false } },
    },
    ...overrides,
  } as SharedState;
  initializeRecovery(shared, 'run-1');
  return shared;
}

const writeCall = [{ id: 'write-once', type: 'function', function: { name: 'write', arguments: '{}' } }] as never;
const nodeBoundary = (shared: SharedState, emit?: jest.Mock) => commitRecoveryCheckpoint(key, shared, {
  phase: 'node:before', nodeId: 'process', safe: true, durability: 'untilNextSave',
}, emit);

const previous = process.env.FLUJO_LOW_LATENCY_SAVES;
beforeEach(() => {
  jest.clearAllMocks();
});
afterAll(() => {
  if (previous === undefined) delete process.env.FLUJO_LOW_LATENCY_SAVES;
  else process.env.FLUJO_LOW_LATENCY_SAVES = previous;
});

describe('fewer saves per turn', () => {
  it('ignores the retired environment switch (#1449)', async () => {
    process.env.FLUJO_LOW_LATENCY_SAVES = '0';
    const emit = jest.fn();
    await nodeBoundary(state(), emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(saves).not.toHaveBeenCalled();
    delete process.env.FLUJO_LOW_LATENCY_SAVES;
  });

  it('leaves a step boundary to the next full save, still sending its event', async () => {
    const shared = state();
    const emit = jest.fn();
    const checkpoint = await nodeBoundary(shared, emit);
    expect(emit).toHaveBeenCalledWith({ type: 'recovery:checkpoint', checkpoint });
    expect(flushes).not.toHaveBeenCalled();
    expect(saves).not.toHaveBeenCalled();
    // The record is on the live state, so the next full save writes it.
    expect(shared.recovery?.currentCheckpoint).toBe(checkpoint);
    expect(shared.recovery?.lastSafeCheckpoint).toBe(checkpoint);
  });

  it('still appends the event to the log when there is no live emitter', async () => {
    await nodeBoundary(state());
    expect(appends).toHaveBeenCalledTimes(1);
    expect(saves).not.toHaveBeenCalled();
  });

  it.each(['before', 'completed', 'unknown'] as const)('saves the %s checkpoint of a tool that may change something at once', async phase => {
    const emit = jest.fn();
    await commitToolCheckpoint(key, state(), writeCall, phase, emit);
    expect(flushes).toHaveBeenCalledTimes(1);
    expect(saves).toHaveBeenCalledTimes(1);
  });

  it('ignores a request to wait on a checkpoint that is not a safe boundary', async () => {
    const shared = state();
    await commitRecoveryCheckpoint(key, shared, {
      phase: 'tool:before', nodeId: 'process', safe: false, effectStatus: 'pending', durability: 'untilNextSave',
    });
    await commitRecoveryCheckpoint(key, shared, {
      phase: 'node:after', nodeId: 'process', safe: true, effectStatus: 'completed', durability: 'untilNextSave',
    });
    await commitRecoveryCheckpoint(key, shared, {
      phase: 'node:after', nodeId: 'process', safe: true, durability: 'untilNextSave',
      tools: [{ toolCallId: 'write-once', name: 'write', readOnly: false, idempotent: false }],
    });
    expect(saves).toHaveBeenCalledTimes(3);
  });

  it('leaves only a successful end of a run to the final save', async () => {
    await commitRecoveryTransition(key, state(), 'completed', { durability: 'untilNextSave' });
    await commitRecoveryTransition(key, state(), 'capped', { durability: 'untilNextSave' });
    expect(saves).not.toHaveBeenCalled();
    await commitRecoveryTransition(key, state(), 'running', { durability: 'untilNextSave' } as never);
    await commitRecoveryTransition(key, state(), 'paused', { durability: 'untilNextSave' } as never);
    await commitRecoveryTransition(key, state(), 'permanent_failure', { durability: 'untilNextSave' } as never);
    await commitRecoveryTransition(key, state(), 'completed', { durability: 'untilNextSave', manualActionRequired: true });
    expect(saves).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['debugger', { debugMode: true }],
    ['Persona', { personaAttribution: { personaId: 'persona' } }],
    ['execution extension', { executionExtensionOwned: true }],
  ] as const)('saves every step of a %s run at once', async (_kind, overrides) => {
    await nodeBoundary(state(overrides as Partial<SharedState>));
    expect(saves).toHaveBeenCalledTimes(1);
  });
});
