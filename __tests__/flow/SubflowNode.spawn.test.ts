/**
 * Tests for spawn-with-brief (issue #156).
 *
 * A subflow node is a sub-agent; spawning runs N parallel instances of it, each
 * with its own brief. Briefs come from the ROUTING MODEL (one handoff tool call
 * per brief, captured into SharedState.handoffInput.tasks, gated on
 * `allowCallerFanout`) or from the AUTHOR (`spawnBriefs`). Both feed the same
 * lane engine as fan-out/map-over-list. What's pinned here:
 *   - caller tasks -> one lane per brief, all running THIS node's subflowId,
 *   - per-lane input composition (isolated: brief IS the prompt; history modes:
 *     shared transcript + brief appended as the closing user message),
 *   - author briefs run without any caller; caller tasks override them,
 *   - ${var:NAME} resolution inside briefs,
 *   - the MAX_DYNAMIC_FANOUT_LANES cap,
 *   - saveConversation honored PER LANE (defect 1) with brief-derived titles,
 *   - a caller-requested legacy parallelFlows set naming only unknown flows is
 *     a REAL error, not a silent empty success (defect 2),
 *   - graceful degradation: spawn-enabled node routed to with no tasks runs the
 *     plain single-child path.
 */

const runFlowMock = jest.fn();
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (...a: unknown[]) => runFlowMock(...a),
}));

// getFlow returns a flow for any id EXCEPT ids starting with "missing" (unknown).
const getFlowMock = jest.fn(async (id: string) =>
  id.startsWith('missing') ? null : { id, name: `flow-${id}` },
);
jest.mock('@/backend/services/flow/index', () => ({
  flowService: { getFlow: (id: string) => getFlowMock(id) },
}));

import { SubflowNode, MAX_DYNAMIC_FANOUT_LANES } from '@/backend/execution/flow/nodes/SubflowNode';
import type { SharedState, SubflowNodeParams } from '@/backend/execution/flow/types';
import { FlujoChatMessage } from '@/shared/types/chat';

function makeShared(overrides: Record<string, unknown> = {}): SharedState {
  return {
    conversationId: 'conv-1',
    flowId: 'parent-flow',
    runDepth: 0,
    messages: [],
    trackingInfo: { nodeExecutionTracker: [] },
    ...overrides,
  } as unknown as SharedState;
}

function makeParams(properties: Record<string, unknown>): SubflowNodeParams {
  return {
    id: 'sub-1',
    type: 'subflow',
    properties,
  } as unknown as SubflowNodeParams;
}

function makeNode(): SubflowNode {
  const node = new SubflowNode();
  (node as unknown as { successors: Record<string, unknown> }).successors = { NEXT: {} };
  return node;
}

function userMsg(content: string): FlujoChatMessage {
  return { id: `u-${content}`, role: 'user', content, timestamp: 1 } as FlujoChatMessage;
}

beforeEach(() => {
  runFlowMock.mockReset();
  getFlowMock.mockClear();
  runFlowMock.mockImplementation(async ({ flowId, prompt }: { flowId: string; prompt?: string }) => ({
    status: 'completed',
    outputText: `OUT_${prompt ?? flowId}`,
  }));
});

