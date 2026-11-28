/**
 * Human steps in the places a run used to give up (#1095): inside sub-flows, in flows
 * started as MCP tools or with execute_flow (which used to run unsaved), as MCP Tasks
 * that survive a restart, routed by a connection drawn for an answer, and answered for
 * a Persona through its dispatcher.
 *
 * These cases run real graph conversion, nodes, runFlow, saved state, the answer path
 * and the MCP task store; no model is called. Only the MCP tool servers, the flow store
 * and the Persona dispatcher's run loop are replaced. A restart is simulated by dropping
 * every live state, so only what was saved remains.
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
jest.mock('@/backend/services/flow/index', () => ({
  flowService: {
    getFlow: async (id: string) => mockStoredFlows.get(id) ?? null,
    loadFlows: async () => [...mockStoredFlows.values()],
  },
}));
jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: async () => ({ isRunnable: true, issues: [] }),
  validateFlowObjectForRun: async () => ({ isRunnable: true, issues: [] }),
}));
// MCP task results are sealed with the workspace key; use a throwaway key instead of a real keyring.
jest.mock('@/utils/encryption/secure', () => {
  const actual = jest.requireActual<typeof import('@/utils/encryption/secure')>('@/utils/encryption/secure');
  const crypto = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  const key = crypto.randomBytes(32);
  return {
    ...actual,
    encryptWithPassword: async (text: string) => {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return `v2:${Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64')}`;
    },
    decryptWithPassword: async (text: string) => {
      const data = Buffer.from(text.slice(3), 'base64'), decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
});
const resumeMock = jest.fn();
jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => ({
  ...jest.requireActual('@/backend/services/enduringAgents/personaDispatcher'),
  resumePersonaFlowDispatch: (...args: unknown[]) => resumeMock(...args),
}));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => null }));
const fromOtherComputer = { value: false };
jest.mock('@/utils/http/localRequest', () => ({
  ...jest.requireActual('@/utils/http/localRequest'),
  assertLocalRequest: (_request: unknown, options?: { strictLoopback?: boolean }) =>
    options?.strictLoopback && fromOtherComputer.value ? Response.json({ error: 'Forbidden' }, { status: 403 }) : null,
}));

import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import type { SharedState } from '@/backend/execution/flow/types';
import { StorageKey } from '@/shared/types/storage';
import { saveItem } from '@/utils/storage/backend';
import { DEFAULT_WORKSPACE } from '@/utils/workspace';
import {
  humanAnswerFromForm, humanElicitationForm, humanInputKey, parseHumanTaskCall, type HumanStepProperties,
} from '@/utils/shared/humanStep';
import { compileFlowSpec, flowToSpec } from '@/utils/shared/flowSpecCompiler';
import { flowMayWaitForPerson } from '@/utils/shared/flowApproval';
import { getHumanTaskEntry } from '@/backend/services/humanTasks/humanTaskIndex';
import { answerHumanTask } from '@/backend/services/humanTasks/answerHumanTask';
import { continueHumanTask } from '@/backend/services/humanTasks/continueHumanTask';
import { sweepHumanTasks } from '@/backend/services/humanTasks/humanTaskSweep';
import { flowToolsCallTool, runFlowTool } from '@/backend/services/mcp/flowTools';
import { flowToolContinuations } from '@/backend/services/mcp/flowToolContinuations';
import { ServerTaskHandoff, ServerTaskStore, setServerTaskContinuations, type ServerTaskView } from '@/backend/services/mcp/serverTasks';
import { buildFlowToolNameMap } from '@/shared/utils/flowToolNaming';
import type { OwnerRequestAuthorization } from '@/backend/services/security/ownerAccess';
import { POST as answerRoute } from '@/app/api/human-tasks/[requestId]/route';

jest.setTimeout(60_000);

const DRAFT = 'Dear Ben, the meeting moves to Friday.';

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}
const edge = (id: string, source: string, target: string, extra: Record<string, unknown> = {}) =>
  ({ id, source, target, data: { edgeType: 'standard' }, ...extra });

/** Start -> Draft (a real, counted tool call) -> Human step -> Send -> Finish. */
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
      edge('to-draft', 'start', 'draft'),
      edge('to-review', 'draft', 'review'),
      edge('to-send', 'review', 'send'),
      edge('to-end', 'send', 'end'),
      { id: 'to-tools', source: 'draft', target: 'tools', data: { edgeType: 'mcp' } },
    ],
  } as unknown as Flow;
}

