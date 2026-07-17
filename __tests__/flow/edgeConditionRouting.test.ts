/**
 * Tier 2b — deterministic conditions on edges (data-driven routing).
 *
 * Two layers are covered here:
 *   1. FlowConverter retains `edge.data.condition` into the source ProcessNode's
 *      node_params (edgeConditions keyed by edge id + orderedOutgoingEdges in
 *      author order) — the plumbing that carries the predicate into the runtime
 *      graph (it is dropped everywhere else).
 *   2. ProcessNode.post routes on it: first matching outgoing edge wins, a bare
 *      edge is the fallback, and a model handoff tool call still wins over any
 *      condition. A node with NO conditioned edge is byte-for-byte unchanged.
 */
import { FlowConverter } from '@/backend/execution/flow/FlowConverter';
import { ProcessNode, FinishNode } from '@/backend/execution/flow/nodes';
import { FINAL_RESPONSE_ACTION } from '@/backend/execution/flow/types';
import type {
  SharedState,
  ProcessNodePrepResult,
  ProcessNodeExecResult,
  ProcessNodeParams,
} from '@/backend/execution/flow/types';
import type { Flow as ReactFlow } from '@/shared/types/flow';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { EdgeCondition } from '@/utils/shared/edgeConditions';

// ---------------------------------------------------------------------------
// FlowConverter: condition retention into node_params
// ---------------------------------------------------------------------------

/** Collect every pocketflow node reachable from start, by id, WITHOUT cloning
 *  (so we read the exact node_params the converter mutated). */
async function nodesById(flow: any): Promise<Map<string, any>> {
  const start = await flow.getStartNode();
  const byId = new Map<string, any>();
  const queue: any[] = [start];
  while (queue.length) {
    const n = queue.shift();
    const id = n?.node_params?.id;
    if (id && byId.has(id)) continue;
    if (id) byId.set(id, n);
    if (n?.successors instanceof Map) for (const s of n.successors.values()) queue.push(s);
  }
  return byId;
}

const FAIL_COND: EdgeCondition = { kind: 'contains', value: 'FAIL' };

function conditionedFlow(): ReactFlow {
  return {
    id: 'flow-1',
    name: 'Conditioned',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'start', properties: {} } },
      { id: 'proc', type: 'process', position: { x: 0, y: 1 }, data: { label: 'P', type: 'process', properties: {} } },
      { id: 'fix', type: 'process', position: { x: 0, y: 2 }, data: { label: 'Fix', type: 'process', properties: {} } },
      { id: 'pub', type: 'finish', position: { x: 0, y: 3 }, data: { label: 'Publish', type: 'finish', properties: {} } },
    ],
    edges: [
      { id: 'e-start', source: 'start', target: 'proc', data: { edgeType: 'standard' } },
      { id: 'e-fix', source: 'proc', target: 'fix', data: { edgeType: 'standard', condition: FAIL_COND } },
      { id: 'e-pub', source: 'proc', target: 'pub', data: { edgeType: 'standard' } },
    ],
  } as unknown as ReactFlow;
}

describe('FlowConverter — retains edge conditions into node_params', () => {
  it('records edgeConditions keyed by edge id and orderedOutgoingEdges in author order', async () => {
    const flow = FlowConverter.convert(conditionedFlow());
    const byId = await nodesById(flow);
    const proc = byId.get('proc');

    expect(proc.node_params.edgeConditions).toEqual({ 'e-fix': FAIL_COND });
    // Author order of the process node's outgoing control edges.
    expect(proc.node_params.orderedOutgoingEdges).toEqual(['e-fix', 'e-pub']);
  });

  it('leaves an all-bare node with no edgeConditions map', async () => {
    const flow = FlowConverter.convert(conditionedFlow());
    const byId = await nodesById(flow);
    const start = byId.get('start');
    expect(start.node_params.edgeConditions).toBeUndefined();
    expect(start.node_params.orderedOutgoingEdges).toEqual(['e-start']);
  });
});

// ---------------------------------------------------------------------------
// ProcessNode.post: deterministic routing
// ---------------------------------------------------------------------------

const makeState = (): SharedState =>
  ({
    trackingInfo: { executionId: 'e1', startTime: 1, nodeExecutionTracker: [] },
    messages: [],
    flowId: 'flow-1',
    conversationId: 'conv-1',
    title: 't',
    createdAt: 1,
    updatedAt: 1,
  } as SharedState);

const msg = (role: FlujoChatMessage['role'], content: string, id: string): FlujoChatMessage =>
  ({ role, content, id, timestamp: 1 } as FlujoChatMessage);

const prep: ProcessNodePrepResult = {
  nodeId: 'proc',
  nodeType: 'process',
  currentPrompt: 'x',
  boundModel: 'm',
  messages: [],
};

