/**
 * A Human step stops a flow until a person answers, then goes on (#1095).
 *
 * These cases run real graph conversion, nodes, runFlow, the approval decision and
 * saved state; no model is called. The MCP layer is replaced only so that work before
 * the step can be counted, which proves an answer never makes it run again. A wait
 * must hold across a restart, so state is also reloaded from storage the way a fresh
 * process would find it.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Flow, FlowNode } from '@/shared/types/flow';

const callToolMock = jest.fn();
jest.mock('@/backend/services/mcp', () => {
  const known: Record<string, unknown> = {
    callTool: (...args: unknown[]) => callToolMock(...args),
    loadServerConfigs: async () => [{ name: 'srv' }],
    setNodeRoots: () => undefined,
  };
  return { mcpService: new Proxy(known, { get: (target, name: string) => target[name] ?? (async () => ({})) }) };
});
const mockStoredFlows = new Map<string, unknown>();
jest.mock('@/backend/services/flow', () => ({
  flowService: {
    getFlow: async (id: string) => mockStoredFlows.get(id) ?? null,
    loadFlows: async () => [...mockStoredFlows.values()],
  },
}));
jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: async () => ({ isRunnable: true, issues: [] }),
  validateFlowObjectForRun: async () => ({ isRunnable: true, issues: [] }),
}));

import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { decideHumanTask } from '@/backend/execution/flow/humanTask';
import type { SharedState } from '@/backend/execution/flow/types';
import { StorageKey } from '@/shared/types/storage';
import { flowRequiresStepApproval } from '@/utils/shared/flowApproval';
import { HUMAN_STEP_TOOL_NAME, parseHumanTaskCall, type HumanStepProperties } from '@/utils/shared/humanStep';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { getHumanTaskEntry } from '@/backend/services/humanTasks/humanTaskIndex';
import { continueHumanTask } from '@/backend/services/humanTasks/continueHumanTask';
import { sweepHumanTasks } from '@/backend/services/humanTasks/humanTaskSweep';
import { getPendingApproval, putPendingApproval } from '@/backend/services/scheduler/pendingApprovals';
import { flowToolsCallTool } from '@/backend/services/mcp/flowTools';
import { buildFlowToolNameMap } from '@/shared/utils/flowToolNaming';

jest.setTimeout(30_000);

const DRAFT = 'Dear Ben, the meeting moves to Friday.';

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}

/**
 * Start -> Draft (a real tool call, counted, then a fixed draft) -> Human step -> Send -> Finish.
 * Send outputs `sendTemplate`, so a test can see what the step handed on.
 */
function draftReviewSend(id: string, human: HumanStepProperties, sendTemplate = 'Sent: ${var:review.value}'): Flow {
  return {
    id,
    name: id,
    nodes: [
      node('start', 'start'),
      node('draft', 'static', {
        outputTemplate: DRAFT,
        entries: [{ kind: 'toolCall', executionMode: 'real', serverName: 'srv', toolName: 'draft_it', argumentsJson: '{}', result: '' }],
      }),
      node('review', 'human', human as Record<string, unknown>),
      node('send', 'static', { outputTemplate: sendTemplate }),
      node('end', 'finish'),
      node('tools', 'mcp', { boundServer: 'srv', enabledTools: ['draft_it'] }),
    ],
    edges: [
      { id: 'to-draft', source: 'start', target: 'draft', data: { edgeType: 'standard' } },
      { id: 'to-review', source: 'draft', target: 'review', data: { edgeType: 'standard' } },
      { id: 'to-send', source: 'review', target: 'send', data: { edgeType: 'standard' } },
      { id: 'to-end', source: 'send', target: 'end', data: { edgeType: 'standard' } },
      { id: 'to-tools', source: 'draft', target: 'tools', data: { edgeType: 'mcp' } },
    ],
  } as unknown as Flow;
}