describe('SubflowNode spawn-with-brief — caller tasks (issue #156)', () => {
  it('spawns one lane per caller task, all running the node subflowId, briefs as isolated prompts', async () => {
    const node = makeNode();
    const params = makeParams({ subflowId: 'agent', allowCallerFanout: true, promptTemplate: 'DEFAULT' });
    const shared = makeShared({
      handoffInput: { targetNodeId: 'sub-1', prompt: '', tasks: ['audit security', 'check cleanliness', 'assess reuse'] },
    });
    const prep = await node.prep(shared, params);
    const exec = await node.execCore(prep);

    expect(prep.lanes?.map((l) => l.subflowId)).toEqual(['agent', 'agent', 'agent']);
    expect(prep.lanes?.map((l) => (l.input as { prompt: string }).prompt)).toEqual([
      'audit security',
      'check cleanliness',
      'assess reuse',
    ]);
    expect(runFlowMock).toHaveBeenCalledTimes(3);
    expect(exec.success).toBe(true);
    // Call-order join.
    expect(exec.outputText).toBe('OUT_audit security\n\nOUT_check cleanliness\n\nOUT_assess reuse');
  });

  it('appends each brief to the shared transcript in history inputMode', async () => {
    const node = makeNode();
    const params = makeParams({ subflowId: 'agent', allowCallerFanout: true, inputMode: 'full-history' });
    const shared = makeShared({
      messages: [userMsg('explore the code')],
      handoffInput: { targetNodeId: 'sub-1', prompt: '', tasks: ['brief A', 'brief B'] },
    });
    const prep = await node.prep(shared, params);

    expect(prep.lanes).toHaveLength(2);
    for (const [i, expected] of ['brief A', 'brief B'].entries()) {
      const msgs = (prep.lanes![i].input as { messages: FlujoChatMessage[] }).messages;
      expect(msgs[0].content).toBe('explore the code');
      expect(msgs[msgs.length - 1].role).toBe('user');
      expect(msgs[msgs.length - 1].content).toBe(expected);
    }
  });

  it('ignores caller tasks when the node did not opt into allowCallerFanout', async () => {
    const node = makeNode();
    const params = makeParams({ subflowId: 'solo' });
    const shared = makeShared({
      handoffInput: { targetNodeId: 'sub-1', prompt: '', tasks: ['a', 'b'] },
    });
    const prep = await node.prep(shared, params);
    await node.execCore(prep);

    expect(prep.lanes).toBeUndefined();
    expect(runFlowMock).toHaveBeenCalledTimes(1);
    expect(runFlowMock.mock.calls[0][0].flowId).toBe('solo');
  });

  it('degrades to a plain single-child handoff when spawn is enabled but no tasks arrive', async () => {
    const node = makeNode();
    const params = makeParams({ subflowId: 'agent', allowCallerFanout: true });
    const shared = makeShared();
    const prep = await node.prep(shared, params);
    const exec = await node.execCore(prep);

    expect(prep.lanes).toBeUndefined();
    expect(runFlowMock).toHaveBeenCalledTimes(1);
    expect(runFlowMock.mock.calls[0][0].flowId).toBe('agent');
    expect(exec.success).toBe(true);
  });

  it('caps caller tasks at MAX_DYNAMIC_FANOUT_LANES', async () => {
    const node = makeNode();
    const params = makeParams({ subflowId: 'agent', allowCallerFanout: true, promptTemplate: 'D' });
    const shared = makeShared({
      handoffInput: {
        targetNodeId: 'sub-1',
        prompt: '',
        tasks: Array.from({ length: MAX_DYNAMIC_FANOUT_LANES + 8 }, (_, i) => `t${i}`),
      },
    });
    const prep = await node.prep(shared, params);

    expect(prep.lanes).toHaveLength(MAX_DYNAMIC_FANOUT_LANES);
  });

  it('honors a caller-supplied concurrencyLimit for spawn lanes', async () => {
    const node = makeNode();
    const params = makeParams({ subflowId: 'agent', allowCallerFanout: true, promptTemplate: 'D', concurrencyLimit: 4 });
    const shared = makeShared({
      handoffInput: { targetNodeId: 'sub-1', prompt: '', tasks: ['a', 'b'], concurrencyLimit: 1 },
    });
    const prep = await node.prep(shared, params);

    expect(prep.concurrencyLimit).toBe(1);
  });

  it('drops tasks (with a plain run) when the node has no subflowId', async () => {
    const node = makeNode();
    const params = makeParams({ allowCallerFanout: true });
    const shared = makeShared({
      handoffInput: { targetNodeId: 'sub-1', prompt: '', tasks: ['a'] },
    });
    const prep = await node.prep(shared, params);
    const exec = await node.execCore(prep);

    expect(prep.lanes).toBeUndefined();
    expect(exec.success).toBe(false); // "no flow selected" — never a silent success
    expect(runFlowMock).not.toHaveBeenCalled();
  });
});

