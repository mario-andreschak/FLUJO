/**
 * A flow can wait for a person, with no model and no tool involved.
 *
 * The cases execute real graph conversion, nodes, runFlow, the approval decision and
 * saved state. No model is called, and the MCP layer is replaced only so that what
 * reaches callTool can be counted. A wait must hold across a restart, which is why
 * the state is also reloaded from storage, the way a fresh process would find it.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { ExecutionEvent } from '@/shared/types/execution/events';

const callToolMock = jest.fn();
jest.mock('@/backend/services/mcp', () => {
  const known: Record<string, unknown> = {
    callTool: (...args: unknown[]) => callToolMock(...args),
    loadServerConfigs: async () => [{ name: 'srv' }],
    setNodeRoots: () => undefined,
  };
  return { mcpService: new Proxy(known, { get: (target, name: string) => target[name] ?? (async () => ({})) }) };
});
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: async () => null, loadFlows: async () => [] },
}));
jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: async () => ({ isRunnable: true, issues: [] }),
  validateFlowObjectForRun: async () => ({ isRunnable: true, issues: [] }),
}));

import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';
import { runFlow } from '@/backend/execution/flow/runFlow';
import type { SharedState, StaticEntry } from '@/backend/execution/flow/types';
import { StorageKey } from '@/shared/types/storage';
import { flowRequiresStepApproval, HUMAN_GATE_TOOL_NAME } from '@/utils/shared/flowApproval';
import { compileFlowSpec, flowToSpec } from '@/utils/shared/flowSpecCompiler';
import { validateFlow } from '@/utils/shared/flowValidation';
import { loadItem, saveItem } from '@/utils/storage/backend';

jest.setTimeout(30_000);

const AFTER = 'The rest of the flow ran.';

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}

/** Start -> a Static node holding `entries` -> a Static node that proves it ran -> Finish. */
function flowWith(id: string, entries: StaticEntry[], decideProperties: Record<string, unknown> = {}): Flow {
  return {
    id,
    name: id,
    nodes: [
      node('start', 'start'),
      node('decide', 'static', { entries, ...decideProperties }),
      node('after', 'static', { outputTemplate: AFTER }),
      node('end', 'finish'),
      node('tools', 'mcp', { boundServer: 'srv', enabledTools: ['send_it'] }),
    ],
    edges: [
      { id: 'to-decide', source: 'start', target: 'decide', data: { edgeType: 'standard' } },
      { id: 'to-after', source: 'decide', target: 'after', data: { edgeType: 'standard' } },
      { id: 'to-end', source: 'after', target: 'end', data: { edgeType: 'standard' } },
      { id: 'to-tools', source: 'decide', target: 'tools', data: { edgeType: 'mcp' } },
    ],
  } as unknown as Flow;
}

const gate = (extra: Partial<Extract<StaticEntry, { kind: 'humanGate' }>> = {}): StaticEntry =>
  ({ kind: 'humanGate', text: 'Send the reminder?', ...extra });
const realCall = (extra: Record<string, unknown> = {}): StaticEntry => ({
  kind: 'toolCall',
  executionMode: 'real',
  serverName: 'srv',
  toolName: 'send_it',
  argumentsJson: '{"to":"${var:who}"}',
  result: '',
  requireApproval: true,
  ...extra,
} as StaticEntry);

