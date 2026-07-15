/**
 * Tier 2c — named variables end-to-end at the node seams.
 *
 * ProcessNode: `captureVariable` writes the model's final text into
 *   sharedState.variables in post(); prep() resolves `${var:NAME}` in the
 *   rendered system prompt AND the isolated prompt from that same scratchpad.
 * SubflowNode: `captureVariable` folds the child's outputText into the PARENT's
 *   vars in post(); prep() resolves `${var:NAME}` in the isolated inputText.
 *
 * promptRenderer + flowService are mocked so prep runs without a real flow store.
 */

jest.mock('@/backend/utils/PromptRenderer', () => ({
  promptRenderer: { renderPrompt: jest.fn() },
}));
jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: jest.fn(async () => ({ id: 'flow-1', name: 'f', nodes: [], edges: [] })) },
}));

import { ProcessNode } from '@/backend/execution/flow/nodes/ProcessNode';
import { SubflowNode } from '@/backend/execution/flow/nodes/SubflowNode';
import { promptRenderer } from '@/backend/utils/PromptRenderer';
import type {
  SharedState,
  ProcessNodeParams,
  ProcessNodePrepResult,
  ProcessNodeExecResult,
  SubflowNodeParams,
  SubflowNodeExecResult,
} from '@/backend/execution/flow/types';

const renderPromptMock = promptRenderer.renderPrompt as jest.Mock;

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

function procParams(properties: Record<string, unknown>): ProcessNodeParams {
  return { id: 'proc', label: 'P', type: 'process', properties: { boundModel: 'm', ...properties } } as ProcessNodeParams;
}

beforeEach(() => {
  renderPromptMock.mockReset();
});

describe('ProcessNode.prep — ${var:NAME} resolution', () => {
  it('resolves vars in the rendered system prompt (currentPrompt)', async () => {
    renderPromptMock.mockResolvedValue('Follow the plan: ${var:plan}');
    const node = new ProcessNode();
    const state = makeState({ variables: { plan: 'STEP ONE' } });
    const prep = await node.prep(state, procParams({}));
    expect(prep.currentPrompt).toBe('Follow the plan: STEP ONE');
    // The system message inserted into the threaded history is resolved too.
    expect(prep.messages[0]?.content).toBe('Follow the plan: STEP ONE');
  });

  it('resolves vars in the isolated prompt (wire-only user message)', async () => {
    renderPromptMock.mockResolvedValue('SYS');
    const node = new ProcessNode();
    const state = makeState({ variables: { path: '/etc/hosts' } });
    const prep = await node.prep(
      state,
      procParams({ inputMode: 'isolated', isolatedPrompt: 'Inspect ${var:path} now' }),
    );
    const userMsg = prep.wireMessages?.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('Inspect /etc/hosts now');
  });

  it('unknown var → empty string in the prompt (never leaks the literal token)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    renderPromptMock.mockResolvedValue('x=${var:missing}');
    const node = new ProcessNode();
    const prep = await node.prep(makeState({ variables: {} }), procParams({}));
    expect(prep.currentPrompt).toBe('x=');
    warn.mockRestore();
  });
});

describe('ProcessNode.post — captureVariable', () => {
  const prep: ProcessNodePrepResult = {
    nodeId: 'proc',
    nodeType: 'process',
    currentPrompt: 'x',
    boundModel: 'm',
    messages: [],
  };
  const okExec = (content: string): ProcessNodeExecResult => ({ success: true, content });

  it('writes the model output into sharedState.variables', async () => {
    const node = new ProcessNode();
    const state = makeState();
    await node.post(prep, okExec('the answer'), state, procParams({ captureVariable: 'result' }));
    expect(state.variables?.result).toBe('the answer');
  });

  it('a later node then resolves the captured value', async () => {
    const node = new ProcessNode();
    const state = makeState();
    await node.post(prep, okExec('42'), state, procParams({ captureVariable: 'answer' }));

    renderPromptMock.mockResolvedValue('Prior answer was ${var:answer}');
    const laterPrep = await node.prep(state, procParams({}));
    expect(laterPrep.currentPrompt).toBe('Prior answer was 42');
  });

  it('does NOT capture when the node errored', async () => {
    const node = new ProcessNode();
    const state = makeState();
    await node.post(prep, { success: false, error: 'boom' }, state, procParams({ captureVariable: 'result' }));
    expect(state.variables?.result).toBeUndefined();
  });

  it('no captureVariable → variables left untouched', async () => {
    const node = new ProcessNode();
    const state = makeState();
    await node.post(prep, okExec('x'), state, procParams({}));
    expect(state.variables).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SubflowNode
// ---------------------------------------------------------------------------

function subParams(properties: Record<string, unknown>): SubflowNodeParams {
  return { id: 'sub', label: 'S', type: 'subflow', properties } as unknown as SubflowNodeParams;
}

function subNode(): SubflowNode {
  const node = new SubflowNode();
  (node as unknown as { successors: Record<string, unknown> }).successors = { NEXT: {} };
  return node;
}

describe('SubflowNode.prep — ${var:NAME} in isolated inputText', () => {
  it('resolves vars in the subflow prompt', async () => {
    const node = subNode();
    const state = makeState({ variables: { topic: 'turtles' } });
    const prep = await node.prep(state, subParams({ subflowId: 'child', promptTemplate: 'Research ${var:topic}' }));
    expect(prep.inputText).toBe('Research turtles');
  });
});

describe('SubflowNode.post — captureVariable', () => {
  const okExec = (outputText: string): SubflowNodeExecResult => ({ success: true, outputText, subStatus: 'completed' });

  it('folds the child output into the PARENT run variables', async () => {
    const node = subNode();
    const state = makeState();
    const prep = await node.prep(state, subParams({ subflowId: 'child' }));
    await node.post(prep, okExec('child said hi'), state, subParams({ subflowId: 'child', captureVariable: 'childOut' }));
    expect(state.variables?.childOut).toBe('child said hi');
  });

  it('does NOT capture when the subflow failed', async () => {
    const node = subNode();
    const state = makeState();
    const prep = await node.prep(state, subParams({ subflowId: 'child' }));
    await node.post(
      prep,
      { success: false, error: 'child failed' },
      state,
      subParams({ subflowId: 'child', captureVariable: 'childOut' }),
    );
    expect(state.variables?.childOut).toBeUndefined();
  });
});
