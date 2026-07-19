/**
 * Tier 3 — `captureResource` at the SubflowNode.post seam.
 *
 * NOTE (issue #161): ProcessNode's passive `captureResource` was REMOVED — a
 * process step that hands off ends with empty content, so the passive capture
 * wrote empty artifacts. The produce side of a process node is now an explicit
 * `write_resource` tool (see runResourceTools.test.ts). SubflowNode keeps its
 * passive capture: a subflow's folded child output is a real, non-empty result
 * and there is no in-loop tool seam for a subflow node.
 *
 * flowService is mocked so post runs without a real flow store; the
 * run-resource store is mocked so post's writes are observable without disk.
 */

jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: jest.fn(async () => ({ id: 'flow-1', name: 'f', nodes: [], edges: [] })) },
}));

const writeRunResourceMock = jest.fn();
jest.mock('@/backend/services/runResources', () => ({
  writeRunResource: (...args: unknown[]) => writeRunResourceMock(...args),
  findRunResourceByName: jest.fn(),
  readRunResource: jest.fn(),
}));

import { SubflowNode } from '@/backend/execution/flow/nodes/SubflowNode';
import type {
  SharedState,
  SubflowNodeParams,
  SubflowNodeExecResult,
} from '@/backend/execution/flow/types';

function makeState(overrides: Partial<SharedState> = {}): SharedState {
  return {
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId: 'conv-1',
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as SharedState;
}

const writtenEntry = {
  id: 'res-9',
  uri: 'flujo://run/conv-1/res-9',
  conversationId: 'conv-1',
  name: 'artifact',
  mimeType: 'text/markdown',
  size: 6,
  kind: 'text',
  encoding: 'utf8',
  createdAt: 1,
  producedBy: { source: 'capture' },
  readBy: [],
};

beforeEach(() => {
  writeRunResourceMock.mockReset();
  writeRunResourceMock.mockResolvedValue(writtenEntry);
});

describe('SubflowNode.post — captureResource', () => {
  const params = {
    id: 'sub-1',
    label: 'S',
    type: 'subflow',
    properties: { subflowId: 'child-1', name: 'Child', captureResource: 'artifact' },
  } as SubflowNodeParams;

  it('stores the folded child output on the PARENT run', async () => {
    const node = new SubflowNode();
    const emit = jest.fn();
    const state = makeState({ emit });
    const prep = { nodeId: 'sub-1', nodeType: 'subflow', subflowId: 'child-1' } as never;
    const exec = { success: true, outputText: 'CHILD OUT' } as SubflowNodeExecResult;

    await node.post(prep, exec, state, params);

    expect(writeRunResourceMock).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1',
      name: 'artifact',
      data: { text: 'CHILD OUT' },
      producedBy: expect.objectContaining({ source: 'capture', nodeId: 'sub-1' }),
    }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource:write', name: 'artifact', source: 'capture',
    }));
  });

  it('respects the ephemeral gate', async () => {
    const node = new SubflowNode();
    const prep = { nodeId: 'sub-1', nodeType: 'subflow', subflowId: 'child-1' } as never;
    const exec = { success: true, outputText: 'CHILD OUT' } as SubflowNodeExecResult;
    await node.post(prep, exec, makeState({ ephemeral: true }), params);
    expect(writeRunResourceMock).not.toHaveBeenCalled();
  });
});