describe('a Human step', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.FLUJO_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-human-step-'));
    process.env.FLUJO_DATA_DIR = dataDir;
    await fs.mkdir(path.join(dataDir, 'workspaces', 'default-workspace', 'db'), { recursive: true });
    callToolMock.mockReset().mockResolvedValue({ success: true, data: { content: [{ type: 'text', text: 'drafted' }] } });
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
  const waitingCall = (conversationId: string) => {
    const call = stateOf(conversationId).pendingToolCalls![0];
    return { call, view: parseHumanTaskCall(call)! };
  };
  const answer = (conversationId: string, action: 'approve' | 'reject', human: Record<string, unknown> = {}) => {
    const { call, view } = waitingCall(conversationId);
    return applyApprovalDecision(stateOf(conversationId), call.id, action, {
      answer: { digest: view.digest, ...human }, channel: 'chat',
    });
  };
  const resultOf = (conversationId: string, variable = 'review') =>
    JSON.parse(stateOf(conversationId).variables![variable]) as Record<string, unknown>;
  const drafts = () => callToolMock.mock.calls.filter((call) => call[1] === 'draft_it').length;

  describe('approval', () => {
    it('stops before the next step and shows exactly what is approved', async () => {
      const result = await start('approve-wait', draftReviewSend('approve-wait', { mode: 'approval', prompt: 'Send this email?' }));

      expect(result.status).toBe('awaiting_tool_approval');
      expect(result.outputText).not.toMatch(/^Sent/);
      expect(result.pendingToolCalls).toHaveLength(1);
      expect(result.pendingToolCalls![0].function.name).toBe(HUMAN_STEP_TOOL_NAME);
      const view = parseHumanTaskCall(result.pendingToolCalls![0])!;
      expect(view).toMatchObject({ mode: 'approval', prompt: 'Send this email?', candidate: DRAFT });
      expect(view.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(Date.parse(view.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
      expect(await getHumanTaskEntry(view.requestId)).toMatchObject({
        conversationId: 'approve-wait', status: 'waiting', mode: 'approval', nodeId: 'review',
      });
    });

    it('goes on after a yes, once, without redoing the draft', async () => {
      const conversationId = 'approve-yes';
      await start(conversationId, draftReviewSend(conversationId, { mode: 'approval', prompt: 'Send?' }, 'Sent.'));
      const { view } = waitingCall(conversationId);

      expect((await answer(conversationId, 'approve')).outcome).toBe('ready');
      const done = await resume(conversationId);

      expect(done.status).toBe('completed');
      expect(done.outputText).toBe('Sent.');
      expect(drafts()).toBe(1);
      expect(resultOf(conversationId)).toMatchObject({ requestId: view.requestId, outcome: 'approved', candidateDigest: view.digest });
      expect(stateOf(conversationId).variableSources?.review?.from).toBe('person');
      expect(stateOf(conversationId).humanTask).toBeUndefined();
      expect(await getHumanTaskEntry(view.requestId)).toMatchObject({ status: 'applied', outcome: 'approved' });
    });

    it('refuses a yes that does not name what the person saw', async () => {
      const conversationId = 'approve-no-digest';
      await start(conversationId, draftReviewSend(conversationId, { mode: 'approval', prompt: 'Send?' }));
      const { call } = waitingCall(conversationId);

      const blind = await applyApprovalDecision(stateOf(conversationId), call.id, 'approve');
      const stale = await applyApprovalDecision(stateOf(conversationId), call.id, 'approve', {
        answer: { digest: 'sha256:0000' }, channel: 'chat',
      });

      expect(blind).toMatchObject({ outcome: 'human_refused', status: 409 });
      expect(stale).toMatchObject({ outcome: 'human_refused', status: 409 });
      expect(stateOf(conversationId).status).toBe('awaiting_tool_approval');
      expect(stateOf(conversationId).humanTask?.decision).toBeUndefined();
    });

    it('refuses a yes when what the step shows was changed while it waited', async () => {
      const conversationId = 'approve-changed';
      await start(conversationId, draftReviewSend(conversationId, { mode: 'approval', prompt: 'Send?' }));
      const { view } = waitingCall(conversationId);
      stateOf(conversationId).humanTask!.candidate = 'Dear Ben, wire the money to this account.';

      const result = await answer(conversationId, 'approve');

      expect(result).toMatchObject({ outcome: 'human_refused', status: 409 });
      expect(view.candidate).toBe(DRAFT);
    });

    it('stops after a no and never runs the next step', async () => {
      const conversationId = 'approve-no';
      await start(conversationId, draftReviewSend(conversationId, { mode: 'approval', prompt: 'Send?', rejectedText: 'Kept as a draft.' }, 'Sent.'));

      expect((await applyApprovalDecision(stateOf(conversationId), waitingCall(conversationId).call.id, 'reject')).outcome).toBe('ready');
      const done = await resume(conversationId);

      expect(done.outputText).toBe('Kept as a draft.');
      expect(resultOf(conversationId).outcome).toBe('rejected');
    });

    it('lets the flow route on the answer when it chooses to go on', async () => {
      const definition = draftReviewSend('route', { mode: 'approval', prompt: 'Send?', onReject: 'continue' }, 'Sent.');
      (definition.nodes as FlowNode[]).push(node('archive', 'static', { outputTemplate: 'Archived.' }));
      definition.edges = [
        ...definition.edges.filter((edge) => edge.id !== 'to-send'),
        { id: 'if-yes', source: 'review', target: 'send', data: { edgeType: 'standard', condition: { kind: 'equals', value: 'approved', target: 'variable', variable: 'review.outcome', from: 'person' } } },
        { id: 'otherwise', source: 'review', target: 'archive', data: { edgeType: 'standard' } },
        { id: 'archive-end', source: 'archive', target: 'end', data: { edgeType: 'standard' } },
      ] as Flow['edges'];

      await start('route-yes', { ...definition, id: 'route-yes' });
      await answer('route-yes', 'approve');
      expect((await resume('route-yes')).outputText).toBe('Sent.');

      await start('route-no', { ...definition, id: 'route-no' });
      await answer('route-no', 'reject');
      expect((await resume('route-no')).outputText).toBe('Archived.');
    });
  });

  describe('edit', () => {
    const edit: HumanStepProperties = { mode: 'edit', prompt: 'Check the email before it goes out.' };

    it('hands the changed text to the next step and keeps the original on record', async () => {
      const conversationId = 'edit-yes';
      await start(conversationId, draftReviewSend(conversationId, edit));
      const { view } = waitingCall(conversationId);
      expect(view.candidate).toBe(DRAFT);

      expect((await answer(conversationId, 'approve', { value: 'Dear Ben, the meeting moves to Monday.' })).outcome).toBe('ready');
      const done = await resume(conversationId);

      expect(done.outputText).toBe('Sent: Dear Ben, the meeting moves to Monday.');
      const result = resultOf(conversationId);
      expect(result).toMatchObject({ outcome: 'submitted', value: 'Dear Ben, the meeting moves to Monday.', edited: true, candidateDigest: view.digest });
      expect(result.valueDigest).toMatch(/^sha256:/);
      expect(result.valueDigest).not.toBe(view.digest);
      expect(drafts()).toBe(1);
    });

    it('keeps the text as it was when the person sends it unchanged', async () => {
      const conversationId = 'edit-same';
      await start(conversationId, draftReviewSend(conversationId, edit));
      await answer(conversationId, 'approve');

      expect((await resume(conversationId)).outputText).toBe(`Sent: ${DRAFT}`);
      expect(resultOf(conversationId)).toMatchObject({ value: DRAFT, edited: false });
    });

    it('refuses changed JSON that no longer parses, and keeps waiting', async () => {
      const conversationId = 'edit-json';
      const definition = draftReviewSend(conversationId, { ...edit, review: { source: 'variable', variable: 'payload', format: 'json' } });
      await start(conversationId, definition, { variables: { payload: '{"to":"ben"}' } });

      const broken = await answer(conversationId, 'approve', { value: '{"to":' });

      expect(broken).toMatchObject({ outcome: 'human_refused', status: 422 });
      expect(stateOf(conversationId).status).toBe('awaiting_tool_approval');
      expect((await answer(conversationId, 'approve', { value: '{"to":"anna"}' })).outcome).toBe('ready');
    });
  });

  describe('input', () => {
    const input: HumanStepProperties = {
      mode: 'input',
      prompt: 'How many seats?',
      outputVariable: 'booking',
      fields: [
        { name: 'seats', type: 'integer', required: true, min: 1, max: 8 },
        { name: 'room', type: 'choice', options: ['small', 'large'] },
      ],
    };

    it('refuses wrong answers per question and keeps the step waiting', async () => {
      const conversationId = 'input-wrong';
      await start(conversationId, draftReviewSend(conversationId, input, 'Booked ${var:booking.value.seats}'));

      const result = await answer(conversationId, 'approve', { value: { seats: 12, room: 'huge' } });

      expect(result).toMatchObject({ outcome: 'human_refused', status: 422 });
      expect(result.outcome === 'human_refused' && result.fieldErrors).toEqual({
        seats: expect.any(String), room: expect.any(String),
      });
      expect(stateOf(conversationId).status).toBe('awaiting_tool_approval');
    });

    it('stores the checked answers and goes on', async () => {
      const conversationId = 'input-right';
      await start(conversationId, draftReviewSend(conversationId, input, 'Booked ${var:booking.value.seats}'));

      await answer(conversationId, 'approve', { value: { seats: '3' } });
      const done = await resume(conversationId);

      expect(done.outputText).toBe('Booked 3');
      expect(resultOf(conversationId, 'booking')).toMatchObject({ outcome: 'submitted', value: { seats: 3 } });
    });
  });

  describe('one answer only', () => {
    it('returns the first receipt for the same answer and refuses a different one', async () => {
      const conversationId = 'once';
      await start(conversationId, draftReviewSend(conversationId, { mode: 'edit', prompt: 'Check.' }));
      const { view } = waitingCall(conversationId);
      const state = stateOf(conversationId);
      const first = decideHumanTask(state, {
        requestId: view.requestId, accept: true, answer: { digest: view.digest, value: 'A', idempotencyKey: 'k1' }, channel: 'api',
      });
      const again = decideHumanTask(state, {
        requestId: view.requestId, accept: true, answer: { digest: view.digest, value: 'A', idempotencyKey: 'k1' }, channel: 'api',
      });
      const other = decideHumanTask(state, {
        requestId: view.requestId, accept: true, answer: { digest: view.digest, value: 'B' }, channel: 'api',
      });
      const no = decideHumanTask(state, { requestId: view.requestId, accept: false, channel: 'api' });

      expect(first.kind).toBe('recorded');
      expect(again).toEqual({ kind: 'repeat', receipt: first.kind === 'recorded' ? first.receipt : undefined });
      expect(other).toMatchObject({ kind: 'refused', status: 409 });
      expect(no).toMatchObject({ kind: 'refused', status: 409 });
    });

    it('cannot be unlocked by an answer to an earlier wait', async () => {
      const definition = draftReviewSend('loop', { mode: 'approval', prompt: 'Send?' });
      await start('loop', definition);
      const earlier = waitingCall('loop').view;

      // A new message replaces the wait; the step asks again with a new request.
      await start('loop', definition, { prompt: undefined, messages: [...stateOf('loop').messages, { role: 'user', content: 'Try again.' }] });
      const later = waitingCall('loop').view;

      expect(later.requestId).not.toBe(earlier.requestId);
      expect(decideHumanTask(stateOf('loop'), { requestId: earlier.requestId, accept: true, answer: { digest: earlier.digest }, channel: 'api' }))
        .toMatchObject({ kind: 'refused', status: 404 });
      expect(await getHumanTaskEntry(earlier.requestId)).toMatchObject({ status: 'cancelled' });
    });
  });

  describe('restart and deadline', () => {
    it('keeps the wait and its content across a restart and goes on without redoing the draft', async () => {
      const conversationId = 'restart';
      await start(conversationId, draftReviewSend(conversationId, { mode: 'edit', prompt: 'Check.' }));
      const before = waitingCall(conversationId).view;

      FlowExecutor.conversationStates.clear();
      FlowExecutor.clearFlowCache();
      const saved = await loadItem<SharedState | undefined>(`conversations/${conversationId}` as StorageKey, undefined);
      expect(saved?.status).toBe('awaiting_tool_approval');
      expect(saved?.humanTask).toMatchObject({ requestId: before.requestId, digest: before.digest, candidate: DRAFT });

      const decision = await applyApprovalDecision(saved!, saved!.humanTask!.toolCallId, 'approve', {
        answer: { digest: before.digest, value: 'Changed after restart.' }, channel: 'chat',
      });
      expect(decision.outcome).toBe('ready');
      await saveItem(`conversations/${conversationId}` as StorageKey, saved);

      const done = await resume(conversationId);
      expect(done.outputText).toBe('Sent: Changed after restart.');
      expect(drafts()).toBe(1);
    });

    it('picks up an answer that was saved just before FLUJO stopped', async () => {
      const conversationId = 'saved-answer';
      await start(conversationId, draftReviewSend(conversationId, { mode: 'approval', prompt: 'Send?' }, 'Sent.'));
      const { view } = waitingCall(conversationId);
      const state = stateOf(conversationId);
      decideHumanTask(state, { requestId: view.requestId, accept: true, answer: { digest: view.digest }, channel: 'api' });
      await saveItem(`conversations/${conversationId}` as StorageKey, state);
      FlowExecutor.conversationStates.clear();

      // The minute sweep only opens steps that are due; the start-up sweep opens them all.
      expect((await sweepHumanTasks()).continued).toBe(0);
      const report = await sweepHumanTasks(new Date(), { full: true });

      expect(report.continued).toBe(1);
      expect(stateOf(conversationId).status).toBe('completed');
      expect(stateOf(conversationId).messages.at(-1)?.content).toBe('Sent.');
      expect(drafts()).toBe(1);
    });

    it('times out after its deadline, never approves, and refuses a late answer', async () => {
      const conversationId = 'deadline';
      await start(conversationId, draftReviewSend(conversationId, { mode: 'approval', prompt: 'Send?', timeoutMinutes: 5 }, 'Sent.'));
      const { view } = waitingCall(conversationId);
      const late = new Date(Date.parse(view.expiresAt) + 1000);

      expect(decideHumanTask(stateOf(conversationId), {
        requestId: view.requestId, accept: true, answer: { digest: view.digest }, channel: 'api', now: late,
      })).toMatchObject({ kind: 'refused', status: 410 });

      const report = await sweepHumanTasks(late);

      expect(report.continued).toBe(1);
      expect(stateOf(conversationId).messages.at(-1)?.content).toBe('Nobody answered in time.');
      expect(resultOf(conversationId)).toMatchObject({ outcome: 'timed_out' });
      expect(stateOf(conversationId).variableSources?.review?.from).toBe('rule');
      expect(await getHumanTaskEntry(view.requestId)).toMatchObject({ status: 'applied', outcome: 'timed_out' });
    });

    it('leaves a step alone before its deadline', async () => {
      const conversationId = 'not-yet';
      await start(conversationId, draftReviewSend(conversationId, { mode: 'approval', prompt: 'Send?' }));

      expect(await continueHumanTask(conversationId, { expire: true })).toEqual({ status: 'idle' });
      expect(stateOf(conversationId).status).toBe('awaiting_tool_approval');
    });
  });

  describe('where nobody can answer', () => {
    it('fails at once in a run that is not saved, and says why', async () => {
      const result = await start('transient', draftReviewSend('transient', { mode: 'approval', prompt: 'Send?' }), { mode: 'ephemeral' });

      expect(result.status).toBe('error');
      expect(result.error?.details).toMatchObject({ type: 'approval_required', name: HUMAN_STEP_TOOL_NAME });
      expect(result.error?.message).toMatch(/Human step/);
    });

    it('fails on a step with nothing to ask instead of asking nothing', async () => {
      const result = await start('empty', draftReviewSend('empty', { mode: 'approval', prompt: '  ' }));

      expect(result.status).toBe('error');
      expect(result.outputText).not.toMatch(/^Sent/);
    });
  });

  it('clears a scheduled run from the approval inbox once its answer lets it finish', async () => {
    const conversationId = 'scheduled';
    await start(conversationId, draftReviewSend(conversationId, { mode: 'approval', prompt: 'Send?' }, 'Sent.'), { source: 'schedule' });
    await putPendingApproval({
      approvalId: conversationId, conversationId, plannedExecutionId: 'exec-1', flowId: conversationId,
      runId: 'run-1', triggerSummary: 'Schedule', pendingToolCalls: [], createdAt: new Date().toISOString(),
    });
    const { view } = waitingCall(conversationId);
    const state = stateOf(conversationId);
    decideHumanTask(state, { requestId: view.requestId, accept: true, answer: { digest: view.digest }, channel: 'api' });
    await saveItem(`conversations/${conversationId}` as StorageKey, state);

    expect(await continueHumanTask(conversationId, { requestId: view.requestId })).toMatchObject({ status: 'continued', runStatus: 'completed' });
    expect(await getPendingApproval(conversationId)).toBeNull();
  });

  it('ends an MCP flow tool call with a plain error instead of an empty success', async () => {
    const definition = draftReviewSend('mcp-tool', { mode: 'approval', prompt: 'Send?' });
    mockStoredFlows.set(definition.id, definition);
    try {
      const toolName = buildFlowToolNameMap([{ id: definition.id, name: definition.name }]).get(definition.id)!;

      const result = await flowToolsCallTool(toolName, { input: 'Go.' });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/Human step/);
    } finally {
      mockStoredFlows.delete(definition.id);
    }
  });

  it('counts as a step that needs a person, so automations save such a run', () => {
    expect(flowRequiresStepApproval(draftReviewSend('needs', { mode: 'approval', prompt: 'Send?' }))).toBe(true);
  });
});
