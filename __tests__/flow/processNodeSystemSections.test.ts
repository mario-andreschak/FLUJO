/**
 * FLUJO's system sections in a real Process step (issue #1231): the step's
 * real tools pick the sections, the author's switches remove them, and the
 * rendering slot never reaches the model.
 */
import { FinishNode, ProcessNode } from '@/backend/execution/flow/nodes';
import { modelService } from '@/backend/services/model';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import type { ProcessNodeParams, ProcessNodeProperties, SharedState } from '@/backend/execution/flow/types';
import type { Flow } from '@/shared/types/flow';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { FLUJO_SYSTEM_PROMPT_HEADING } from '@/shared/utils/flujoSystemPrompt';

const model = { id: 'sections-model', name: 'Model', adapter: 'claude-cli', provider: 'claude-subscription', ApiKey: '' } as const;
const AUTHOR_PROMPT = 'Summarise the ticket in one line.';

beforeEach(async () => {
  await saveItem(StorageKey.MODELS, [model]);
  jest.spyOn(modelService, 'getModel').mockResolvedValue(model as Awaited<ReturnType<typeof modelService.getModel>>);
  jest.spyOn(ModelHandler, 'isClaudeSessionResumeEnabled').mockResolvedValue(false);
});

afterEach(() => jest.restoreAllMocks());

function flowWith(properties: Partial<ProcessNodeProperties>): Flow {
  return {
    id: 'sections-flow',
    name: 'Sections',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'start', properties: { promptTemplate: '' } } },
      {
        id: 'step', type: 'process', position: { x: 0, y: 0 },
        data: { label: 'Step', type: 'process', properties: { boundModel: model.id, promptTemplate: AUTHOR_PROMPT, ...properties } },
      },
      { id: 'finish', type: 'finish', position: { x: 0, y: 0 }, data: { label: 'Finish', type: 'finish', properties: {} } },
    ],
    edges: [{ id: 'e-start', source: 'start', target: 'step' }, { id: 'e-finish', source: 'step', target: 'finish' }],
  } as unknown as Flow;
}

async function systemPrompt(properties: Partial<ProcessNodeProperties>, extra: Partial<SharedState> = {}): Promise<string> {
  const flow = flowWith(properties);
  const state = {
    trackingInfo: { executionId: 'sections', startTime: 1, nodeExecutionTracker: [] },
    messages: [{ id: 'user', role: 'user', content: 'Ticket 42 is about a login bug', timestamp: 1 }],
    flowId: flow.id, conversationId: 'sections-conversation', ephemeral: true,
    flowSnapshot: flow, title: 'Sections', createdAt: 1, updatedAt: 1,
    ...extra,
  } as SharedState;
  const params: ProcessNodeParams = {
    id: 'step', label: 'Step', type: 'process',
    properties: { boundModel: model.id, promptTemplate: AUTHOR_PROMPT, ...properties },
  };
  const step = new ProcessNode();
  step.setParams({}, params);
  const finish = new FinishNode();
  finish.setParams({}, { id: 'finish', label: 'Finish', type: 'finish', properties: {} });
  step.addSuccessor(finish, 'e-finish');
  const prep = await step.prep(state, params);
  const system = prep.messages.find((message) => message.role === 'system')?.content;
  expect(system).toBe(prep.currentPrompt);
  expect(prep.currentPrompt).not.toContain('\u0000');
  return prep.currentPrompt;
}

it('describes only what a single step can do, before the author\'s own prompt', async () => {
  const prompt = await systemPrompt({});
  expect(prompt.indexOf(FLUJO_SYSTEM_PROMPT_HEADING)).toBeLessThan(prompt.indexOf(AUTHOR_PROMPT));
  expect(prompt).toContain('A Finish handoff alone is not an answer.');
  expect(prompt).toContain(AUTHOR_PROMPT);
  expect(prompt).not.toContain('workflow with other agents');
  expect(prompt).not.toContain('## Other agents');
  expect(prompt).not.toContain('## People');
  expect(prompt).not.toContain('## FLUJO tools');
});

it('tells a sub-agent about its parent and the message tools it really has', async () => {
  const prompt = await systemPrompt({}, { parentRunId: 'parent-run', parentConversationId: 'parent-conversation' });
  expect(prompt).toContain('## Other agents');
  expect(prompt).toContain('`subflow_send_message` sends one a message');
  expect(prompt).toContain('Another agent started you and receives your final answer.');
});

it('mentions the question tool only when the step offers it', async () => {
  expect(await systemPrompt({ allowQuestion: true })).toContain('ask with `question`');
  expect(await systemPrompt({})).not.toContain('`question`');
});

it('leaves out a section the author switched off', async () => {
  const prompt = await systemPrompt({ allowQuestion: true, excludeSystemPromptSections: ['workflow', 'people'] });
  expect(prompt).toContain(FLUJO_SYSTEM_PROMPT_HEADING);
  expect(prompt).not.toContain('## Workflow');
  expect(prompt).not.toContain('## People');
  expect(prompt).toContain(AUTHOR_PROMPT);
});

it('adds nothing of FLUJO\'s when the whole system prompt is excluded', async () => {
  const prompt = await systemPrompt({ allowQuestion: true, excludeSystemPrompt: true });
  expect(prompt).not.toContain(FLUJO_SYSTEM_PROMPT_HEADING);
  expect(prompt).not.toContain('## ');
  expect(prompt).toContain(AUTHOR_PROMPT);
});