function execWith(assistant: string, toolCalls?: any[]): ProcessNodeExecResult {
  return {
    success: true,
    content: assistant,
    messages: [msg('user', 'go', 'u1'), msg('assistant', assistant, 'a1')],
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function finishTarget(id: string): FinishNode {
  const n = new FinishNode();
  n.setParams({}, { id, label: id, type: 'finish', properties: {} });
  return n;
}

/** A conditioned process node: e-fix (contains FAIL) then e-pub (bare). */
function conditionedProcess(opts?: { bare?: boolean }): {
  node: ProcessNode;
  params: ProcessNodeParams;
} {
  const node = new ProcessNode();
  node.addSuccessor(finishTarget('fix'), 'e-fix');
  if (opts?.bare !== false) node.addSuccessor(finishTarget('pub'), 'e-pub');
  const params: ProcessNodeParams = {
    id: 'proc',
    label: 'P',
    type: 'process',
    properties: {},
    edgeConditions: { 'e-fix': FAIL_COND },
    orderedOutgoingEdges: opts?.bare === false ? ['e-fix'] : ['e-fix', 'e-pub'],
  };
  return { node, params };
}

describe('ProcessNode.post — deterministic conditioned routing', () => {
  it('routes to the first matching conditioned edge (no model tool call needed)', async () => {
    const { node, params } = conditionedProcess();
    const state = makeState();
    const action = await node.post(prep, execWith('tests FAIL: 2 broken'), state, params);
    expect(action).toBe('e-fix');
  });

  it('falls back to the bare edge when no predicate matches', async () => {
    const { node, params } = conditionedProcess();
    const state = makeState();
    const action = await node.post(prep, execWith('all tests PASS'), state, params);
    expect(action).toBe('e-pub');
  });

  it('terminates (FINAL_RESPONSE) when no predicate matches and there is no bare edge', async () => {
    const { node, params } = conditionedProcess({ bare: false });
    const state = makeState();
    const action = await node.post(prep, execWith('all tests PASS'), state, params);
    expect(action).toBe(FINAL_RESPONSE_ACTION);
  });

  it('takes conditioned edges in author order (first match wins)', async () => {
    const node = new ProcessNode();
    node.addSuccessor(finishTarget('a'), 'e-a');
    node.addSuccessor(finishTarget('b'), 'e-b');
    const params: ProcessNodeParams = {
      id: 'proc',
      label: 'P',
      type: 'process',
      properties: {},
      // Both predicates would match "done"; author order must pick e-a.
      edgeConditions: {
        'e-a': { kind: 'contains', value: 'done' },
        'e-b': { kind: 'contains', value: 'done' },
      },
      orderedOutgoingEdges: ['e-a', 'e-b'],
    };
    const action = await node.post(prep, execWith('done'), makeState(), params);
    expect(action).toBe('e-a');
  });

  it('a model handoff tool call still wins over any condition', async () => {
    const { node, params } = conditionedProcess();
    // Add the handoff target the tool call resolves to.
    node.addSuccessor(finishTarget('handoff-target'), 'e-handoff');
    const state = makeState();
    // Last message WOULD match e-fix (contains FAIL), but the model also called
    // a handoff tool → the handoff edge must win.
    const exec = execWith('tests FAIL', [
      { name: 'handoff_to_handoff-target', args: {}, id: 'tc1', result: '' },
    ]);
    const action = await node.post(prep, exec, state, params);
    expect(action).toBe('e-handoff');
    expect(state.handoffRequested?.edgeId).toBe('e-handoff');
  });

  it('honors the last-message target (e.g. a tool result), not just the assistant text', async () => {
    const { node, params } = conditionedProcess();
    params.edgeConditions = { 'e-fix': { kind: 'contains', value: 'FAIL', target: 'last-message' } };
    const state = makeState();
    const exec: ProcessNodeExecResult = {
      success: true,
      content: 'ok',
      messages: [msg('assistant', 'ran the tests', 'a1'), msg('tool', 'result: FAIL', 't1')],
    };
    const action = await node.post(prep, exec, state, params);
    expect(action).toBe('e-fix');
  });
});

describe('ProcessNode.post — regression: no conditioned edges = unchanged', () => {
  it('a node with only bare edges terminates on plain text (model-decided handoff only)', async () => {
    const node = new ProcessNode();
    node.addSuccessor(finishTarget('next'), 'e-next');
    const params: ProcessNodeParams = {
      id: 'proc',
      label: 'P',
      type: 'process',
      properties: {},
      // No edgeConditions → the Tier 2b block is gated OFF entirely.
      orderedOutgoingEdges: ['e-next'],
    };
    const action = await node.post(prep, execWith('here is my answer'), makeState(), params);
    expect(action).toBe(FINAL_RESPONSE_ACTION);
  });
});

describe('ProcessNode.post — always condition (issue #111)', () => {
  const ALWAYS: EdgeCondition = { kind: 'always' };

  function alwaysProcess(): { node: ProcessNode; params: ProcessNodeParams } {
    const node = new ProcessNode();
    node.addSuccessor(finishTarget('next'), 'e-next');
    const params: ProcessNodeParams = {
      id: 'proc',
      label: 'P',
      type: 'process',
      properties: {},
      edgeConditions: { 'e-next': ALWAYS },
      orderedOutgoingEdges: ['e-next'],
    };
    return { node, params };
  }

  it('routes to the always edge on a plain-text reply instead of terminating', async () => {
    const { node, params } = alwaysProcess();
    const action = await node.post(prep, execWith('here is my plain answer'), makeState(), params);
    expect(action).toBe('e-next');
  });

  it('a model handoff tool call still wins over an always edge', async () => {
    const { node, params } = alwaysProcess();
    node.addSuccessor(finishTarget('handoff-target'), 'e-handoff');
    const state = makeState();
    const exec = execWith('plain answer', [
      { name: 'handoff_to_handoff-target', args: {}, id: 'tc1', result: '' },
    ]);
    const action = await node.post(prep, exec, state, params);
    expect(action).toBe('e-handoff');
  });
});