describe('SubflowNode spawn-with-brief — author briefs (spawnBriefs)', () => {
  it('spawns one lane per authored brief with no caller involved', async () => {
    const node = makeNode();
    const params = makeParams({ subflowId: 'agent', promptTemplate: 'D', spawnBriefs: ['w1', 'w2', 'w3'] });
    const shared = makeShared();
    const prep = await node.prep(shared, params);
    const exec = await node.execCore(prep);

    expect(prep.lanes?.map((l) => (l.input as { prompt: string }).prompt)).toEqual(['w1', 'w2', 'w3']);
    expect(runFlowMock).toHaveBeenCalledTimes(3);
    expect(exec.success).toBe(true);
  });

  it('caller tasks OVERRIDE the authored brief list', async () => {
    const node = makeNode();
    const params = makeParams({
      subflowId: 'agent',
      promptTemplate: 'D',
      allowCallerFanout: true,
      spawnBriefs: ['author1', 'author2'],
    });
    const shared = makeShared({
      handoffInput: { targetNodeId: 'sub-1', prompt: '', tasks: ['caller1'] },
    });
    const prep = await node.prep(shared, params);

    expect(prep.lanes?.map((l) => (l.input as { prompt: string }).prompt)).toEqual(['caller1']);
  });

  it('resolves ${var:NAME} inside briefs like a promptTemplate', async () => {
    const node = makeNode();
    const params = makeParams({ subflowId: 'agent', promptTemplate: 'D', spawnBriefs: ['audit ${var:TOPIC}'] });
    const shared = makeShared({ variables: { TOPIC: 'security' } });
    const prep = await node.prep(shared, params);

    expect((prep.lanes![0].input as { prompt: string }).prompt).toBe('audit security');
  });

  it('spawn briefs win over a (misconfigured) static parallel list', async () => {
    const node = makeNode();
    const params = makeParams({
      subflowId: 'agent',
      promptTemplate: 'D',
      spawnBriefs: ['b1'],
      parallelSubflowIds: ['other1', 'other2'],
    });
    const shared = makeShared();
    const prep = await node.prep(shared, params);

    expect(prep.lanes?.map((l) => l.subflowId)).toEqual(['agent']);
  });
});

describe('SubflowNode lane persistence (issue #156 defect 1)', () => {
  it('runs lanes in conversation mode with brief-derived titles when saveConversation is on (default)', async () => {
    const node = makeNode();
    const params = makeParams({ subflowId: 'agent', promptTemplate: 'D', spawnBriefs: ['inspect the parser'] });
    const shared = makeShared();
    const prep = await node.prep(shared, params);
    await node.execCore(prep);

    expect(runFlowMock).toHaveBeenCalledTimes(1);
    const call = runFlowMock.mock.calls[0][0];
    expect(call.mode).toBe('conversation');
    expect(call.title).toBe('inspect the parser');
    expect(call.parentRunId).toBe('conv-1');
  });

  it('keeps lanes ephemeral when saveConversation is explicitly false', async () => {
    const node = makeNode();
    const params = makeParams({
      subflowId: 'agent',
      promptTemplate: 'D',
      spawnBriefs: ['b1'],
      saveConversation: false,
    });
    const shared = makeShared();
    const prep = await node.prep(shared, params);
    await node.execCore(prep);

    const call = runFlowMock.mock.calls[0][0];
    expect(call.mode).toBe('ephemeral');
    expect(call.title).toBeUndefined();
  });

  it('applies persistence to map-over-list lanes too', async () => {
    const node = makeNode();
    const params = makeParams({
      subflowId: 'agent',
      promptTemplate: '["item one","item two"]',
      mapOverList: true,
    });
    const shared = makeShared();
    const prep = await node.prep(shared, params);
    await node.execCore(prep);

    expect(runFlowMock).toHaveBeenCalledTimes(2);
    for (const [i, expected] of ['item one', 'item two'].entries()) {
      expect(runFlowMock.mock.calls[i][0].mode).toBe('conversation');
      expect(runFlowMock.mock.calls[i][0].title).toBe(expected);
    }
  });
});

describe('SubflowNode caller fan-out resolving empty is an error (issue #156 defect 2)', () => {
  it('fails loudly when EVERY caller-requested legacy parallelFlows id is unknown', async () => {
    const node = makeNode();
    const params = makeParams({ subflowId: 'agent', promptTemplate: 'D', allowCallerFanout: true });
    const shared = makeShared({
      handoffInput: {
        targetNodeId: 'sub-1',
        prompt: '',
        parallelFlows: ['missing-security-audit', 'missing-cleanliness'],
      },
    });
    const prep = await node.prep(shared, params);
    const exec = await node.execCore(prep);

    expect(prep.laneResolutionError).toContain('missing-security-audit');
    expect(exec.success).toBe(false);
    expect(exec.error).toContain('None of the requested parallel flows exist');
    expect(runFlowMock).not.toHaveBeenCalled();
  });

  it('keeps the clean-empty fold for a VAR-driven fan-out that resolves to nothing (unchanged semantics)', async () => {
    const node = makeNode();
    const params = makeParams({ subflowId: 'solo', promptTemplate: 'D', parallelSubflowIdsVar: 'TARGETS' });
    const shared = makeShared({ variables: { TARGETS: '["missing-1"]' } });
    const prep = await node.prep(shared, params);
    const exec = await node.execCore(prep);

    expect(prep.fanOutResolvedEmpty).toBe(true);
    expect(exec.success).toBe(true);
    expect(exec.outputText).toBe('');
    expect(runFlowMock).not.toHaveBeenCalled();
  });
});