/** Start -> Subflow (one or more children) -> Done -> Finish. */
function parentFlow(id: string, subflow: Record<string, unknown>): Flow {
  return {
    id,
    name: id,
    nodes: [
      node('start', 'start'),
      node('sub', 'subflow', { inputMode: 'isolated', promptTemplate: 'Write the email.', ...subflow }),
      node('done', 'static', { outputTemplate: 'Parent done.' }),
      node('end', 'finish'),
    ],
    edges: [edge('p1', 'start', 'sub'), edge('p2', 'sub', 'done'), edge('p3', 'done', 'end')],
  } as unknown as Flow;
}

function store(flow: Flow): Flow {
  mockStoredFlows.set(flow.id, flow);
  return flow;
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe('Human steps where a run used to give up', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.FLUJO_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-human-waits-'));
    process.env.FLUJO_DATA_DIR = dataDir;
    await fs.mkdir(path.join(dataDir, 'workspaces', 'default-workspace', 'db'), { recursive: true });
    callToolMock.mockReset().mockResolvedValue({ success: true, data: { content: [{ type: 'text', text: 'drafted' }] } });
    resumeMock.mockReset();
    fromOtherComputer.value = false;
    mockStoredFlows.clear();
    FlowExecutor.clearFlowCache();
    FlowExecutor.conversationStates.clear();
  });

  afterEach(async () => {
    FlowExecutor.conversationStates.clear();
    if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  });

  const start = (conversationId: string, definition: Flow, prompt = 'Go.') => runFlow({
    conversationId, flowDefinition: definition, prompt, source: 'chat', mode: 'conversation', flujo: true, userTurn: true,
  });
  /** Forget every live state, as a restarted FLUJO would. */
  const restart = () => FlowExecutor.conversationStates.clear();
  const saved = async (conversationId: string): Promise<SharedState> => (await loadConversationState(conversationId))!;
  const drafts = () => callToolMock.mock.calls.filter((call) => call[1] === 'draft_it').length;
  const lastText = (state: SharedState) => state.messages.filter((message) => message.role === 'assistant')
    .map((message) => (typeof message.content === 'string' ? message.content : '')).filter(Boolean);
  /** Everything the run said, as one text (a sub-flow's answer arrives wrapped in a note). */
  const said = (state: SharedState) => lastText(state).join(' | ');

  describe('inside a sub-flow', () => {
    it('makes the parent wait, survives a restart, and joins once the child is answered', async () => {
      store(draftReviewSend('child-edit', { mode: 'edit', title: 'Check the email', prompt: 'Fix anything wrong.' }));
      const result = await start('parent-edit', store(parentFlow('parent-edit', { subflowId: 'child-edit' })));

      expect(result.status).toBe('awaiting_tool_approval');
      const view = parseHumanTaskCall(result.pendingToolCalls![0])!;
      expect(view).toMatchObject({ mode: 'edit', title: 'Check the email', candidate: DRAFT });
      const entry = (await getHumanTaskEntry(view.requestId))!;
      expect(entry.conversationId).not.toBe('parent-edit');
      expect(entry).toMatchObject({ status: 'waiting', parentConversationId: 'parent-edit' });
      const child = await saved(entry.conversationId);
      expect(child.status).toBe('awaiting_tool_approval');
      expect(child.humanTask?.requestId).toBe(view.requestId);
      expect(lastText(await saved('parent-edit'))).not.toContain('Parent done.');
      expect(drafts()).toBe(1);

      restart();
      // The person answers in the parent's chat; the answer goes to the child that asked.
      const answered = await answerHumanTask({
        requestId: view.requestId, accept: true, answer: { digest: view.digest, value: 'Better text.' },
        channel: 'chat', conversationId: 'parent-edit', fromThisComputer: true,
      });
      expect(answered).toMatchObject({ kind: 'saved', conversationId: entry.conversationId, status: 'decided' });
      expect(await continueHumanTask(entry.conversationId, { requestId: view.requestId })).toMatchObject({ status: 'continued', runStatus: 'completed' });

      const parent = await saved('parent-edit');
      expect(parent.status).toBe('completed');
      expect(said(parent)).toContain('Sent: Better text.');
      expect(lastText(parent).at(-1)).toBe('Parent done.');
      expect((await saved(entry.conversationId)).status).toBe('completed');
      expect(drafts()).toBe(1);
      expect(await getHumanTaskEntry(view.requestId)).toMatchObject({ status: 'applied', outcome: 'submitted' });
    });

    it('picks up a child\'s saved answer after FLUJO stopped before the parent went on', async () => {
      store(draftReviewSend('child-crash', { mode: 'approval', prompt: 'Send?' }, 'Sent.'));
      const result = await start('parent-crash', store(parentFlow('parent-crash', { subflowId: 'child-crash' })));
      const view = parseHumanTaskCall(result.pendingToolCalls![0])!;
      expect((await answerHumanTask({
        requestId: view.requestId, accept: true, answer: { digest: view.digest }, channel: 'api', fromThisComputer: true,
      })).kind).toBe('saved');
      // FLUJO stops here: the answer is saved, nothing went on.
      restart();
      expect((await saved('parent-crash')).status).toBe('awaiting_tool_approval');

      const report = await sweepHumanTasks(new Date(), { full: true });

      expect(report.continued).toBe(1);
      const parent = await saved('parent-crash');
      expect(parent.status).toBe('completed');
      expect(said(parent)).toContain('Sent.');
      expect(drafts()).toBe(1);
      // A second sweep finds nothing left to do.
      expect((await sweepHumanTasks(new Date(), { full: true })).continued).toBe(0);
    });

    it('waits even when the sub-flow is set not to keep its conversation, because its flow asks a person', async () => {
      store(draftReviewSend('child-unsaved', { mode: 'approval', prompt: 'Send?' }, 'Sent.'));
      const result = await start('parent-unsaved', store(parentFlow('parent-unsaved', { subflowId: 'child-unsaved', saveConversation: false })));

      expect(result.status).toBe('awaiting_tool_approval');
      const view = parseHumanTaskCall(result.pendingToolCalls![0])!;
      const entry = (await getHumanTaskEntry(view.requestId))!;
      expect((await saved(entry.conversationId)).humanTask?.requestId).toBe(view.requestId);

      const answered = await answerHumanTask({
        requestId: view.requestId, accept: true, answer: { digest: view.digest }, channel: 'api', fromThisComputer: true,
      });
      expect(answered.kind).toBe('saved');
      await continueHumanTask(entry.conversationId, { requestId: view.requestId });
      const parent = await saved('parent-unsaved');
      expect(parent.status).toBe('completed');
      expect(said(parent)).toContain('Sent.');
      expect(lastText(parent).at(-1)).toBe('Parent done.');
    });

    it('times the child out after its deadline, and the parent goes on with the child\'s answer', async () => {
      store(draftReviewSend('child-late', { mode: 'approval', prompt: 'Send?', timeoutMinutes: 5 }, 'Sent.'));
      const result = await start('parent-late', store(parentFlow('parent-late', { subflowId: 'child-late' })));
      const view = parseHumanTaskCall(result.pendingToolCalls![0])!;
      restart();

      const report = await sweepHumanTasks(new Date(Date.parse(view.expiresAt) + 1000));

      expect(report.continued).toBe(1);
      const parent = await saved('parent-late');
      expect(parent.status).toBe('completed');
      expect(said(parent)).toContain('Nobody answered in time.');
      expect(lastText(parent).at(-1)).toBe('Parent done.');
      expect(said(parent)).not.toContain('Sent.');
    });

    it('lets independent children finish and joins once the waiting one is answered', async () => {
      store(draftReviewSend('child-a', { mode: 'approval', prompt: 'Send?' }, 'A sent.'));
      store({
        id: 'child-b', name: 'child-b',
        nodes: [node('start', 'start'), node('b', 'static', { outputTemplate: 'B done.' }), node('end', 'finish')],
        edges: [edge('b1', 'start', 'b'), edge('b2', 'b', 'end')],
      } as unknown as Flow);
      const result = await start('parent-lanes', store(parentFlow('parent-lanes', { parallelSubflowIds: ['child-a', 'child-b'] })));

      expect(result.status).toBe('awaiting_tool_approval');
      expect(result.pendingToolCalls).toHaveLength(1);
      const view = parseHumanTaskCall(result.pendingToolCalls![0])!;
      const entry = (await getHumanTaskEntry(view.requestId))!;

      const answered = await answerHumanTask({
        requestId: view.requestId, accept: true, answer: { digest: view.digest }, channel: 'chat', fromThisComputer: true,
      });
      expect(answered.kind).toBe('saved');
      await continueHumanTask(entry.conversationId, { requestId: view.requestId });

      const parent = await saved('parent-lanes');
      expect(parent.status).toBe('completed');
      const text = lastText(parent).join('\n');
      expect(text).toContain('A sent.');
      expect(text).toContain('B done.');
      expect(text.match(/B done\./g)).toHaveLength(1);
    });

    it('waits through two levels of sub-flows, even when neither is set to keep its conversation, and both go on once answered', async () => {
      store(draftReviewSend('grandchild', { mode: 'approval', title: 'Deep question', prompt: 'Send?' }, 'Deep sent.'));
      store({ ...parentFlow('middle', { subflowId: 'grandchild', saveConversation: false }), id: 'middle', name: 'middle' });
      const result = await start('top', store(parentFlow('top', { subflowId: 'middle', saveConversation: false })));

      expect(result.status).toBe('awaiting_tool_approval');
      const view = parseHumanTaskCall(result.pendingToolCalls![0])!;
      expect(view.title).toBe('Deep question');
      const owner = (await getHumanTaskEntry(view.requestId))!.conversationId;
      restart();

      const answered = await answerHumanTask({
        requestId: view.requestId, accept: true, answer: { digest: view.digest }, channel: 'chat', conversationId: 'top', fromThisComputer: true,
      });
      expect(answered).toMatchObject({ kind: 'saved', conversationId: owner });
      expect(await continueHumanTask(owner, { requestId: view.requestId })).toMatchObject({ status: 'continued', runStatus: 'completed' });

      const top = await saved('top');
      expect(top.status).toBe('completed');
      expect(lastText(top).at(-1)).toBe('Parent done.');
      // The middle flow got the deep answer and finished; the top took the middle's own answer.
      const middle = await saved((await saved(owner)).parentRunId!);
      expect(middle.status).toBe('completed');
      expect(said(middle)).toContain('Deep sent.');
      expect((await saved(owner)).status).toBe('completed');
      expect(drafts()).toBe(1);
    });

    it('a run that is not saved says so and ends the child\'s step, instead of leaving it to wait for nothing', async () => {
      store(draftReviewSend('child-orphan', { mode: 'approval', prompt: 'Send?' }));
      const result = await runFlow({
        conversationId: 'parent-orphan', flowDefinition: store(parentFlow('parent-orphan', { subflowId: 'child-orphan' })),
        prompt: 'Go.', source: 'internal', mode: 'ephemeral', flujo: true,
      });

      expect(result.status).toBe('error');
      expect(result.error?.message).toMatch(/not saved, so it cannot wait/);
      const child = [...FlowExecutor.conversationStates.values()].find((state) => state.flowId === 'child-orphan')!;
      await waitFor(async () => (await saved(child.conversationId!)).status === 'error', 'the child to stop');
      expect((await saved(child.conversationId!)).humanTask).toBeUndefined();
    });

    it('counts a flow whose sub-flow asks a person as one that may wait, so automations and tools save it', async () => {
      const child = store(draftReviewSend('child-nested', { mode: 'approval', prompt: 'Send?' }));
      const parent = store(parentFlow('parent-nested', { subflowId: 'child-nested' }));
      const looping = store(parentFlow('parent-loop', { subflowId: 'parent-loop' }));
      const load = async (id: string) => mockStoredFlows.get(id) as Flow | undefined;

      expect(await flowMayWaitForPerson(parent, load)).toBe(true);
      expect(await flowMayWaitForPerson(child, load)).toBe(true);
      expect(await flowMayWaitForPerson(looping, load)).toBe(false);

      // Started as an MCP tool, the outer flow runs saved and hands over while its child waits.
      const toolName = buildFlowToolNameMap([{ id: parent.id, name: parent.name }]).get(parent.id)!;
      const result = await flowToolsCallTool(toolName, { input: 'Go.' });
      expect((result.structuredContent as { status: string }).status).toBe('waiting_for_person');
    });

    it('ends the child\'s waiting step when a new message replaces the parent\'s wait', async () => {
      store(draftReviewSend('child-replaced', { mode: 'approval', prompt: 'Send?' }));
      const definition = store(parentFlow('parent-replaced', { subflowId: 'child-replaced' }));
      const first = parseHumanTaskCall((await start('parent-replaced', definition)).pendingToolCalls![0])!;
      const firstChild = (await getHumanTaskEntry(first.requestId))!.conversationId;

      await start('parent-replaced', definition, 'Start over.');

      await waitFor(async () => (await getHumanTaskEntry(first.requestId))?.status === 'cancelled', 'the old step to end');
      await waitFor(async () => (await saved(firstChild)).status === 'error', 'the old child to stop');
      expect((await saved(firstChild)).humanTask).toBeUndefined();
      expect(await answerHumanTask({
        requestId: first.requestId, accept: true, answer: { digest: first.digest }, channel: 'api', fromThisComputer: true,
      })).toMatchObject({ kind: 'refused', status: 404 });
    });
  });

  describe('in a flow started as an MCP tool', () => {
    const toolOf = (definition: Flow) => buildFlowToolNameMap([{ id: definition.id, name: definition.name }]).get(definition.id)!;

    it('runs saved, hands over with the waiting conversation instead of an empty success, and goes on after the answer', async () => {
      const definition = store(draftReviewSend('mcp-plain', { mode: 'approval', title: 'Send it?', prompt: 'Send?' }, 'Sent.'));

      const result = await flowToolsCallTool(toolOf(definition), { input: 'Go.' });

      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { text: string }).text).toMatch(/waiting for a person \("Send it\?"\)/);
      const structured = result.structuredContent as { status: string; conversationId: string; steps: Array<{ requestId: string }> };
      expect(structured.status).toBe('waiting_for_person');
      restart();
      const waiting = await saved(structured.conversationId);
      expect(waiting).toMatchObject({ status: 'awaiting_tool_approval', source: 'mcp' });

      const view = parseHumanTaskCall(waiting.pendingToolCalls![0])!;
      expect((await answerHumanTask({
        requestId: view.requestId, accept: true, answer: { digest: view.digest }, channel: 'api', fromThisComputer: true,
      })).kind).toBe('saved');
      await continueHumanTask(structured.conversationId, { requestId: view.requestId });
      expect(lastText(await saved(structured.conversationId)).at(-1)).toBe('Sent.');
      expect(drafts()).toBe(1);
    });

    describe('as an MCP Task', () => {
      const auth: OwnerRequestAuthorization = {
        principal: {
          ownerId: 'owner', credentialId: 'credential', policyRevision: 'revision',
          expiresAt: Date.now() + 3_600_000, scopes: ['mcp:access', 'control:admin', 'secrets:read'],
        },
        recheck: async () => null,
      } as unknown as OwnerRequestAuthorization;
      let taskStore: ServerTaskStore;
      beforeEach(() => {
        setServerTaskContinuations(flowToolContinuations);
        taskStore = new ServerTaskStore({ directory: dataDir });
      });
      const create = (definition: Flow) => taskStore.create(auth, DEFAULT_WORKSPACE, {
        run: async (execution) => {
          const { result, waitingIn } = await runFlowTool(toolOf(definition), { input: 'Go.' }, {
            abortSignal: execution.signal, assertAuthorized: execution.assertAuthorized,
          });
          return waitingIn ? new ServerTaskHandoff(waitingIn) : { ...result, resultType: 'complete' };
        },
      });
      const statusOf = async (taskId: string, status: string): Promise<ServerTaskView> => {
        let view: ServerTaskView | undefined;
        await waitFor(async () => {
          view = await taskStore.get(auth, DEFAULT_WORKSPACE, taskId);
          return view.status === status;
        }, `task ${status}`);
        return view!;
      };

      it('asks for input with a form of the frozen step, survives a restart, and returns the result after tasks/update', async () => {
        const definition = store(draftReviewSend('mcp-task', { mode: 'edit', title: 'Check the email', prompt: 'Fix it.' }));
        const task = await create(definition);

        const asking = await statusOf(task.taskId, 'input_required');
        const [key, request] = Object.entries(asking.inputRequests!)[0] as [string, { method: string; params: { message: string; requestedSchema: { properties: { value: { default: string } } } } }];
        expect(request.method).toBe('elicitation/create');
        expect(request.params.message).toContain(DRAFT);
        expect(request.params.requestedSchema.properties.value.default).toBe(DRAFT);

        // A restart: no live task, no live run. The handle still follows the saved run.
        restart();
        taskStore = new ServerTaskStore({ directory: dataDir });
        expect((await taskStore.get(auth, DEFAULT_WORKSPACE, task.taskId)).inputRequests).toHaveProperty(key);

        await taskStore.update(auth, DEFAULT_WORKSPACE, task.taskId, { [key]: { action: 'accept', content: { value: 'Edited over MCP.' } } });
        const done = await statusOf(task.taskId, 'completed');

        expect(done.result).toMatchObject({ content: [{ type: 'text', text: 'Sent: Edited over MCP.' }] });
        expect(drafts()).toBe(1);
        // The same input again after the result is acknowledged and changes nothing.
        await expect(taskStore.update(auth, DEFAULT_WORKSPACE, task.taskId, { [key]: { action: 'accept', content: { value: 'Other.' } } })).resolves.toEqual({ resultType: 'complete' });
        expect((await taskStore.get(auth, DEFAULT_WORKSPACE, task.taskId)).result).toEqual(done.result);
      });

      it('refuses an answer that does not fit and keeps asking', async () => {
        const definition = store(draftReviewSend('mcp-json', { mode: 'edit', prompt: 'Fix it.', review: { source: 'last-assistant', format: 'json' } }));
        const task = await create(definition);
        const asking = await statusOf(task.taskId, 'input_required');
        const key = Object.keys(asking.inputRequests!)[0];

        await expect(taskStore.update(auth, DEFAULT_WORKSPACE, task.taskId, { [key]: { action: 'accept', content: { value: '{not json' } } }))
          .rejects.toMatchObject({ code: 'TASK_INPUT_INVALID' });
        expect((await taskStore.get(auth, DEFAULT_WORKSPACE, task.taskId)).status).toBe('input_required');
      });

      it('follows an answer given in FLUJO instead, and a cancel stops the run without counting as an answer', async () => {
        const answeredInFlujo = await create(store(draftReviewSend('mcp-elsewhere', { mode: 'approval', prompt: 'Send?' }, 'Sent.')));
        const asking = await statusOf(answeredInFlujo.taskId, 'input_required');
        const requestId = Object.keys(asking.inputRequests!)[0].slice('human:'.length);
        const entry = (await getHumanTaskEntry(requestId))!;
        const view = parseHumanTaskCall((await saved(entry.conversationId)).pendingToolCalls![0])!;
        await answerHumanTask({ requestId, accept: true, answer: { digest: view.digest }, channel: 'api', fromThisComputer: true });
        await continueHumanTask(entry.conversationId, { requestId });
        expect((await statusOf(answeredInFlujo.taskId, 'completed')).result).toMatchObject({ content: [{ text: 'Sent.' }] });

        const cancelled = await create(store(draftReviewSend('mcp-cancel', { mode: 'approval', prompt: 'Send?' }, 'Sent.')));
        const waiting = await statusOf(cancelled.taskId, 'input_required');
        const cancelledRequest = Object.keys(waiting.inputRequests!)[0].slice('human:'.length);
        await taskStore.cancel(auth, DEFAULT_WORKSPACE, cancelled.taskId);
        const run = (await getHumanTaskEntry(cancelledRequest))!;
        expect(run.status).toBe('cancelled');
        const stopped = await saved(run.conversationId);
        expect(stopped.status).toBe('error');
        expect(lastText(stopped)).not.toContain('Sent.');
      });
    });
  });

  describe('routed by a connection drawn for an answer', () => {
    function routed(id: string): Flow {
      const flow = draftReviewSend(id, { mode: 'approval', prompt: 'Send?' }, 'Sent.');
      flow.nodes.push(node('rewrite', 'static', { outputTemplate: 'Rewrite it.' }), node('end2', 'finish'));
      flow.edges.push(
        edge('to-rewrite', 'review', 'rewrite', { sourceHandle: 'human-no' }) as never,
        edge('rewrite-end', 'rewrite', 'end2') as never,
      );
      return flow;
    }

    it('takes the "No" connection after a no instead of stopping, and the plain one after a yes', async () => {
      const no = await start('route-no', routed('route-no'));
      const noView = parseHumanTaskCall(no.pendingToolCalls![0])!;
      await answerHumanTask({ requestId: noView.requestId, accept: false, answer: {}, channel: 'chat', fromThisComputer: true });
      await continueHumanTask('route-no', { requestId: noView.requestId });
      expect(lastText(await saved('route-no')).at(-1)).toBe('Rewrite it.');

      const yes = await start('route-yes', routed('route-yes'));
      const yesView = parseHumanTaskCall(yes.pendingToolCalls![0])!;
      await answerHumanTask({ requestId: yesView.requestId, accept: true, answer: { digest: yesView.digest }, channel: 'chat', fromThisComputer: true });
      await continueHumanTask('route-yes', { requestId: yesView.requestId });
      expect(lastText(await saved('route-yes')).at(-1)).toBe('Sent.');
    });

    it('keeps the connection\'s answer through FlowSpec and back', () => {
      const spec = flowToSpec(routed('route-spec'));
      expect(spec.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: 'review', to: 'rewrite', humanOutcome: 'rejected' })]));
      const compiled = compileFlowSpec(spec).flow!;
      const idOf = (label: string) => compiled.nodes.find((candidate) => candidate.data?.label === label || candidate.id === label)?.id;
      const between = (from: string, to: string) => compiled.edges.find((candidate) => candidate.source === idOf(from) && candidate.target === idOf(to));
      expect(between('review', 'rewrite')).toMatchObject({ sourceHandle: 'human-no', data: { humanOutcome: 'rejected' } });
      expect(between('review', 'send')?.sourceHandle).toBe('human-bottom');
      expect(flowToSpec(compiled).edges.filter((candidate) => candidate.humanOutcome === 'rejected')).toHaveLength(1);
    });
  });

  describe('for a Persona', () => {
    const post = (requestId: string, body: unknown) => answerRoute(new Request(`http://localhost/api/human-tasks/${requestId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) as never, { params: Promise.resolve({ requestId }) } as never);

    async function personaWait(conversationId: string) {
      const result = await start(conversationId, draftReviewSend(conversationId, { mode: 'approval', prompt: 'Send?' }));
      const state = FlowExecutor.conversationStates.get(conversationId)!;
      state.personaAttribution = { personaId: 'persona-1', activityId: 'activity-1', behaviorRevisionId: 'rev-1' } as SharedState['personaAttribution'];
      await saveItem(`conversations/${conversationId}` as StorageKey, state);
      return parseHumanTaskCall(result.pendingToolCalls![0])!;
    }

    it('answers through the Persona dispatcher with fresh authority, from this computer only', async () => {
      const view = await personaWait('persona-step');
      resumeMock.mockImplementation(async (input: { conversationId: string; prepare: (context: unknown) => Promise<unknown> }) => {
        const authority = { signal: new AbortController().signal, assertCurrent: async () => undefined };
        await input.prepare({
          executionAuthority: authority,
          installExecutionAuthority: (state: SharedState) => Object.defineProperty(state, 'executionAuthority', {
            value: authority, enumerable: false, configurable: true, writable: true,
          }),
        });
        return { id: 'dispatch-1', state: 'running' };
      });

      fromOtherComputer.value = true;
      expect((await post(view.requestId, { action: 'approve', digest: view.digest })).status).toBe(403);
      expect(resumeMock).not.toHaveBeenCalled();

      fromOtherComputer.value = false;
      expect((await post(view.requestId, { action: 'approve', digest: 'sha256:stale' })).status).toBe(409);
      expect(resumeMock).not.toHaveBeenCalled();

      const response = await post(view.requestId, { action: 'approve', digest: view.digest });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ receipt: { requestId: view.requestId, outcome: 'approved' } });
      expect(resumeMock).toHaveBeenCalledTimes(1);
      expect(resumeMock.mock.calls[0][0]).toMatchObject({ personaId: 'persona-1', activityId: 'activity-1', conversationId: 'persona-step', reason: 'approval' });
      const state = await saved('persona-step');
      expect(state.humanTask?.decision).toMatchObject({ outcome: 'approved', channel: 'api' });
      expect(state.pendingToolCalls ?? []).toHaveLength(0);
    });
  });

  describe('as an MCP form', () => {
    it('maps typed questions onto flat form fields and answers back', () => {
      const form = humanElicitationForm({
        mode: 'input', title: 'Order', prompt: 'How many?', fields: [
          { name: 'count', type: 'integer', required: true, min: 1, max: 9 },
          { name: 'size', label: 'Size', type: 'choice', options: ['S', 'M'] },
          { name: 'extras', type: 'multiChoice', options: ['bag', 'card'] },
        ],
      });
      expect(form.requestedSchema).toEqual({
        type: 'object',
        properties: {
          count: { type: 'integer', title: 'count', minimum: 1, maximum: 9 },
          size: { type: 'string', title: 'Size', enum: ['S', 'M'] },
          extras: { type: 'array', title: 'extras', items: { type: 'string', enum: ['bag', 'card'] } },
        },
        required: ['count'],
      });
      expect(humanAnswerFromForm({ mode: 'input' }, { action: 'accept', content: { count: 2 } })).toEqual({ accept: true, value: { count: 2 } });
      expect(humanAnswerFromForm({ mode: 'approval' }, { action: 'accept', content: { approved: false } })).toEqual({ accept: false });
      expect(humanAnswerFromForm({ mode: 'edit' }, { action: 'cancel' })).toEqual({ accept: false });
      expect(humanInputKey('abc')).toBe('human:abc');
    });
  });
});
