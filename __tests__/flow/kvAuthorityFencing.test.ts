/**
 * Phase-2 execution fencing for persistent `${kv:...}` capture.
 *
 * Folder resolution is deliberately held open while ownership advances. The
 * stale node must reach the shared capture chokepoint only after recovery and
 * fail there without writing; the successor generation must then commit.
 */

const mockGetFlow = jest.fn();
const mockKvSet = jest.fn();

jest.mock('@/backend/services/flow/index', () => ({
  flowService: {
    getFlow: (...args: unknown[]) => mockGetFlow(...args),
  },
}));

jest.mock('@/backend/services/kvStore', () => ({
  kvGet: jest.fn(async () => undefined),
  kvSet: (...args: unknown[]) => mockKvSet(...args),
}));

import { ProcessNode } from '@/backend/execution/flow/nodes/ProcessNode';
import { SubflowNode } from '@/backend/execution/flow/nodes/SubflowNode';
import { captureKvValue } from '@/backend/execution/flow/resolveKvNodeRefs';
import type {
  FlowExecutionAuthority,
  ProcessNodeExecResult,
  ProcessNodeParams,
  ProcessNodePrepResult,
  SharedState,
  SubflowNodeExecResult,
  SubflowNodeParams,
} from '@/backend/execution/flow/types';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

let currentGeneration = 1;

function authorityFor(generation: number): FlowExecutionAuthority {
  const assertCurrent = jest.fn(async () => {
    if (currentGeneration !== generation) {
      throw new Error(`generation ${generation} is no longer current`);
    }
  });
  const commitWhileCurrent = jest.fn(async (task: () => Promise<unknown>) => {
    await assertCurrent();
    return task();
  }) as unknown as NonNullable<FlowExecutionAuthority['commitWhileCurrent']>;
  return {
    assertCurrent,
    signal: new AbortController().signal,
    commitWhileCurrent,
  };
}

function stateFor(
  authority: FlowExecutionAuthority | undefined,
  kind: 'persona' | 'meeting',
): SharedState {
  return {
    trackingInfo: { executionId: `${kind}-execution`, startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-kv-fence',
    conversationId: `${kind}-conversation`,
    title: kind,
    createdAt: 1,
    updatedAt: 1,
    source: kind === 'meeting' ? 'meeting' : 'api',
    executionAuthority: authority,
    ...(kind === 'persona' ? {
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'revision-1',
      },
    } : {}),
  } as SharedState;
}

const processPrep: ProcessNodePrepResult = {
  nodeId: 'process-kv',
  nodeType: 'process',
  currentPrompt: '',
  boundModel: 'unused',
  messages: [],
};

const processParams = {
  id: 'process-kv',
  label: 'Process KV',
  type: 'process',
  properties: { captureKv: 'cursor' },
} as ProcessNodeParams;

const subflowParams = {
  id: 'subflow-kv',
  label: 'Subflow KV',
  type: 'subflow',
  properties: { subflowId: 'child-flow', captureKv: 'cursor' },
} as SubflowNodeParams;

beforeEach(() => {
  currentGeneration = 1;
  mockGetFlow.mockReset();
  mockKvSet.mockReset();
  mockKvSet.mockImplementation(async (scope: string, name: string, value: string) => ({
    scope,
    name,
    value,
    size: value.length,
    createdAt: 1,
    updatedAt: 1,
  }));
});

describe('persistent KV execution authority', () => {
  it('fails closed for Persona attribution without a lock-capable authority', async () => {
    await expect(captureKvValue('cursor', 'unsafe', {
      flowId: 'flow-kv-fence',
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'revision-1',
      },
    })).rejects.toThrow(/requires current execution authority/i);

    expect(mockKvSet).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'ProcessNode Persona Activity',
      run: (
        state: SharedState,
        value: string,
      ) => new ProcessNode().post(
        processPrep,
        { success: true, content: value } as ProcessNodeExecResult,
        state,
        processParams,
      ),
      kind: 'persona' as const,
    },
    {
      label: 'SubflowNode meeting generation',
      run: (
        state: SharedState,
        value: string,
      ) => new SubflowNode().post(
        { nodeId: 'subflow-kv', nodeType: 'subflow', subflowId: 'child-flow' } as never,
        { success: true, outputText: value, subStatus: 'completed' } as SubflowNodeExecResult,
        state,
        subflowParams,
      ),
      kind: 'meeting' as const,
    },
  ])('$label rejects a stale capture after delayed flow lookup and lets its successor commit', async ({ run, kind }) => {
    const lookup = deferred<{ folder: string }>();
    const lookupStarted = deferred<void>();
    mockGetFlow.mockImplementationOnce(() => {
      lookupStarted.resolve(undefined);
      return lookup.promise;
    });
    const staleAuthority = authorityFor(1);
    const staleCapture = run(stateFor(staleAuthority, kind), 'stale-value');

    await lookupStarted.promise;
    expect(mockGetFlow).toHaveBeenCalledTimes(1);
    currentGeneration = 2;
    lookup.resolve({ folder: 'shared-board' });

    await expect(staleCapture).rejects.toThrow(/authority|current/i);
    expect(mockKvSet).not.toHaveBeenCalled();

    mockGetFlow.mockResolvedValueOnce({ folder: 'shared-board' });
    const successorAuthority = authorityFor(2);
    await expect(run(stateFor(successorAuthority, kind), 'successor-value')).resolves.toBeDefined();

    expect(staleAuthority.commitWhileCurrent).toHaveBeenCalledTimes(1);
    expect(successorAuthority.commitWhileCurrent).toHaveBeenCalledTimes(1);
    expect(mockKvSet).toHaveBeenCalledTimes(1);
    expect(mockKvSet).toHaveBeenCalledWith(
      expect.stringMatching(/^folder-/),
      'cursor',
      'successor-value',
    );
  });
});