describe('waiting for a person', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.FLUJO_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-human-gate-'));
    process.env.FLUJO_DATA_DIR = dataDir;
    await fs.mkdir(path.join(dataDir, 'workspaces', 'default-workspace', 'db'), { recursive: true });
    callToolMock.mockReset().mockResolvedValue({ success: true, data: { content: [{ type: 'text', text: 'sent' }] } });
    FlowExecutor.clearFlowCache();
    FlowExecutor.conversationStates.clear();
  });

  afterEach(async () => {
    FlowExecutor.conversationStates.clear();
    if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  });

  const start = (conversationId: string, definition: Flow, extra: Record<string, unknown> = {}) => runFlow({
    conversationId,
    flowDefinition: definition,
    prompt: 'Go.',
    source: 'api',
    mode: 'conversation',
    flujo: true,
    userTurn: true,
    ...extra,
  });
  const resume = (conversationId: string) => runFlow({ conversationId, source: 'api', mode: 'conversation', flujo: true });
  const stateOf = (conversationId: string) => FlowExecutor.conversationStates.get(conversationId)!;
  const decide = (conversationId: string, action: 'approve' | 'reject') => {
    const state = stateOf(conversationId);
    return applyApprovalDecision(state, state.pendingToolCalls![0].id, action);
  };
  const srvCalls = () => callToolMock.mock.calls.filter((call) => call[0] === 'srv');

  describe('a wait with no tool', () => {
    it('stops before anything after it, and says what to decide', async () => {
      const result = await start('gate-stop', flowWith('gate-stop', [gate()]));

      expect(result.status).toBe('awaiting_tool_approval');
      expect(result.outputText).not.toBe(AFTER);
      expect(result.pendingToolCalls).toHaveLength(1);
      expect(result.pendingToolCalls![0].function.name).toBe(HUMAN_GATE_TOOL_NAME);
      expect(JSON.parse(result.pendingToolCalls![0].function.arguments)).toEqual({ text: 'Send the reminder?' });
    });

    it('tells listeners, the same way a tool approval does', async () => {
      const events: ExecutionEvent[] = [];
      await start('gate-event', flowWith('gate-event', [gate()]), { emit: (event: ExecutionEvent) => { events.push(event); } });

      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run:awaiting_approval' })]));
    });

    it('continues after an approval, and the history stays well-formed', async () => {
      const conversationId = 'gate-approve';
      await start(conversationId, flowWith(conversationId, [gate()]));

      expect((await decide(conversationId, 'approve')).outcome).toBe('ready');
      const done = await resume(conversationId);

      expect(done.status).toBe('completed');
      expect(done.outputText).toBe(AFTER);
      const messages = stateOf(conversationId).messages as Array<{ role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>;
      const call = messages.find((message) => message.tool_calls?.length)!;
      const answers = messages.filter((message) => message.tool_call_id === call.tool_calls![0].id);
      expect(answers).toHaveLength(1);
      expect(answers[0].content).toBe('approved');
    });

    it('stops the run after a rejection and does not run the rest', async () => {
      const conversationId = 'gate-reject';
      await start(conversationId, flowWith(conversationId, [gate()]));

      await decide(conversationId, 'reject');
      const done = await resume(conversationId);

      expect(done.status).toBe('completed');
      expect(done.outputText).toBe('Not approved.');
    });

    it('uses the flow\'s own text for a rejection', async () => {
      const conversationId = 'gate-reject-text';
      await start(conversationId, flowWith(conversationId, [gate({ rejectedText: 'Left as it is.' })]));

      await decide(conversationId, 'reject');

      expect((await resume(conversationId)).outputText).toBe('Left as it is.');
    });

    it('lets a flow route on the decision', async () => {
      const definition = flowWith('gate-route', [gate({ onReject: 'continue' })]);
      (definition.nodes as FlowNode[]).push(node('other', 'static', { outputTemplate: 'Took the other way.' }));
      definition.edges = [
        ...definition.edges.filter((edge) => edge.id !== 'to-after'),
        { id: 'if-approved', source: 'decide', target: 'after', data: { edgeType: 'standard', condition: { kind: 'equals', value: 'approved' } } },
        { id: 'otherwise', source: 'decide', target: 'other', data: { edgeType: 'standard' } },
        { id: 'other-end', source: 'other', target: 'end', data: { edgeType: 'standard' } },
      ] as Flow['edges'];

      await start('gate-route-yes', { ...definition, id: 'gate-route-yes' });
      await decide('gate-route-yes', 'approve');
      expect((await resume('gate-route-yes')).outputText).toBe(AFTER);

      await start('gate-route-no', { ...definition, id: 'gate-route-no' });
      await decide('gate-route-no', 'reject');
      expect((await resume('gate-route-no')).outputText).toBe('Took the other way.');
    });

    it('keeps what came before it and does not inject it twice', async () => {
      const conversationId = 'gate-before';
      const before: StaticEntry = { kind: 'message', role: 'assistant', content: 'Prepared the text.' };
      await start(conversationId, flowWith(conversationId, [before, gate()]));

      await decide(conversationId, 'approve');
      await resume(conversationId);

      const copies = stateOf(conversationId).messages.filter((message) => message.content === 'Prepared the text.');
      expect(copies).toHaveLength(1);
    });

    it('handles more than one wait in a node', async () => {
      const conversationId = 'gate-two';
      await start(conversationId, flowWith(conversationId, [gate({ text: 'First?' }), gate({ text: 'Second?' })]));
      expect(JSON.parse(stateOf(conversationId).pendingToolCalls![0].function.arguments).text).toBe('First?');

      await decide(conversationId, 'approve');
      const second = await resume(conversationId);
      expect(second.status).toBe('awaiting_tool_approval');
      expect(JSON.parse(second.pendingToolCalls![0].function.arguments).text).toBe('Second?');

      await decide(conversationId, 'approve');
      expect((await resume(conversationId)).outputText).toBe(AFTER);
    });

    it('survives a restart', async () => {
      const conversationId = 'gate-restart';
      await start(conversationId, flowWith(conversationId, [gate()]));

      // A new process finds only what was saved.
      FlowExecutor.conversationStates.clear();
      FlowExecutor.clearFlowCache();
      const saved = await loadItem<SharedState | undefined>(`conversations/${conversationId}` as StorageKey, undefined);
      expect(saved?.status).toBe('awaiting_tool_approval');
      expect(saved?.pendingToolCalls).toHaveLength(1);

      const decision = await applyApprovalDecision(saved!, saved!.pendingToolCalls![0].id, 'approve');
      expect(decision.outcome).toBe('ready');
      await saveItem(`conversations/${conversationId}` as StorageKey, saved);

      const done = await resume(conversationId);
      expect(done.status).toBe('completed');
      expect(done.outputText).toBe(AFTER);
    });

    it('picks up a decision that was saved just before a crash', async () => {
      const conversationId = 'gate-crash';
      await start(conversationId, flowWith(conversationId, [gate()]));
      await decide(conversationId, 'approve');
      const decided = stateOf(conversationId);
      await saveItem(`conversations/${conversationId}` as StorageKey, decided);

      FlowExecutor.conversationStates.clear();
      FlowExecutor.clearFlowCache();
      const done = await resume(conversationId);

      expect(done.status).toBe('completed');
      expect(done.outputText).toBe(AFTER);
      const answers = stateOf(conversationId).messages.filter((message) => message.role === 'tool');
      expect(answers.map((message) => message.content)).toEqual(['approved']);
    });

    it('asks again when a new message arrives during a wait, with a well-formed history', async () => {
      const conversationId = 'gate-new-message';
      const definition = flowWith(conversationId, [gate()]);
      await start(conversationId, definition);

      const again = await start(conversationId, definition, {
        prompt: undefined,
        messages: [...stateOf(conversationId).messages, { role: 'user', content: 'One more thing.' }],
      });

      expect(again.status).toBe('awaiting_tool_approval');
      const messages = stateOf(conversationId).messages as Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>;
      const answered = new Set(messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id));
      const unanswered = messages.flatMap((message) => message.tool_calls ?? []).filter((call) => !answered.has(call.id));
      expect(unanswered.map((call) => call.id)).toEqual(again.pendingToolCalls!.map((call) => call.id));

      await decide(conversationId, 'approve');
      expect((await resume(conversationId)).outputText).toBe(AFTER);
    });

    it('fails rather than continuing when nobody can answer', async () => {
      const failing = await start('gate-fail', flowWith('gate-fail', [gate()]), { onApprovalRequired: 'fail' });
      expect(failing.status).toBe('error');
      expect(failing.error?.details).toMatchObject({ type: 'approval_required' });
      expect(failing.outputText).not.toBe(AFTER);

      const transient = await start('gate-transient', flowWith('gate-transient', [gate()]), { mode: 'ephemeral' });
      expect(transient.status).toBe('error');
      expect(transient.error?.details).toMatchObject({ type: 'approval_required' });
    });

    it('fails on a wait with no text instead of asking nothing', async () => {
      const result = await start('gate-empty', flowWith('gate-empty', [gate({ text: '   ' })]));

      expect(result.status).toBe('error');
      expect(result.outputText).not.toBe(AFTER);
    });
  });

  describe('before a real tool call', () => {
    const withPerson = (conversationId: string, entry: StaticEntry) => start(conversationId, flowWith(conversationId, [entry]), { variables: { who: 'Ben' } });

    it('does not run until someone decides, and shows the real arguments', async () => {
      const result = await withPerson('call-wait', realCall());

      expect(result.status).toBe('awaiting_tool_approval');
      expect(srvCalls()).toHaveLength(0);
      expect(JSON.parse(result.pendingToolCalls![0].function.arguments)).toEqual({ to: 'Ben' });
    });

    it('runs once after an approval, with exactly the arguments the person saw', async () => {
      const conversationId = 'call-approve';
      await withPerson(conversationId, realCall());

      // Something changes while the run waits. The approved call must not follow it.
      stateOf(conversationId).variables = { who: 'Someone else' };
      await decide(conversationId, 'approve');
      const done = await resume(conversationId);

      expect(done.status).toBe('completed');
      expect(done.outputText).toBe(AFTER);
      expect(srvCalls()).toHaveLength(1);
      expect(srvCalls()[0].slice(1, 3)).toEqual(['send_it', { to: 'Ben' }]);
    });

    it('still captures the result into a run variable after an approval', async () => {
      const conversationId = 'call-capture';
      await withPerson(conversationId, realCall({ captureVariable: 'sent' }));

      await decide(conversationId, 'approve');
      await resume(conversationId);

      expect(stateOf(conversationId).variables?.sent).toContain('sent');
    });

    it('does not run after a rejection', async () => {
      const conversationId = 'call-reject';
      await withPerson(conversationId, realCall());

      await decide(conversationId, 'reject');
      const done = await resume(conversationId);

      expect(done.outputText).toBe('Not approved.');
      expect(srvCalls()).toHaveLength(0);
    });

    it('goes on without the call when the flow says so', async () => {
      const conversationId = 'call-reject-continue';
      await withPerson(conversationId, realCall({ onReject: 'continue' }));

      await decide(conversationId, 'reject');
      const done = await resume(conversationId);

      expect(done.outputText).toBe(AFTER);
      expect(srvCalls()).toHaveLength(0);
    });

    it('runs at once without the setting, as before', async () => {
      const result = await withPerson('call-none', realCall({ requireApproval: undefined }));

      expect(result.status).toBe('completed');
      expect(srvCalls()).toHaveLength(1);
    });

    it('refuses the setting on a mock call, which has nothing to approve', async () => {
      const result = await withPerson('call-mock', realCall({ executionMode: 'mock', result: 'pretend' }));

      expect(result.status).toBe('error');
      expect(srvCalls()).toHaveLength(0);
    });
  });
});

