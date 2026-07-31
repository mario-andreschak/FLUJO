jest.mock('@/backend/execution/flow/conversationLog', () => ({
  appendRawForState: jest.fn(async () => undefined),
  flushConversationLog: jest.fn(async () => undefined),
}));
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async () => undefined),
}));

import {
  classifyRecoveryFailure,
  describeToolEffects,
  initializeRecovery,
  markDanglingToolEffectsUnknown,
} from '@/backend/execution/flow/recoveryCheckpoint';
import type { SharedState } from '@/backend/execution/flow/types';

function state(overrides: Partial<SharedState> = {}): SharedState {
  return {
    trackingInfo: { executionId: 'exec', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId: 'conversation-1',
    status: 'running',
    title: 'Conversation',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('recovery failure classification', () => {
  it('classifies rate limits as retryable and honors retry-after', () => {
    const before = Date.now();
    const result = classifyRecoveryFailure({
      message: 'Too many requests',
      details: { status: 429, code: 'rate_limit', retryAfter: 2 },
    });

    expect(result.classification).toBe('retryable_failure');
    expect(result.failure.category).toBe('rate_limit');
    expect(result.failure.retryable).toBe(true);
    expect(result.retryAfterAt).toBeGreaterThanOrEqual(before + 2_000);
  });

  it('keeps context limits and tool failures manual', () => {
    expect(classifyRecoveryFailure(new Error('maximum context length exceeded'))).toMatchObject({
      classification: 'permanent_failure',
      failure: { category: 'context_limit', retryable: false },
    });
    expect(classifyRecoveryFailure({ error: 'Tool execution failed' })).toMatchObject({
      classification: 'permanent_failure',
      failure: { category: 'tool_failure', retryable: false },
    });
  });

  it('classifies transient connection closes as retryable transport failures', () => {
    expect(classifyRecoveryFailure(new Error('socket closed with ECONNRESET'))).toMatchObject({
      classification: 'retryable_failure',
      failure: { category: 'transport_failure', retryable: true },
    });
  });
});

describe('durable recovery contracts', () => {
  it('preserves a logical run across pause/resume while refreshing ownership', () => {
    const shared = state();
    const initial = initializeRecovery(shared, 'run-1');
    initial.classification = 'paused';
    const resumed = initializeRecovery(shared, 'run-1');

    expect(resumed.version).toBe(1);
    expect(resumed.runId).toBe('run-1');
    expect(resumed.attemptId).toBe(initial.attemptId);
    expect(resumed.classification).toBe('running');
    expect(resumed.ownerId).toBeTruthy();
  });

  it('uses MCP annotations to separate read-only/idempotent and unsafe effects', () => {
    const shared = state({
      toolNameMap: {
        lookup: {
          server: 'server',
          tool: 'lookup',
          annotations: { readOnlyHint: true },
        },
        write: {
          server: 'server',
          tool: 'write',
          annotations: { destructiveHint: true },
        },
      },
    });
    const calls = [
      { id: 'call-read', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      { id: 'call-write', type: 'function', function: { name: 'write', arguments: '{}' } },
    ] as any;

    expect(describeToolEffects(shared, calls)).toEqual([
      expect.objectContaining({ toolCallId: 'call-read', readOnly: true, idempotent: true }),
      expect.objectContaining({ toolCallId: 'call-write', readOnly: false, idempotent: false, destructive: true }),
    ]);
  });

  it('marks repaired dangling tool effects unknown without replacing legacy status', () => {
    const shared = state({ status: 'error', currentNodeId: 'node-1' });
    initializeRecovery(shared, 'run-1');
    markDanglingToolEffectsUnknown(shared);

    expect(shared.status).toBe('error');
    expect(shared.recovery).toMatchObject({
      version: 1,
      classification: 'interrupted',
      manualActionRequired: true,
      currentCheckpoint: {
        phase: 'tool:unknown',
        nodeId: 'node-1',
        safe: false,
        effectStatus: 'unknown',
      },
      failure: { category: 'tool_failure', retryable: false },
    });
    expect(shared.recovery?.sideEffectWarning).toMatch(/Automatic replay is disabled/);
  });
});
