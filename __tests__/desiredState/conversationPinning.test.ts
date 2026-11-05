/**
 * What happens to a conversation resting on a person's decision when its flow changes
 * underneath it. Real flow storage, real nodes, runFlow, the approval decision and saved
 * state, on flows that need no model. Only the MCP layer is replaced, because no server
 * is involved in these flows.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.mock('@/backend/services/mcp', () => {
  const known: Record<string, unknown> = {
    loadServerConfigs: async () => [],
    setNodeRoots: () => undefined,
  };
  return { mcpService: new Proxy(known, { get: (target, name: string) => target[name] ?? (async () => ({})) }) };
});
jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: async () => ({ isRunnable: true, issues: [] }),
  validateFlowObjectForRun: async () => ({ isRunnable: true, issues: [] }),
}));

import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';
import { runFlow } from '@/backend/execution/flow/runFlow';
import type { SharedState } from '@/backend/execution/flow/types';
import { applyDesiredState, rollbackDesiredState } from '@/backend/services/desiredState';
import { flowService } from '@/backend/services/flow';
import { StorageKey } from '@/shared/types/storage';
import { loadItem, saveItem } from '@/utils/storage/backend';

jest.setTimeout(60_000);

function childSpec(output: string) {
  return {
    name: 'child_step',
    nodes: [
      { key: 'start', type: 'start', label: 'Start' },
      { key: 'answer', type: 'static', label: 'Answer', outputTemplate: output },
      { key: 'end', type: 'finish', label: 'Finish' },
    ],
    edges: [{ from: 'start', to: 'answer' }, { from: 'answer', to: 'end' }],
  };
}

function parentSpec(question: string, callChild = true) {
  return {
    name: 'parent_flow',
    nodes: [
      { key: 'start', type: 'start', label: 'Start' },
      { key: 'ask', type: 'static', label: 'Ask', entries: [{ kind: 'humanGate', text: question }] },
      ...(callChild
        ? [{ key: 'call', type: 'subflow', label: 'Call', flow: 'child_step' }]
        : [{ key: 'direct', type: 'static', label: 'Direct', outputTemplate: 'no subflow any more' }]),
      { key: 'end', type: 'finish', label: 'Finish' },
    ],
    edges: callChild
      ? [{ from: 'start', to: 'ask' }, { from: 'ask', to: 'call' }, { from: 'call', to: 'end' }]
      : [{ from: 'start', to: 'ask' }, { from: 'ask', to: 'direct' }, { from: 'direct', to: 'end' }],
  };
}

function file(version: string, question: string, childOutput: string | null, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    version,
    flows: [
      ...(childOutput === null ? [] : [{ id: 'child', spec: childSpec(childOutput) }]),
      { id: 'parent', spec: parentSpec(question, childOutput !== null), ...extra },
    ],
  };
}

describe('a conversation when its flow changes underneath it', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.FLUJO_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-desired-pinning-'));
    process.env.FLUJO_DATA_DIR = dataDir;
    await fs.mkdir(path.join(dataDir, 'workspaces', 'default-workspace', 'db'), { recursive: true });
    global.__flujo_flowsCache = null;
    FlowExecutor.clearFlowCache();
    FlowExecutor.conversationStates.clear();
  });

  afterEach(async () => {
    FlowExecutor.conversationStates.clear();
    global.__flujo_flowsCache = null;
    if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  });

  const apply = async (state: unknown) => {
    const report = await applyDesiredState(state, { reconcileRuntime: false });
    if (report.outcome !== 'applied') throw new Error(JSON.stringify(report));
  };
  const start = (conversationId: string, flowId = 'parent') => runFlow({
    conversationId, flowId, prompt: 'Go.', source: 'api', mode: 'conversation', flujo: true, userTurn: true,
  });
  const resume = (conversationId: string) => runFlow({ conversationId, source: 'api', mode: 'conversation', flujo: true });
  const approve = (conversationId: string) => {
    const state = FlowExecutor.conversationStates.get(conversationId)!;
    return applyApprovalDecision(state, state.pendingToolCalls![0].id, 'approve');
  };
  const gateText = (result: Awaited<ReturnType<typeof start>>) => (
    JSON.parse(result.pendingToolCalls![0].function.arguments).text as string
  );
  /** Finish a resting conversation and return everything it said. */
  const finish = async (conversationId: string) => {
    await approve(conversationId);
    const done = await resume(conversationId);
    expect(done.status).toBe('completed');
    return JSON.stringify(FlowExecutor.conversationStates.get(conversationId)!.messages) + done.outputText;
  };

  it('finishes on the version it started with, subflow included, while a new one gets the new version', async () => {
    await apply(file('1', 'Question one?', 'child one'));
    const resting = await start('resting');
    expect(resting.status).toBe('awaiting_tool_approval');
    expect(gateText(resting)).toBe('Question one?');

    await apply(file('2', 'Question two?', 'child two'));

    const fresh = await start('fresh');
    expect(gateText(fresh)).toBe('Question two?');
    expect(await finish('fresh')).toContain('child two');

    const said = await finish('resting');
    expect(said).toContain('child one');
    expect(said).not.toContain('child two');
  });

  it('keeps that across a restart while it waits', async () => {
    await apply(file('1', 'Question one?', 'child one'));
    await start('resting');
    await apply(file('2', 'Question two?', 'child two'));

    // A new process finds only what was saved.
    FlowExecutor.conversationStates.clear();
    FlowExecutor.clearFlowCache();
    global.__flujo_flowsCache = null;
    const key = 'conversations/resting' as StorageKey;
    const saved = await loadItem<SharedState | undefined>(key, undefined);
    expect(saved?.status).toBe('awaiting_tool_approval');
    expect((await applyApprovalDecision(saved!, saved!.pendingToolCalls![0].id, 'approve')).outcome).toBe('ready');
    await saveItem(key, saved);

    const done = await resume('resting');

    expect(done.status).toBe('completed');
    const said = JSON.stringify(FlowExecutor.conversationStates.get('resting')!.messages) + done.outputText;
    expect(said).toContain('child one');
    expect(said).not.toContain('child two');
  });

  it('still finishes when the new version removes the subflow altogether', async () => {
    await apply(file('1', 'Question one?', 'child one'));
    await start('resting');

    await apply(file('2', 'Question two?', null));
    expect(await flowService.getFlow('child')).toBeNull();

    expect(await finish('resting')).toContain('child one');
  });

  it('is not pulled back by a rollback, while a new one is', async () => {
    await apply(file('1', 'Question one?', 'child one'));
    await apply(file('2', 'Question two?', 'child two'));
    await start('on-two');

    const report = await rollbackDesiredState({ reconcileRuntime: false });
    expect(report.outcome).toBe('rolled-back');

    const fresh = await start('on-one');
    expect(gateText(fresh)).toBe('Question one?');
    expect(await finish('on-one')).toContain('child one');
    expect(await finish('on-two')).toContain('child two');
  });

  it('looks the subflow up when it starts if the file switches pinning off', async () => {
    await apply(file('1', 'Question one?', 'child one', { pinSubflows: false }));
    await start('resting');

    await apply(file('2', 'Question two?', 'child two', { pinSubflows: false }));

    const said = await finish('resting');
    // Its own steps stay frozen as always, and only the subflow is the current one.
    expect(said).toContain('child two');
    expect((await flowService.getFlow('parent'))?.pinSubflowsAtRunStart).toBeUndefined();
  });

  it('leaves a flow that did not ask for it exactly as it was', async () => {
    await apply(file('1', 'Question one?', 'child one', { pinSubflows: false }));
    await start('ordinary');

    const state = FlowExecutor.conversationStates.get('ordinary')!;
    expect(state.flowSnapshot?.executionDependencies).toBeUndefined();
  });

  it('starts anyway when the subflows cannot be frozen', async () => {
    await apply(file('1', 'Question one?', 'child one'));
    // Someone removed a subflow by hand, so the new conversation cannot freeze it.
    await flowService.deleteFlow('child');

    const result = await start('cannot-freeze');

    expect(result.status).toBe('awaiting_tool_approval');
    expect(FlowExecutor.conversationStates.get('cannot-freeze')!.flowSnapshot?.executionDependencies).toBeUndefined();
  });
});