describe('authoring', () => {
  const context = { models: [], servers: [{ name: 'srv' }], serverTools: { srv: ['send_it'] } };
  const spec = (entries: unknown[]) => ({
    name: 'Wait',
    nodes: [{ key: 'start', type: 'start' }, { key: 'decide', type: 'static', entries }, { key: 'finish', type: 'finish' }],
    edges: [{ from: 'start', to: 'decide' }, { from: 'decide', to: 'finish' }],
  });
  const entriesOf = (compiled: ReturnType<typeof compileFlowSpec>) =>
    compiled.flow!.nodes.find((candidate) => candidate.type === 'static')!.data.properties?.entries;
  const codes = (compiled: ReturnType<typeof compileFlowSpec>) => compiled.issues.map((issue) => issue.code);

  it('carries a wait through the compiler and back', () => {
    const entry = { kind: 'humanGate', text: 'Send?', onReject: 'continue', rejectedText: 'No.' };
    const compiled = compileFlowSpec(spec([entry]) as never, context as never);

    expect(entriesOf(compiled)).toEqual([entry]);
    expect(flowToSpec(compiled.flow!).nodes?.find((candidate) => candidate.type === 'static')?.entries).toEqual([entry]);
  });

  it('carries the setting on a real call', () => {
    const compiled = compileFlowSpec(spec([{
      kind: 'toolCall', executionMode: 'real', serverName: 'srv', toolName: 'send_it', argumentsJson: '{}', result: '', requireApproval: true,
    }]) as never, context as never);

    expect(entriesOf(compiled)).toEqual([expect.objectContaining({ requireApproval: true })]);
  });

  it.each([
    ['a wait with no text', { kind: 'humanGate', text: ' ' }, 'static-human-gate-text'],
    ['a wait with an unknown rejection rule', { kind: 'humanGate', text: 'Send?', onReject: 'maybe' }, 'static-invalid-onreject'],
    ['the setting on a mock call', { kind: 'toolCall', toolName: 'send_it', argumentsJson: '{}', result: '', requireApproval: true }, 'static-mock-require-approval'],
    ['the setting on a real call with no server', { kind: 'toolCall', executionMode: 'real', toolName: 'send_it', argumentsJson: '{}', result: '', requireApproval: true }, 'static-mock-require-approval'],
    ['a malformed setting', { kind: 'toolCall', executionMode: 'real', serverName: 'srv', toolName: 'send_it', argumentsJson: '{}', result: '', requireApproval: 'yes' }, 'static-invalid-require-approval'],
  ])('stops the compile on %s instead of running without the person', (_label, entry, code) => {
    const compiled = compileFlowSpec(spec([entry]) as never, context as never);

    expect(codes(compiled)).toContain(code);
    expect(compiled.errorCount).toBeGreaterThan(0);
  });

  it('reports a broken wait in flow validation', () => {
    const noText = flowWith('invalid', [gate({ text: ' ' })]);
    const mockCall = flowWith('invalid-call', [realCall({ executionMode: 'mock' })]);

    expect(validateFlow(noText as never).issues.map((issue) => issue.code)).toContain('static-human-gate-text');
    expect(validateFlow(mockCall as never).issues.map((issue) => issue.code)).toContain('static-mock-require-approval');
  });

  it('counts both forms as requiring a person, so automations save such a run', () => {
    expect(flowRequiresStepApproval(flowWith('a', [gate()]))).toBe(true);
    expect(flowRequiresStepApproval(flowWith('b', [realCall()]))).toBe(true);
    expect(flowRequiresStepApproval(flowWith('c', [realCall({ requireApproval: undefined })]))).toBe(false);
  });
});
