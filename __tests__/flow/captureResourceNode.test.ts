/**
 * Tier 3 — `captureResource` at the node seams (ProcessNode.post / SubflowNode.post).
 *
 * Mirrors namedVariables.test.ts's structure: promptRenderer/flowService are
 * mocked so prep/post run without a real flow store; the run-resource store is
 * mocked so post's writes are observable without disk. Pins:
 *  - post() stores the node's final output as a NAMED run resource and emits
 *    resource:write (source 'capture') via sharedState.emit;
 *  - ephemeral runs and missing conversationIds never write (policy chokepoint);
 *  - a store failure never breaks post (the action still returns).
 */

jest.mock('@/backend/utils/PromptRenderer', () => ({
  promptRenderer: { renderPrompt: jest.fn(async () => 'SYS') },
}));
jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: jest.fn(async () => ({ id: 'flow-1', name: 'f', nodes: [], edges: [] })) },
}));

const writeRunResourceMock = jest.fn();
jest.mock('@/backend/services/runResources', () => ({
  writeRunResource: (...args: unknown[]) => writeRunResourceMock(...args),
  findRunResourceByName: jest.fn(),
  readRunResource: jest.fn(),
}));

import { ProcessNode } from '@/backend/execution/flow/nodes/ProcessNode';
import { SubflowNode } from '@/backend/execution/flow/nodes/SubflowNode';
import type {
  SharedState,
  ProcessNodeParams,
  ProcessNodePrepResult,
  ProcessNodeExecResult,
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

describe('ProcessNode.post — captureResource', () => {
  const params = {
    id: 'proc-1',
    label: 'P',
    type: 'process',
    properties: { boundModel: 'm', name: 'Step', captureResource: 'artifact' },
  } as ProcessNodeParams;

  const prepResult = { nodeId: 'proc-1', nodeType: 'process' } as ProcessNodePrepResult;
  const okExec = { success: true, content: 'OUTPUT' } as ProcessNodeExecResult;

  it('stores the output as a named run resource and emits resource:write', async () => {
    const node = new ProcessNode();
    const emit = jest.fn();
    const state = makeState({ emit });

    await node.post(prepResult, okExec, state, params);

    expect(writeRunResourceMock).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1',
      name: 'artifact',
      kind: 'text',
      data: { text: 'OUTPUT' },
      producedBy: expect.objectContaining({ source: 'capture', nodeId: 'proc-1', nodeName: 'Step' }),
    }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource:write',
      server: 'flujo',
      uri: writtenEntry.uri,
      name: 'artifact',
      source: 'capture',
      node: expect.objectContaining({ nodeId: 'proc-1' }),
    }));
  });

  it('never writes on ephemeral runs (policy chokepoint)', async () => {
    const node = new ProcessNode();
    await node.post(prepResult, okExec, makeState({ ephemeral: true }), params);
    expect(writeRunResourceMock).not.toHaveBeenCalled();
  });

  it('never writes without a conversationId', async () => {
    const node = new ProcessNode();
    await node.post(prepResult, okExec, makeState({ conversationId: undefined }), params);
    expect(writeRunResourceMock).not.toHaveBeenCalled();
  });

  it('never writes on a failed exec, and a store failure never breaks post', async () => {
    const node = new ProcessNode();
    await node.post(prepResult, { success: false, error: 'x' } as ProcessNodeExecResult, makeState(), params);
    expect(writeRunResourceMock).not.toHaveBeenCalled();

    writeRunResourceMock.mockRejectedValue(new Error('store down'));
    const action = await node.post(prepResult, okExec, makeState(), params);
    expect(typeof action).toBe('string'); // post still returns an action
  });

  it('skipped writes (caps) emit nothing', async () => {
    writeRunResourceMock.mockResolvedValue({ skipped: 'size-cap' });
    const node = new ProcessNode();
    const emit = jest.fn();
    await node.post(prepResult, okExec, makeState({ emit }), params);
    expect(emit.mock.calls.map(([e]) => e.type)).not.toContain('resource:write');
  });
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
